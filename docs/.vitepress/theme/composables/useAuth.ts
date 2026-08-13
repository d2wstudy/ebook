import { computed, readonly, ref } from 'vue'
import { readerConfig } from '../readerConfig'

const GITHUB_CLIENT_ID = readerConfig.github.oauthClientId || ''
const WORKER_URL = readerConfig.github.workerUrl
const STORAGE_PREFIX = `github-reader::${readerConfig.projectId}::auth`
const SESSION_KEY = `${STORAGE_PREFIX}::session`
const USER_KEY = `${STORAGE_PREFIX}::user`
const OAUTH_STATE_KEY = `${STORAGE_PREFIX}::oauth-state`
const OAUTH_VERIFIER_KEY = `${STORAGE_PREFIX}::oauth-verifier`
const OAUTH_RETURN_KEY = `${STORAGE_PREFIX}::oauth-return`
const REFRESH_LOCK_NAME = `${STORAGE_PREFIX}::refresh-lock`
const LEGACY_KEYS = [
  `${STORAGE_PREFIX}::token`,
  'gh-token',
  'gh-user',
  'gh-oauth-state',
]
const AUTH_REQUEST_TIMEOUT_MS = 15_000
const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000
const WORKER_CONFIGURED = isConfiguredWorkerUrl(WORKER_URL)
const WORKER_CONFIG_ERROR = '缺少有效的 VITE_WORKER_URL，无法完成 GitHub 登录。'

export interface GitHubUser {
  login: string
  avatar_url: string
  html_url: string
}

interface AuthResponse {
  access_token?: string
  expires_at?: number | null
  refresh_expires_at?: number | null
  session?: string
  error?: string
  reason?: string
}

const isBrowser = typeof window !== 'undefined'
const token = ref<string | null>(null)
const user = ref<GitHubUser | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const accessExpiresAt = ref<number | null>(null)
const sessionPresent = ref(false)
const isAuthenticated = computed(() => !!token.value || sessionPresent.value)

let initialized = false
let loadingCount = 0
let sessionPromise: Promise<string | null> | null = null
let sessionPromiseForcesRefresh = false
let revokePromise: Promise<boolean> | null = null

export function useAuth() {
  function init() {
    if (!isBrowser || initialized) return
    initialized = true
    clearLegacyPlaintextTokens()
    window.addEventListener('storage', onStorage)

    const url = new URL(window.location.href)
    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')
    const oauthError = url.searchParams.get('error')
    const oauthErrorDescription = url.searchParams.get('error_description')

    if (code || oauthError) {
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      url.searchParams.delete('error')
      url.searchParams.delete('error_description')
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    }

    if (oauthError) {
      error.value = oauthErrorDescription || 'GitHub 登录已取消或失败。'
      clearOAuthState()
      return
    }

    if (code) {
      const expectedState = readSession(OAUTH_STATE_KEY)
      const verifier = readSession(OAUTH_VERIFIER_KEY)
      const returnTo = readSession(OAUTH_RETURN_KEY)
      clearOAuthState()
      if (!expectedState || !returnedState || expectedState !== returnedState || !verifier) {
        error.value = 'GitHub 登录校验失败，请重新登录。'
        return
      }
      void exchangeCode(code, verifier, returnTo)
      return
    }

  if (readLocal(SESSION_KEY)) {
      sessionPresent.value = true
      void runLoading(async () => {
        const restored = await restoreAccessToken(false)
        if (restored) await fetchUserWithRefresh()
      })
    }
  }

  async function login() {
    if (!isBrowser) return
    if (!WORKER_CONFIGURED) {
      error.value = WORKER_CONFIG_ERROR
      return
    }
    if (!GITHUB_CLIENT_ID) {
      error.value = '缺少 VITE_GITHUB_CLIENT_ID，无法启动 GitHub 登录。'
      return
    }

    if (revokePromise) await revokePromise
    error.value = null

    const state = randomBase64Url(24)
    const verifier = randomBase64Url(32)
    const challenge = await pkceChallenge(verifier)
    const callbackUrl = authCallbackUrl()
    const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`

    writeSession(OAUTH_STATE_KEY, state)
    writeSession(OAUTH_VERIFIER_KEY, verifier)
    writeSession(OAUTH_RETURN_KEY, returnTo)

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    window.location.href = `https://github.com/login/oauth/authorize?${params}`
  }

  async function logout(): Promise<boolean> {
    const opaqueSession = readLocal(SESSION_KEY)
    clearSession()

    if (!opaqueSession) return true
    if (!WORKER_CONFIGURED) {
      error.value = '已退出本地会话，但缺少有效的 VITE_WORKER_URL，无法撤销 GitHub 授权。'
      return false
    }

    const promise = fetchWithTimeout(`${WORKER_URL}/api/auth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: opaqueSession }),
    })
      .then(response => {
        if (!response.ok) throw new Error(`revoke failed (${response.status})`)
        return true
      })
      .catch(() => {
        error.value = '已退出本地会话，但暂时无法撤销 GitHub 授权；可稍后在 GitHub 设置中手动撤销。'
        return false
      })
      .finally(() => {
        if (revokePromise === promise) revokePromise = null
      })
    revokePromise = promise
    return promise
  }

  async function exchangeCode(code: string, verifier: string, returnTo: string | null) {
    if (!WORKER_CONFIGURED) {
      error.value = WORKER_CONFIG_ERROR
      return
    }

    await runLoading(async () => {
      error.value = null
      try {
        const response = await fetchWithTimeout(`${WORKER_URL}/api/auth/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            code_verifier: verifier,
            redirect_uri: authCallbackUrl(),
          }),
        })
        const data = await safeJson<AuthResponse>(response)
        if (!response.ok || !applyAuthResponse(data)) {
          throw new Error(data.error || 'GitHub token 交换失败。')
        }

        await fetchUserWithRefresh()
        const safeReturn = safeReturnPath(returnTo)
        if (safeReturn && safeReturn !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
          window.location.replace(safeReturn)
        }
      } catch (cause) {
        clearSession()
        error.value = authErrorMessage(cause, 'GitHub 登录失败。')
      }
    })
  }

  async function restoreAccessToken(forceRefresh: boolean): Promise<string | null> {
    if (!isBrowser || !WORKER_CONFIGURED) return null
    if (
      !forceRefresh
      && token.value
      && (accessExpiresAt.value === null || accessExpiresAt.value > Date.now() + ACCESS_REFRESH_SKEW_MS)
    ) {
      return token.value
    }

    if (sessionPromise) {
      if (sessionPromiseForcesRefresh || !forceRefresh) return sessionPromise
      await sessionPromise
    }

    sessionPromiseForcesRefresh = forceRefresh
    const promise = restoreAccessTokenLocked(forceRefresh)
      .finally(() => {
        if (sessionPromise === promise) {
          sessionPromise = null
          sessionPromiseForcesRefresh = false
        }
      })
    sessionPromise = promise
    return promise
  }

  async function restoreAccessTokenLocked(forceRefresh: boolean): Promise<string | null> {
    const sessionBeforeLock = readLocal(SESSION_KEY)
    if (!sessionBeforeLock) return null

    const operation = async () => {
      const latestSession = readLocal(SESSION_KEY)
      if (!latestSession) return null
      const shouldForce = forceRefresh && latestSession === sessionBeforeLock
      return requestSession(latestSession, shouldForce)
    }

    const lockManager = navigator.locks
    if (lockManager) {
      return lockManager.request(REFRESH_LOCK_NAME, operation)
    }
    return operation()
  }

  async function requestSession(opaqueSession: string, forceRefresh: boolean): Promise<string | null> {
    try {
      let response = await fetchWithTimeout(`${WORKER_URL}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: opaqueSession, force: forceRefresh }),
      })
      let data = await safeJson<AuthResponse>(response)

      if (!response.ok) {
        const latestSession = readLocal(SESSION_KEY)
        if (latestSession && latestSession !== opaqueSession) {
          response = await fetchWithTimeout(`${WORKER_URL}/api/auth/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: latestSession, force: false }),
          })
          data = await safeJson<AuthResponse>(response)
        }
      }

      if (!response.ok || !applyAuthResponse(data)) {
        if (response.status === 401) {
          if (data.reason === 'invalid_session' || data.reason === 'refresh_rejected') clearSession()
          error.value = 'GitHub 会话已过期或被撤销，请重新登录。'
        }
        return null
      }
      return token.value
    } catch (cause) {
      error.value = authErrorMessage(cause, '暂时无法恢复 GitHub 会话，请稍后重试。')
      return null
    }
  }

  async function refreshToken(): Promise<string | null> {
    return restoreAccessToken(true)
  }

  async function fetchUserWithRefresh(): Promise<boolean> {
    let currentToken = token.value
    if (!currentToken) currentToken = await restoreAccessToken(false)
    if (!currentToken) return false

    let response: Response
    try {
      response = await fetchGitHubUser(currentToken)
      if (response.status === 401) {
        const refreshed = await restoreAccessToken(true)
        if (refreshed) response = await fetchGitHubUser(refreshed)
      }
    } catch (cause) {
      error.value = authErrorMessage(cause, '当前无法连接 GitHub，请检查网络后重试。')
      return false
    }

    if (response.ok) {
      user.value = await response.json() as GitHubUser
      writeLocal(USER_KEY, JSON.stringify(user.value))
      return true
    }

    if (response.status === 401) {
      if (readLocal(SESSION_KEY)) {
        error.value = 'GitHub access token 已失效，但会话暂时无法续期，请稍后重试。'
      } else {
        clearSession()
        error.value = 'GitHub 登录已失效，请重新登录。'
      }
    } else {
      error.value = `读取 GitHub 用户信息失败（${response.status}）。`
    }
    return false
  }

  async function refreshUser(): Promise<boolean> {
    return runLoading(async () => {
      error.value = null
      return fetchUserWithRefresh()
    })
  }

  function clearError() {
    error.value = null
  }

  return {
    token: readonly(token),
    user: readonly(user),
    loading: readonly(loading),
    error: readonly(error),
    isAuthenticated,
    init,
    login,
    logout,
    restoreToken: () => restoreAccessToken(false),
    refreshToken,
    refreshUser,
    clearError,
  }
}

function applyAuthResponse(data: AuthResponse): boolean {
  if (!data.access_token || !data.session) return false
  token.value = data.access_token
  sessionPresent.value = true
  accessExpiresAt.value = typeof data.expires_at === 'number' ? data.expires_at : null
  writeLocal(SESSION_KEY, data.session)
  const cachedUser = parseUser(readLocal(USER_KEY))
  if (cachedUser) user.value = cachedUser
  return true
}

function clearSession() {
  token.value = null
  user.value = null
  accessExpiresAt.value = null
  sessionPresent.value = false
  removeLocal(SESSION_KEY)
  removeLocal(USER_KEY)
  clearLegacyPlaintextTokens()
}

function clearOAuthState() {
  removeSession(OAUTH_STATE_KEY)
  removeSession(OAUTH_VERIFIER_KEY)
  removeSession(OAUTH_RETURN_KEY)
  removeSession('gh-oauth-state')
}

function clearLegacyPlaintextTokens() {
  for (const key of LEGACY_KEYS) {
    removeSession(key)
    removeLocal(key)
  }
}

function onStorage(event: StorageEvent) {
  if (event.key !== SESSION_KEY) return
  if (!event.newValue) {
    token.value = null
    user.value = null
    accessExpiresAt.value = null
    sessionPresent.value = false
    return
  }
  sessionPresent.value = true
  if (sessionPromise) return
  token.value = null
  accessExpiresAt.value = null
  void restoreAccessTokenFromStorage(event.newValue)
}

async function restoreAccessTokenFromStorage(_opaqueSession: string) {
  const auth = useAuth()
  const restored = await auth.restoreToken()
  if (restored) await auth.refreshUser()
}

function authCallbackUrl(): string {
  return new URL(readerConfig.document.base, window.location.origin).href
}

function safeReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null
  try {
    const url = new URL(value, window.location.origin)
    return url.origin === window.location.origin
      && url.pathname.startsWith(readerConfig.document.base)
      ? `${url.pathname}${url.search}${url.hash}`
      : null
  } catch {
    return null
  }
}

async function fetchGitHubUser(accessToken: string): Promise<Response> {
  return fetchWithTimeout('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
    },
  })
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return bytesToBase64Url(new Uint8Array(digest))
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function parseUser(raw: string | null): GitHubUser | null {
  if (!raw) return null
  try { return JSON.parse(raw) as GitHubUser } catch { return null }
}

function readSession(key: string): string | null {
  if (!isBrowser) return null
  try { return sessionStorage.getItem(key) } catch { return null }
}

function writeSession(key: string, value: string) {
  if (!isBrowser) return
  try { sessionStorage.setItem(key, value) } catch { /* storage can be disabled */ }
}

function removeSession(key: string) {
  if (!isBrowser) return
  try { sessionStorage.removeItem(key) } catch { /* storage can be disabled */ }
}

function readLocal(key: string): string | null {
  if (!isBrowser) return null
  try { return localStorage.getItem(key) } catch { return null }
}

function writeLocal(key: string, value: string) {
  if (!isBrowser) return
  try { localStorage.setItem(key, value) } catch { /* storage can be disabled */ }
}

function removeLocal(key: string) {
  if (!isBrowser) return
  try { localStorage.removeItem(key) } catch { /* storage can be disabled */ }
}

async function runLoading<T>(operation: () => Promise<T>): Promise<T> {
  loadingCount++
  loading.value = true
  try {
    return await operation()
  } finally {
    loadingCount--
    loading.value = loadingCount > 0
  }
}

function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeout = AUTH_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  return fetch(input, { ...init, signal: controller.signal })
    .finally(() => clearTimeout(timer))
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    return {} as T
  }
}

function authErrorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.name === 'AbortError') {
    return 'GitHub 请求超时，请稍后重试。'
  }
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function isConfiguredWorkerUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    return !url.hostname.endsWith('.invalid')
      && (url.protocol === 'https:' || (local && url.protocol === 'http:'))
  } catch {
    return false
  }
}
