import { GitHubRequestError } from './github'
import type { WorkerEnv } from './types'

const encoder = new TextEncoder()
const installationTokens = new Map<string, { token: string; expiresAt: number }>()

export async function publicReadToken(env: WorkerEnv): Promise<string | null> {
  if (
    env.GITHUB_READ_APP_ID
    && env.GITHUB_READ_APP_PRIVATE_KEY
    && env.GITHUB_READ_APP_INSTALLATION_ID
    && env.GITHUB_REPOSITORY_ID
  ) {
    if (!/^\d+$/.test(env.GITHUB_REPOSITORY_ID)) {
      throw new GitHubRequestError('GitHub repository ID is invalid', 503)
    }
    return installationToken(env)
  }
  return env.GITHUB_PAT || null
}

async function installationToken(env: WorkerEnv): Promise<string> {
  const cacheKey = `${env.GITHUB_READ_APP_ID}:${env.GITHUB_READ_APP_INSTALLATION_ID}:${env.GITHUB_REPOSITORY_ID}`
  const cached = installationTokens.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached.token

  const jwt = await appJwt(env.GITHUB_READ_APP_ID!, env.GITHUB_READ_APP_PRIVATE_KEY!)
  let response: Response
  try {
    response = await fetch(
      `https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_READ_APP_INSTALLATION_ID!)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'User-Agent': 'github-reader-worker',
        },
        body: JSON.stringify({
          repository_ids: [Number(env.GITHUB_REPOSITORY_ID)],
          permissions: { discussions: 'read' },
        }),
      },
    )
  } catch {
    throw new GitHubRequestError('Unable to connect to GitHub App API', 502)
  }
  const data = await safeJson<{ token?: string; expires_at?: string; message?: string }>(response)
  if (!response.ok || !data.token) {
    throw new GitHubRequestError(data.message || 'Unable to create installation token', response.status)
  }
  const expiresAt = Date.parse(data.expires_at || '')
  installationTokens.set(cacheKey, {
    token: data.token,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 55 * 60 * 1000,
  })
  return data.token
}

async function appJwt(appId: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const payload = base64Url(encoder.encode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  })))
  const signingInput = `${header}.${payload}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importPrivateKey(privateKey),
    encoder.encode(signingInput),
  )
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

async function importPrivateKey(value: string): Promise<CryptoKey> {
  const normalized = value.replaceAll('\\n', '\n')
  const pkcs1 = normalized.includes('BEGIN RSA PRIVATE KEY')
  const contents = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const binary = atob(contents)
  let der = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) der[index] = binary.charCodeAt(index)
  if (pkcs1) der = wrapPkcs1AsPkcs8(der)
  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = Uint8Array.of(0x02, 0x01, 0x00)
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  )
  const privateKey = derValue(0x04, pkcs1)
  return derValue(0x30, concatBytes(version, rsaAlgorithmIdentifier, privateKey))
}

function derValue(tag: number, value: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(Uint8Array.of(tag), derLength(value.length), value)
}

function derLength(length: number): Uint8Array<ArrayBuffer> {
  if (length < 0x80) return Uint8Array.of(length)
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>>= 8
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function concatBytes(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0))
  let offset = 0
  for (const value of values) {
    result.set(value, offset)
    offset += value.length
  }
  return result
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    return {} as T
  }
}
