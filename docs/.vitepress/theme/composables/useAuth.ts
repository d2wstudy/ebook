import { computed, readonly, ref } from 'vue'
import { readerConfig } from '../readerConfig'

const GITHUB_CLIENT_ID = readerConfig.github.oauthClientId
const WORKER_URL = readerConfig.github.workerUrl
const STORAGE_PREFIX = `github-reader::${readerConfig.projectId}::auth`
const TOKEN_KEY = `${STORAGE_PREFIX}::token`
const USER_KEY = `${STORAGE_PREFIX}::user`
const OAUTH_STATE_KEY = `${STORAGE_PREFIX}::oauth-state`
const LEGACY_TOKEN_KEY = 'gh-token'
const LEGACY_USER_KEY = 'gh-user'
const LEGACY_OAUTH_STATE_KEY = 'gh-oauth-state'
const AUTH_REQUEST_TIMEOUT_MS = 15_000
const WORKER_CONFIGURED = isConfiguredWorkerUrl(WORKER_URL)
const WORKER_CONFIG_ERROR = '缺少有效的 VITE_WORKER_URL，无法完成 GitHub 登录。'

export interface GitHubUser {
  login: string
  avatar_url: string
  html_url: string
}

const isBrowser = typeof window !== 'undefined'

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

/** Migrate the previous unscoped session/persistent token formats once. */
function restoreToken(): string | null {
  const saved = readSession(TOKEN_KEY)
  if (saved || !isBrowser) return saved

  const legacySessionToken = readSession(LEGACY_TOKEN_KEY)
  if (legacySessionToken) {
    writeSession(TOKEN_KEY, legacySessionToken)
    const legacySessionUser = readSession(LEGACY_USER_KEY)
    if (legacySessionUser) writeSession(USER_KEY, legacySessionUser)
    removeSession(LEGACY_TOKEN_KEY)
    removeSession(LEGACY_USER_KEY)
    return legacySessionToken
  }

  try {
    const legacy = localStorage.getItem(LEGACY_TOKEN_KEY)
    if (legacy) writeSession(TOKEN_KEY, legacy)
    const legacyUser = localStorage.getItem(LEGACY_USER_KEY)
    if (legacy && legacyUser) writeSession(USER_KEY, legacyUser)
    localStorage.removeItem(LEGACY_TOKEN_KEY)
    localStorage.removeItem(LEGACY_USER_KEY)
    return legacy
  } catch {
    return null
  }
}

function parseUser(raw: string | null): GitHubUser | null {
  if (!raw) return null
  try { return JSON.parse(raw) as GitHubUser } catch { return null }
}

const savedToken = restoreToken()
const token = ref<string | null>(savedToken)
const user = ref<GitHubUser | null>(savedToken ? parseUser(readSession(USER_KEY)) : null)
const loading = ref(false)
const error = ref<string | null>(null)
const isAuthenticated = computed(() => !!token.value)

let initialized = false
let revokePromise: Promise<boolean> | null = null

export function useAuth() {
  function init() {
    if (!isBrowser || initialized) return
    initialized = true

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
      const expectedState = readSession(OAUTH_STATE_KEY) || readSession(LEGACY_OAUTH_STATE_KEY)
      clearOAuthState()
      if (!expectedState || !returnedState || expectedState !== returnedState) {
        error.value = 'GitHub 登录校验失败，请重新登录。'
        return
      }
      void exchangeCode(code)
      return
    }

    if (token.value) {
      void refreshUser()
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

    const callbackUrl = window.location.origin + window.location.pathname
    const state = createOAuthState()
    removeSession(LEGACY_OAUTH_STATE_KEY)
    writeSession(OAUTH_STATE_KEY, state)

    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      scope: readerConfig.github.oauthScope,
      redirect_uri: callbackUrl,
      state,
    })
    window.location.href = `https://github.com/login/oauth/authorize?${params}`
  }

  async function logout(): Promise<boolean> {
    const saved = token.value
    clearSession()

    if (!saved) return true
    if (!WORKER_CONFIGURED) {
      error.value = '已退出本地会话，但缺少有效的 VITE_WORKER_URL，无法撤销 GitHub 授权。'
      return false
    }
    if (!GITHUB_CLIENT_ID) {
      error.value = '已退出本地会话，但缺少 OAuth Client ID，无法撤销 GitHub 授权。'
      return false
    }

    const promise = fetchWithTimeout(`${WORKER_URL}/api/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: saved, client_id: GITHUB_CLIENT_ID }),
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

  async function exchangeCode(code: string) {
    if (!WORKER_CONFIGURED) {
      error.value = WORKER_CONFIG_ERROR
      return
    }

    loading.value = true
    error.value = null
    const redirectUri = window.location.origin + window.location.pathname

    try {
      const resp = await fetchWithTimeout(`${WORKER_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          client_id: GITHUB_CLIENT_ID,
          redirect_uri: redirectUri,
        }),
      })
      const data = await resp.json() as { access_token?: string; error?: string; error_description?: string }

      if (!resp.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'GitHub token 交换失败。')
      }

      token.value = data.access_token
      writeSession(TOKEN_KEY, data.access_token)
      await fetchUser()
    } catch (cause) {
      clearSession()
      error.value = authErrorMessage(cause, 'GitHub 登录失败。')
    } finally {
      loading.value = false
    }
  }

  async function fetchUser(): Promise<boolean> {
    if (!token.value) return false

    try {
      const resp = await fetchWithTimeout(`${WORKER_URL}/api/github/user`, {
        headers: { Authorization: `Bearer ${token.value}` },
      })

      if (resp.ok) {
        user.value = await resp.json() as GitHubUser
        writeSession(USER_KEY, JSON.stringify(user.value))
        return true
      }

      if (resp.status === 401) clearSession()
      error.value = resp.status === 401
        ? 'GitHub 登录已失效，请重新登录。'
        : `读取 GitHub 用户信息失败（${resp.status}）。`
      return false
    } catch (cause) {
      error.value = authErrorMessage(cause, '当前无法连接 GitHub，请检查网络后重试。')
      return false
    }
  }

  async function refreshUser(): Promise<boolean> {
    if (!token.value) return false
    loading.value = true
    error.value = null
    try {
      return await fetchUser()
    } finally {
      loading.value = false
    }
  }

  function clearError() {
    error.value = null
  }

  function invalidate() {
    clearSession()
    error.value = 'GitHub 登录已失效，请重新登录。'
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
    refreshUser,
    invalidate,
    clearError,
  }
}

function clearSession() {
  token.value = null
  user.value = null
  removeSession(TOKEN_KEY)
  removeSession(USER_KEY)
  removeSession(LEGACY_TOKEN_KEY)
  removeSession(LEGACY_USER_KEY)
}

function clearOAuthState() {
  removeSession(OAUTH_STATE_KEY)
  removeSession(LEGACY_OAUTH_STATE_KEY)
}

function createOAuthState(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
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
