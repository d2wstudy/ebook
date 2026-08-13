import { allowedOrigins, cacheObjectName, getWorkerConfig, validateDiscussionParams } from './config'
import {
  AuthSessionError,
  exchangeAuthorizationCode,
  restoreAuthSession,
  revokeAuthSession,
} from './auth-session'
import { GitHubRequestError } from './github'
import type { WorkerEnv } from './types'

export { DiscussionCache } from './discussion-cache'
export { RateLimitCoordinator } from './rate-limit'
export { getWorkerConfig, validateDiscussionParams } from './config'

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    const webhook = url.pathname === '/api/github/webhook' && request.method === 'POST'
    const corsHeaders = webhook ? {} : buildCorsHeaders(request, env)

    if (!webhook && !isAllowedOrigin(request, env)) {
      return json({ error: 'Origin not allowed' }, 403, corsHeaders)
    }
    if (!webhook && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    try {
      if (url.pathname === '/api/discussions' && request.method === 'GET') {
        return await handleDiscussions(url, env, corsHeaders)
      }
      if (url.pathname === '/api/cache/invalidate' && request.method === 'POST') {
        return await handleCacheInvalidate(request, env, corsHeaders)
      }
      if (url.pathname === '/api/github/webhook' && request.method === 'POST') {
        return await handleGitHubWebhook(request, env)
      }
      if (url.pathname === '/api/auth/exchange' && request.method === 'POST') {
        return await handleAuthExchange(request, env, corsHeaders)
      }
      if (url.pathname === '/api/auth/session' && request.method === 'POST') {
        return await handleAuthSession(request, env, corsHeaders)
      }
      if (url.pathname === '/api/auth/revoke' && request.method === 'POST') {
        return await handleAuthRevoke(request, env, corsHeaders)
      }
      return json({ error: 'Not found' }, 404, corsHeaders)
    } catch (error) {
      const status = error instanceof GitHubRequestError ? error.status : 502
      const retryAfter = error instanceof GitHubRequestError && error.blockedUntil > Date.now()
        ? Math.max(1, Math.ceil((error.blockedUntil - Date.now()) / 1000))
        : null
      console.error(JSON.stringify({
        level: 'error',
        message: 'worker request failed',
        path: url.pathname,
        status,
        error: error instanceof Error ? error.message : String(error),
      }))
      return json({
        error: publicErrorMessage(status),
        ...(error instanceof AuthSessionError ? { reason: error.reason } : {}),
      }, status, {
        ...corsHeaders,
        ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
        ...(url.pathname.startsWith('/api/auth/') ? { 'Cache-Control': 'no-store' } : {}),
      })
    }
  },
} satisfies ExportedHandler<WorkerEnv>

async function handleDiscussions(
  url: URL,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const params = validateDiscussionParams(url, getWorkerConfig(env))
  if ('error' in params) return json({ error: params.error }, params.status, corsHeaders)

  const stub = env.DISCUSSION_CACHE.getByName(cacheObjectName(params.pagePath, params.categoryName))
  const response = await stub.read({
    pagePath: params.pagePath,
    categoryName: params.categoryName,
    knownId: params.knownId,
  })
  if (!response.ok) {
    throw new GitHubRequestError(
      response.error.message,
      response.error.status,
      response.error.blockedUntil,
    )
  }
  return json(response.response.result, 200, {
    ...corsHeaders,
    'Cache-Control': 'public, max-age=0, must-revalidate',
    'X-Cache': response.response.cacheStatus,
    Age: String(response.response.ageSeconds),
  })
}

async function handleCacheInvalidate(
  request: Request,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const origin = request.headers.get('Origin')
  if (!origin || !allowedOrigins(env).has(origin)) {
    return json({ error: 'Origin not allowed' }, 403, corsHeaders)
  }
  const coordinator = env.GITHUB_RATE_LIMIT.getByName(`cache-invalidate:${origin}`)
  const budget = positiveInteger(env.CACHE_INVALIDATE_BUDGET, 120)
  const acquired = await coordinator.consumeRollingWindow('cache-invalidate', 1, budget, 60 * 60 * 1000)
  if (!acquired.allowed) {
    throw new GitHubRequestError('Cache invalidation rate limit exceeded', 429, acquired.retryAt)
  }

  const body = await readJsonBody(request, 4_096)
  const documentId = stringField(body, 'documentId')
  const categoryName = stringField(body, 'categoryName')
  const dropCache = body.dropCache === true
  const params = validatedMutationIdentity(documentId, categoryName, env)
  if (!params) return json({ error: 'Invalid cache identity' }, 400, corsHeaders)

  await invalidateCache(env, params.pagePath, params.categoryName, dropCache)
  return json({ ok: true }, 202, { ...corsHeaders, 'Cache-Control': 'no-store' })
}

async function handleGitHubWebhook(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return json({ error: 'Webhook is not configured' }, 503)
  const body = await readBodyBytes(request, 1_000_000)
  const signature = request.headers.get('X-Hub-Signature-256') || ''
  if (!await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET)) {
    return json({ error: 'Invalid webhook signature' }, 401)
  }

  const event = request.headers.get('X-GitHub-Event') || ''
  if (!['discussion', 'discussion_comment'].includes(event)) return json({ ok: true, ignored: true })
  const payload = parseJsonBytes(body)
  const repository = recordField(payload, 'repository')
  if (stringField(repository, 'full_name').toLowerCase() !== `${env.REPO_OWNER}/${env.REPO_NAME}`.toLowerCase()) {
    return json({ ok: true, ignored: true })
  }

  const discussion = recordField(payload, 'discussion')
  const title = stringField(discussion, 'title')
  const categoryName = stringField(recordField(discussion, 'category'), 'name')
  const params = validatedMutationIdentity(title, categoryName, env)
  if (!params) return json({ ok: true, ignored: true })

  await invalidateCache(env, params.pagePath, params.categoryName, false)
  return json({ ok: true }, 202)
}

async function handleAuthExchange(
  request: Request,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const body = await readJsonBody(request, 8_192)
  const code = stringField(body, 'code')
  const codeVerifier = stringField(body, 'code_verifier')
  const redirectUri = stringField(body, 'redirect_uri')
  if (!code || code.length > 500 || !validPkceVerifier(codeVerifier) || !isAllowedRedirectUri(redirectUri, env)) {
    return json({ error: 'Invalid OAuth parameters' }, 400, noStore(corsHeaders))
  }
  const session = await exchangeAuthorizationCode(env, code, codeVerifier, redirectUri)
  return json(session, 200, noStore(corsHeaders))
}

async function handleAuthSession(
  request: Request,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const body = await readJsonBody(request, 24_000)
  const opaqueSession = stringField(body, 'session')
  if (!opaqueSession || opaqueSession.length > 20_000) {
    return json({ error: 'Invalid authentication session' }, 400, noStore(corsHeaders))
  }
  const session = await restoreAuthSession(env, opaqueSession, body.force === true)
  return json(session, 200, noStore(corsHeaders))
}

async function handleAuthRevoke(
  request: Request,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const body = await readJsonBody(request, 24_000)
  const opaqueSession = stringField(body, 'session')
  if (!opaqueSession || opaqueSession.length > 20_000) {
    return json({ error: 'Invalid authentication session' }, 400, noStore(corsHeaders))
  }
  await revokeAuthSession(env, opaqueSession)
  return json({ ok: true }, 200, noStore(corsHeaders))
}

function validatedMutationIdentity(documentId: string, categoryName: string, env: WorkerEnv) {
  if (!documentId || !categoryName) return null
  const url = new URL('https://worker.invalid/api/discussions')
  url.searchParams.set('path', documentId)
  url.searchParams.set('category', categoryName)
  const params = validateDiscussionParams(url, getWorkerConfig(env))
  return 'error' in params ? null : params
}

async function invalidateCache(
  env: WorkerEnv,
  documentId: string,
  categoryName: string,
  drop: boolean,
): Promise<void> {
  const stub = env.DISCUSSION_CACHE.getByName(cacheObjectName(documentId, categoryName))
  await stub.invalidate({ drop })
}

async function verifyWebhookSignature(
  body: Uint8Array<ArrayBuffer>,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature.startsWith('sha256=')) return false
  const provided = decodeHex(signature.slice(7))
  if (!provided) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify('HMAC', key, provided.buffer, body.buffer)
}

function decodeHex(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

function validPkceVerifier(value: string): boolean {
  return value.length >= 43 && value.length <= 128 && /^[A-Za-z0-9._~-]+$/.test(value)
}

function isAllowedRedirectUri(value: string, env: WorkerEnv): boolean {
  try {
    const url = new URL(value)
    return allowedOrigins(env).has(url.origin)
      && url.pathname === getWorkerConfig(env).documentPathPrefix
      && !url.search
      && !url.hash
  } catch {
    return false
  }
}

function isAllowedOrigin(request: Request, env: WorkerEnv): boolean {
  const origin = request.headers.get('Origin')
  return !origin || allowedOrigins(env).has(origin)
}

function buildCorsHeaders(request: Request, env: WorkerEnv): Record<string, string> {
  const origin = request.headers.get('Origin')
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
  if (origin && allowedOrigins(env).has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

async function readJsonBody(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  return parseJsonBytes(await readBodyBytes(request, maxBytes))
}

async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = Number(request.headers.get('Content-Length') || 0)
  if (contentLength > maxBytes) throw new GitHubRequestError('Request body too large', 413)
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > maxBytes) throw new GitHubRequestError('Request body too large', 413)
  return new Uint8Array(buffer)
}

function parseJsonBytes(bytes: Uint8Array<ArrayBuffer>): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === 'string' ? body[key] : ''
}

function recordField(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function noStore(headers: HeadersInit): HeadersInit {
  return { ...headers, 'Cache-Control': 'no-store' }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers })
}

function publicErrorMessage(status: number): string {
  if (status === 400) return 'Invalid request'
  if (status === 401) return 'GitHub authentication failed'
  if (status === 403) return 'Request forbidden'
  if (status === 413) return 'Request body too large'
  if (status === 429) return 'GitHub rate limit exceeded'
  if (status === 503) return 'GitHub service credentials are not configured'
  return 'GitHub Discussions service is temporarily unavailable'
}
