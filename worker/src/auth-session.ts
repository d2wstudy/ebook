import { GitHubRequestError, githubOAuthRequest, githubRestRequest } from './github'
import type { WorkerEnv } from './types'

const SESSION_VERSION = 1
const SESSION_AAD = 'github-reader-auth-session-v1'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface GitHubUserTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_token_expires_in?: number
  token_type?: string
  error?: string
  error_description?: string
}

interface AuthSessionPayload {
  version: 1
  accessToken: string
  refreshToken: string | null
  accessExpiresAt: number | null
  refreshExpiresAt: number | null
  clientId: string
  repositoryId: string
}

export interface PublicAuthSession {
  access_token: string
  expires_at: number | null
  refresh_expires_at: number | null
  session: string
}

export class AuthSessionError extends GitHubRequestError {
  constructor(
    message: string,
    public reason: 'invalid_session' | 'refresh_rejected',
  ) {
    super(message, 401)
    this.name = 'AuthSessionError'
  }
}

export function authCredentials(env: WorkerEnv): { id: string; secret: string } | null {
  if (!env.GITHUB_AUTH_APP_CLIENT_ID || !env.GITHUB_AUTH_APP_CLIENT_SECRET) return null
  return {
    id: env.GITHUB_AUTH_APP_CLIENT_ID,
    secret: env.GITHUB_AUTH_APP_CLIENT_SECRET,
  }
}

export async function exchangeAuthorizationCode(
  env: WorkerEnv,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<PublicAuthSession> {
  const credentials = requireAuthCredentials(env)
  const response = await githubOAuthRequest(env, credentials.id, oauthRequestBody({
    client_id: credentials.id,
    client_secret: credentials.secret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    repository_id: env.GITHUB_REPOSITORY_ID!,
  }))
  const data = await safeJson<GitHubUserTokenResponse>(response)
  if (!response.ok || data.error || !data.access_token) {
    throw new GitHubRequestError(
      data.error_description || data.error || 'GitHub authorization failed',
      response.ok ? 400 : response.status,
    )
  }
  return sealTokenResponse(env, credentials.id, data)
}

export async function restoreAuthSession(
  env: WorkerEnv,
  opaqueSession: string,
  forceRefresh: boolean,
): Promise<PublicAuthSession> {
  const payload = await unsealSession(env, opaqueSession)
  const credentials = requireAuthCredentials(env)
  if (
    payload.clientId !== credentials.id
    || payload.repositoryId !== env.GITHUB_REPOSITORY_ID
  ) {
    throw new AuthSessionError(
      'Authentication session is not valid for this deployment',
      'invalid_session',
    )
  }

  const shouldRefresh = !!payload.refreshToken && (
    forceRefresh
    || (payload.accessExpiresAt !== null && payload.accessExpiresAt <= Date.now() + 5 * 60 * 1000)
  )
  if (!shouldRefresh || !payload.refreshToken) {
    return {
      access_token: payload.accessToken,
      expires_at: payload.accessExpiresAt,
      refresh_expires_at: payload.refreshExpiresAt,
      session: opaqueSession,
    }
  }
  if (payload.refreshExpiresAt !== null && payload.refreshExpiresAt <= Date.now()) {
    throw new AuthSessionError('GitHub refresh token expired', 'refresh_rejected')
  }

  const response = await githubOAuthRequest(env, credentials.id, oauthRequestBody({
    client_id: credentials.id,
    client_secret: credentials.secret,
    grant_type: 'refresh_token',
    refresh_token: payload.refreshToken,
  }))
  const data = await safeJson<GitHubUserTokenResponse>(response)
  if (!response.ok || data.error || !data.access_token) {
    if (response.status === 429) {
      throw new GitHubRequestError('GitHub session refresh rate limit exceeded', 429)
    }
    throw new AuthSessionError(
      data.error_description || data.error || 'GitHub session refresh failed',
      'refresh_rejected',
    )
  }
  return sealTokenResponse(env, credentials.id, data)
}

export async function revokeAuthSession(env: WorkerEnv, opaqueSession: string): Promise<void> {
  let payload = await unsealSession(env, opaqueSession)
  const credentials = requireAuthCredentials(env)
  if (payload.clientId !== credentials.id) {
    throw new AuthSessionError(
      'Authentication session is not valid for this deployment',
      'invalid_session',
    )
  }

  if (
    payload.refreshToken
    && payload.accessExpiresAt !== null
    && payload.accessExpiresAt <= Date.now() + 60_000
  ) {
    const refreshed = await restoreAuthSession(env, opaqueSession, true)
    payload = await unsealSession(env, refreshed.session)
  }

  const response = await githubRestRequest(
    env,
    payload.accessToken,
    `https://api.github.com/applications/${credentials.id}/grant`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${btoa(`${credentials.id}:${credentials.secret}`)}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'github-reader-worker',
      },
      body: JSON.stringify({ access_token: payload.accessToken }),
    },
  )
  if (![204, 404].includes(response.status)) {
    throw new GitHubRequestError('Unable to revoke GitHub authorization', response.status)
  }
}

async function sealTokenResponse(
  env: WorkerEnv,
  clientId: string,
  data: GitHubUserTokenResponse,
): Promise<PublicAuthSession> {
  if (!data.access_token) throw new GitHubRequestError('Missing GitHub access token', 502)
  const now = Date.now()
  const payload: AuthSessionPayload = {
    version: SESSION_VERSION,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    accessExpiresAt: positiveSeconds(data.expires_in) === null
      ? null
      : now + positiveSeconds(data.expires_in)! * 1000,
    refreshExpiresAt: positiveSeconds(data.refresh_token_expires_in) === null
      ? null
      : now + positiveSeconds(data.refresh_token_expires_in)! * 1000,
    clientId,
    repositoryId: env.GITHUB_REPOSITORY_ID!,
  }
  return publicSession(env, payload)
}

async function publicSession(env: WorkerEnv, payload: AuthSessionPayload): Promise<PublicAuthSession> {
  return {
    access_token: payload.accessToken,
    expires_at: payload.accessExpiresAt,
    refresh_expires_at: payload.refreshExpiresAt,
    session: await sealSession(env, payload),
  }
}

async function sealSession(env: WorkerEnv, payload: AuthSessionPayload): Promise<string> {
  const key = await sessionKey(env)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode(SESSION_AAD),
  }, key, encoder.encode(JSON.stringify(payload)))
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`
}

async function unsealSession(env: WorkerEnv, value: string): Promise<AuthSessionPayload> {
  const [version, rawIv, rawCiphertext, extra] = value.split('.')
  if (version !== 'v1' || !rawIv || !rawCiphertext || extra) {
    throw new AuthSessionError('Invalid authentication session', 'invalid_session')
  }
  const key = await sessionKey(env)
  try {
    const iv = fromBase64Url(rawIv)
    const ciphertext = fromBase64Url(rawCiphertext)
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: iv.buffer,
      additionalData: encoder.encode(SESSION_AAD),
    }, key, ciphertext.buffer)
    const payload = JSON.parse(decoder.decode(plaintext)) as Partial<AuthSessionPayload>
    if (
      payload.version !== SESSION_VERSION
      || typeof payload.accessToken !== 'string'
      || !payload.accessToken
      || (payload.refreshToken !== null && typeof payload.refreshToken !== 'string')
      || (payload.accessExpiresAt !== null && typeof payload.accessExpiresAt !== 'number')
      || (payload.refreshExpiresAt !== null && typeof payload.refreshExpiresAt !== 'number')
      || typeof payload.clientId !== 'string'
      || typeof payload.repositoryId !== 'string'
    ) {
      throw new Error('Invalid session payload')
    }
    return payload as AuthSessionPayload
  } catch {
    throw new AuthSessionError('Invalid or expired authentication session', 'invalid_session')
  }
}

async function sessionKey(env: WorkerEnv): Promise<CryptoKey> {
  if (!env.AUTH_SESSION_SECRET || env.AUTH_SESSION_SECRET.length < 32) {
    throw new GitHubRequestError('Authentication session secret is not configured', 503)
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(env.AUTH_SESSION_SECRET))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

function requireAuthCredentials(env: WorkerEnv): { id: string; secret: string } {
  const credentials = authCredentials(env)
  if (!credentials) throw new GitHubRequestError('GitHub Auth App is not configured', 503)
  if (!env.GITHUB_REPOSITORY_ID) {
    throw new GitHubRequestError('GitHub repository ID is not configured', 503)
  }
  return credentials
}

function oauthRequestBody(fields: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'github-reader-worker',
    },
    body: new URLSearchParams(fields),
  }
}

function positiveSeconds(value: number | undefined): number | null {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : null
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    return {} as T
  }
}
