import { allowedOrigins, cacheObjectName, getWorkerConfig, validateDiscussionParams } from './config'
import {
  GitHubRequestError,
  githubGraphQl,
  githubOAuthRequest,
  githubRestJson,
  githubRestRequest,
} from './github'
import { isAllowedGraphQlOperation } from './graphql-allowlist'
import type { WorkerEnv } from './types'

export { DiscussionCache } from './discussion-cache'
export { RateLimitCoordinator } from './rate-limit'
export { getWorkerConfig, validateDiscussionParams } from './config'
export { isAllowedGraphQlOperation } from './graphql-allowlist'

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const corsHeaders = buildCorsHeaders(request, env)
    if (!isAllowedOrigin(request, env)) {
      return json({ error: 'Origin not allowed' }, 403, corsHeaders)
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    const url = new URL(request.url)
    try {
      if (url.pathname === '/api/discussions' && request.method === 'GET') {
        return await handleDiscussions(request, url, env, corsHeaders)
      }
      if (url.pathname === '/api/github/graphql' && request.method === 'POST') {
        return await handleGraphQl(request, env, corsHeaders)
      }
      if (url.pathname === '/api/github/user' && request.method === 'GET') {
        return await handleGitHubUser(request, env, corsHeaders)
      }
      if (url.pathname === '/api/auth' && request.method === 'POST') {
        return await handleAuth(request, env, corsHeaders)
      }
      if (url.pathname === '/api/revoke' && request.method === 'POST') {
        return await handleRevoke(request, env, corsHeaders)
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
      return json({ error: publicErrorMessage(status) }, status, {
        ...corsHeaders,
        ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}),
      })
    }
  },
} satisfies ExportedHandler<WorkerEnv>

async function handleDiscussions(
  request: Request,
  url: URL,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const config = getWorkerConfig(env)
  const params = validateDiscussionParams(url, config)
  if ('error' in params) return json({ error: params.error }, params.status, corsHeaders)

  const userToken = bearerToken(request)
  const stub = env.DISCUSSION_CACHE.getByName(cacheObjectName(params.pagePath, params.categoryName))
  const response = await stub.read({
    pagePath: params.pagePath,
    categoryName: params.categoryName,
    knownId: params.knownId,
    userToken,
    force: url.searchParams.get('force') === '1',
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
    'Cache-Control': 'private, no-store',
    'X-Cache': response.response.cacheStatus,
    Age: String(response.response.ageSeconds),
  })
}

async function handleGraphQl(
  request: Request,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const token = bearerToken(request)
  if (!token) return json({ error: 'Unauthorized' }, 401, corsHeaders)
  const body = await readJsonBody(request)
  const query = stringField(body, 'query')
  const variables = recordField(body, 'variables')
  const cacheContext = recordField(body, 'cache')
  if (!query || query.length > 20_000 || !/^(query|mutation)\b/.test(query.trimStart())) {
    return json({ error: 'Invalid GraphQL request' }, 400, corsHeaders)
  }
  if (!isAllowedGraphQlOperation(query)) {
    return json({ error: 'Unsupported GraphQL operation' }, 400, corsHeaders)
  }
  if (query.trimStart().startsWith('mutation') && !isValidMutationContext(cacheContext, env)) {
    return json({ error: 'Invalid mutation context' }, 400, corsHeaders)
  }
  const data = await githubGraphQl(env, token, query, variables)
  if (query.trimStart().startsWith('mutation')) {
    await invalidateMutationCacheSafely(env, token, cacheContext)
  }
  return json({ data }, 200, { ...corsHeaders, 'Cache-Control': 'no-store' })
}

export async function invalidateMutationCacheSafely(
  env: Pick<WorkerEnv,
    | 'DISCUSSION_CACHE'
    | 'DOCUMENT_PATH_PREFIX'
    | 'DISCUSSION_CATEGORIES'
    | 'REPO_OWNER'
    | 'REPO_NAME'
    | 'CACHE_FRESH_TTL'
    | 'CACHE_STALE_TTL'
    | 'RATE_LIMIT_RESERVE'
    | 'GRAPHQL_SECONDARY_BUDGET'
    | 'REST_SECONDARY_BUDGET'
    | 'OAUTH_SECONDARY_BUDGET'
    | 'CONTENT_MINUTE_BUDGET'
    | 'CONTENT_HOUR_BUDGET'
    | 'GITHUB_CONCURRENCY_LIMIT'
    | 'MUTATION_MIN_INTERVAL_MS'
  >,
  token: string,
  cacheContext: Record<string, unknown>,
): Promise<void> {
  try {
    await invalidateMutationCache(env, token, cacheContext)
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'mutation cache invalidation failed',
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

function isValidMutationContext(
  rawContext: Record<string, unknown>,
  env: WorkerEnv,
): boolean {
  const pagePath = stringField(rawContext, 'documentId')
  const categoryName = stringField(rawContext, 'categoryName')
  if (!pagePath || !categoryName) return false
  const url = new URL('https://worker.invalid/api/discussions')
  url.searchParams.set('path', pagePath)
  url.searchParams.set('category', categoryName)
  return !('error' in validateDiscussionParams(url, getWorkerConfig(env)))
}

async function invalidateMutationCache(
  env: Pick<WorkerEnv,
    | 'DISCUSSION_CACHE'
    | 'DOCUMENT_PATH_PREFIX'
    | 'DISCUSSION_CATEGORIES'
    | 'REPO_OWNER'
    | 'REPO_NAME'
    | 'CACHE_FRESH_TTL'
    | 'CACHE_STALE_TTL'
    | 'RATE_LIMIT_RESERVE'
    | 'GRAPHQL_SECONDARY_BUDGET'
    | 'REST_SECONDARY_BUDGET'
    | 'OAUTH_SECONDARY_BUDGET'
    | 'CONTENT_MINUTE_BUDGET'
    | 'CONTENT_HOUR_BUDGET'
    | 'GITHUB_CONCURRENCY_LIMIT'
    | 'MUTATION_MIN_INTERVAL_MS'
  >,
  token: string,
  rawContext: Record<string, unknown>,
): Promise<void> {
  const pagePath = stringField(rawContext, 'documentId')
  const categoryName = stringField(rawContext, 'categoryName')
  if (!pagePath || !categoryName) return
  const url = new URL('https://worker.invalid/api/discussions')
  url.searchParams.set('path', pagePath)
  url.searchParams.set('category', categoryName)
  const params = validateDiscussionParams(url, getWorkerConfig(env))
  if ('error' in params) return
  const stub = env.DISCUSSION_CACHE.getByName(cacheObjectName(pagePath, categoryName))
  await stub.invalidate({
    userToken: token,
    shared: true,
    drop: rawContext.dropCache === true,
  })
}

async function handleGitHubUser(
  request: Request,
  env: WorkerEnv,
  corsHeaders: HeadersInit,
): Promise<Response> {
  const token = bearerToken(request)
  if (!token) return json({ error: 'Unauthorized' }, 401, corsHeaders)
  const data = await githubRestJson(env, token, '/user')
  return json(data, 200, { ...corsHeaders, 'Cache-Control': 'private, max-age=300' })
}

async function handleAuth(request: Request, env: WorkerEnv, corsHeaders: HeadersInit): Promise<Response> {
  const body = await readJsonBody(request)
  const code = stringField(body, 'code')
  const clientId = stringField(body, 'client_id')
  const redirectUri = stringField(body, 'redirect_uri')
  if (!code || !clientId || !redirectUri) {
    return json({ error: 'Missing OAuth parameters' }, 400, corsHeaders)
  }
  const credentials = selectOAuthCredentials(env, clientId)
  if (!credentials) return json({ error: 'Unknown OAuth client' }, 400, corsHeaders)
  if (!isAllowedRedirectUri(redirectUri, env)) {
    return json({ error: 'Invalid redirect_uri' }, 400, corsHeaders)
  }

  const response = await githubOAuthRequest(env, credentials.id, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'github-reader-worker',
    },
    body: JSON.stringify({
      client_id: credentials.id,
      client_secret: credentials.secret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  const data = await safeResponseJson(response)
  const status = response.ok && !('error' in data) ? 200 : 400
  return json(data, status, { ...corsHeaders, 'Cache-Control': 'no-store' })
}

async function handleRevoke(request: Request, env: WorkerEnv, corsHeaders: HeadersInit): Promise<Response> {
  const body = await readJsonBody(request)
  const accessToken = stringField(body, 'access_token')
  const clientId = stringField(body, 'client_id')
  if (!accessToken || !clientId) {
    return json({ error: 'Missing revoke parameters' }, 400, corsHeaders)
  }
  const credentials = selectOAuthCredentials(env, clientId)
  if (!credentials) return json({ error: 'Unknown OAuth client' }, 400, corsHeaders)

  const response = await githubRestRequest(
    env,
    accessToken,
    `https://api.github.com/applications/${credentials.id}/grant`,
    {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${btoa(`${credentials.id}:${credentials.secret}`)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'github-reader-worker',
    },
    body: JSON.stringify({ access_token: accessToken }),
    },
  )
  if ([204, 404, 422].includes(response.status)) {
    return json({ ok: true }, 200, { ...corsHeaders, 'Cache-Control': 'no-store' })
  }
  return json({ ok: false, status: response.status }, response.status, corsHeaders)
}

function bearerToken(request: Request): string | null {
  const authHeader = request.headers.get('Authorization')
  return authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
}

function selectOAuthCredentials(env: WorkerEnv, clientId: string): { id: string; secret: string } | null {
  if (clientId === env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET }
  }
  if (clientId === env.GITHUB_CLIENT_ID_DEV && env.GITHUB_CLIENT_SECRET_DEV) {
    return { id: env.GITHUB_CLIENT_ID_DEV, secret: env.GITHUB_CLIENT_SECRET_DEV }
  }
  return null
}

function isAllowedRedirectUri(value: string, env: WorkerEnv): boolean {
  try {
    return allowedOrigins(env).has(new URL(value).origin)
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  }
  if (origin && allowedOrigins(env).has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    return await request.json() as Record<string, unknown>
  } catch {
    return {}
  }
}

async function safeResponseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>
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

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, { status, headers })
}

function publicErrorMessage(status: number): string {
  if (status === 401) return 'GitHub authentication failed'
  if (status === 403) return 'Request forbidden'
  if (status === 429) return 'GitHub rate limit exceeded'
  return 'GitHub Discussions service is temporarily unavailable'
}
