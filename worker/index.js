// Cloudflare Worker for GitHub OAuth and Discussion reads.
// Required secrets:
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
//   GITHUB_CLIENT_ID_DEV / GITHUB_CLIENT_SECRET_DEV (optional)
//   GITHUB_PAT (fine-grained token with Discussions read access)
//   CACHE_PURGE_KEY (optional server-to-server purge key)
// Deployment variables (all have backward-compatible defaults):
//   REPO_OWNER / REPO_NAME
//   DOCUMENT_PATH_PREFIX
//   DISCUSSION_CATEGORIES (comma-separated category names)
//   ALLOWED_ORIGINS (comma-separated origins)

const CACHE_TTL = 300
const USER_REACTION_TTL = 604800
const TOKEN_VALIDATION_TTL = 600
const MAX_COMMENT_PAGES = 10
const DEFAULT_REPO_OWNER = 'example'
const DEFAULT_REPO_NAME = 'reader-template'
const DEFAULT_DOCUMENT_PATH_PREFIX = '/reader-template/'
const DEFAULT_DISCUSSION_CATEGORIES = ['Ideas', 'Announcements', 'General']
const ALLOWED_REACTIONS = new Set([
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
])
const DEFAULT_ALLOWED_ORIGINS = [
  'https://example.github.io',
  'http://localhost:15689',
  'http://127.0.0.1:15689',
]

const REPLY_FIELDS = `
  id body createdAt lastEditedAt url authorAssociation
  author { login avatarUrl }
  reactionGroups { content viewerHasReacted reactors { totalCount } }
`

const COMMENT_FIELDS = `
  ${REPLY_FIELDS}
  replies(first: 100) {
    totalCount
    nodes { ${REPLY_FIELDS} }
  }
`

export default {
  async fetch(request, env) {
    const originAllowed = isAllowedOrigin(request, env)
    const corsHeaders = buildCorsHeaders(request, env)

    if (!originAllowed) {
      return json({ error: 'Origin not allowed' }, 403, corsHeaders)
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    try {
      const url = new URL(request.url)

      if (url.pathname === '/api/discussions' && request.method === 'GET') {
        return await handleDiscussions(request, url, env, corsHeaders)
      }

      if (url.pathname === '/api/cache/purge' && request.method === 'POST') {
        return await handleCachePurge(request, url, env, corsHeaders)
      }

      if (url.pathname === '/api/auth' && request.method === 'POST') {
        return await handleAuth(request, env, corsHeaders)
      }

      if (url.pathname === '/api/revoke' && request.method === 'POST') {
        return await handleRevoke(request, env, corsHeaders)
      }

      return json({ error: 'Not found' }, 404, corsHeaders)
    } catch (error) {
      console.error('[worker]', error?.message || error)
      const status = Number.isInteger(error?.status) ? error.status : 502
      return json({ error: publicErrorMessage(error, status) }, status, corsHeaders)
    }
  },
}

async function handleAuth(request, env, corsHeaders) {
  const body = await readJsonBody(request)
  const { code, client_id: clientId, redirect_uri: redirectUri } = body
  if (!code || !clientId || !redirectUri) {
    return json({ error: 'Missing OAuth parameters' }, 400, corsHeaders)
  }

  const credentials = selectOAuthCredentials(env, clientId)
  if (!credentials) return json({ error: 'Unknown OAuth client' }, 400, corsHeaders)
  if (!isAllowedRedirectUri(redirectUri, env)) {
    return json({ error: 'Invalid redirect_uri' }, 400, corsHeaders)
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
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
  const status = response.ok && !data.error ? 200 : 400
  return json(data, status, { ...corsHeaders, 'Cache-Control': 'no-store' })
}

async function handleRevoke(request, env, corsHeaders) {
  const body = await readJsonBody(request)
  const { access_token: accessToken, client_id: clientId } = body
  if (!accessToken || !clientId) {
    return json({ error: 'Missing revoke parameters' }, 400, corsHeaders)
  }

  const credentials = selectOAuthCredentials(env, clientId)
  if (!credentials) return json({ error: 'Unknown OAuth client' }, 400, corsHeaders)

  const response = await fetch(`https://api.github.com/applications/${credentials.id}/grant`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${btoa(`${credentials.id}:${credentials.secret}`)}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'github-reader-worker',
    },
    body: JSON.stringify({ access_token: accessToken }),
  })

  if (response.status === 204 || response.status === 404 || response.status === 422) {
    return json({ ok: true }, 200, { ...corsHeaders, 'Cache-Control': 'no-store' })
  }
  return json({ ok: false, status: response.status }, response.status, corsHeaders)
}

async function handleDiscussions(request, url, env, corsHeaders) {
  const config = getWorkerConfig(env)
  const params = validateDiscussionParams(url, config)
  if (params.error) return json({ error: params.error }, 400, corsHeaders)
  const { pagePath, categoryName, knownId } = params

  const authHeader = request.headers.get('Authorization')
  const userToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const cache = caches.default
  const cacheKey = buildCacheKey(url)
  const cached = await cache.match(cacheKey)

  let result
  let fetchedWithUserToken = false

  if (cached) {
    console.log(`[CACHE HIT] ${categoryName} | ${pagePath}`)
    result = await cached.json()
  } else {
    const readToken = userToken || env.GITHUB_PAT
    if (!readToken) {
      return json({ discussion: null, comments: [] }, 200, {
        ...corsHeaders,
        'X-Cache': 'MISS',
      })
    }

    fetchedWithUserToken = !!userToken
    result = await fetchDiscussion(readToken, pagePath, categoryName, knownId, config)
    const sharedResult = toSharedResult(result)
    sharedResult._cachedAt = Date.now()
    await cache.put(cacheKey, json(sharedResult, 200, {
      'Cache-Control': `public, max-age=${CACHE_TTL}`,
    }))
    console.log(`[CACHE FILL] ${categoryName} | ${pagePath} — ${result.comments.length} comments`)
  }

  if (!userToken) {
    stripViewerReactions(result.comments)
  } else if (result.comments.length) {
    const tokenHash = await hashToken(userToken)
    const userCacheKey = buildUserCacheKey(url, tokenHash)
    const userCached = await cache.match(userCacheKey)

    if (userCached) {
      overlayReactions(result.comments, await userCached.json())
    } else {
      const reactionMap = fetchedWithUserToken
        ? extractReactions(result.comments)
        : await fetchUserReactions(userToken, collectSubjectIds(result.comments))
      overlayReactions(result.comments, reactionMap)
      await cache.put(userCacheKey, json(reactionMap, 200, {
        'Cache-Control': `public, max-age=${USER_REACTION_TTL}`,
      }))
    }
  }

  return json(result, 200, {
    ...corsHeaders,
    'X-Cache': cached ? 'HIT' : 'MISS',
  })
}

async function handleCachePurge(request, url, env, corsHeaders) {
  const config = getWorkerConfig(env)
  const params = validateDiscussionParams(url, config)
  if (params.error) return json({ error: params.error }, 400, corsHeaders)
  const { pagePath, categoryName, knownId } = params

  const reactionMutation = validateReactionMutation(url)
  if (reactionMutation.error) return json({ error: reactionMutation.error }, 400, corsHeaders)

  const userOnly = url.searchParams.get('user_only') === '1'
  const authHeader = request.headers.get('Authorization')
  const userToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  const purgeKey = request.headers.get('X-Purge-Key') || request.headers.get('X-Cache-Purge-Key')
  const cache = caches.default

  const hasValidPurgeKey = !!(env.CACHE_PURGE_KEY && purgeKey === env.CACHE_PURGE_KEY)
  if (!hasValidPurgeKey) {
    if (!userToken || !await validateGithubTokenCached(cache, url.origin, userToken)) {
      return json({ error: 'Unauthorized' }, 401, corsHeaders)
    }
  }

  const cacheKey = buildCacheKey(url)
  let deleted = false

  if (!userOnly) {
    deleted = await cache.delete(cacheKey)
    const refillToken = userToken || env.GITHUB_PAT
    if (refillToken) {
      try {
        const fresh = await fetchDiscussion(refillToken, pagePath, categoryName, knownId, config)
        if (fresh.discussion) {
          const shared = toSharedResult(fresh)
          shared._cachedAt = Date.now()
          await cache.put(cacheKey, json(shared, 200, {
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
          }))
        }
      } catch (error) {
        console.error(`[CACHE REFILL FAILED] ${categoryName} | ${pagePath}`, error?.message || error)
      }
    }
  }

  if (userOnly && reactionMutation.active) {
    // Client-supplied deltas are not authoritative. Drop the shared cache so
    // the next reader receives reaction totals directly from GitHub.
    deleted = await cache.delete(cacheKey) || deleted
  }

  let userDeleted = false
  if (userToken) {
    const tokenHash = await hashToken(userToken)
    userDeleted = await cache.delete(buildUserCacheKey(url, tokenHash))
  }

  return json({ ok: true, deleted, userDeleted }, 200, corsHeaders)
}

async function fetchDiscussion(token, pagePath, categoryName, knownId, config) {
  let discussion = null

  if (knownId) {
    const candidate = await fetchDiscussionMetaById(token, knownId)
    const expectedRepository = `${config.repoOwner}/${config.repoName}`.toLowerCase()
    if (
      candidate?.title === pagePath
      && candidate.category?.name === categoryName
      && candidate.repository?.nameWithOwner?.toLowerCase() === expectedRepository
    ) {
      discussion = candidate
    }
  }

  if (!discussion) {
    discussion = await searchDiscussion(token, pagePath, categoryName, config)
  }

  if (!discussion) return { discussion: null, comments: [] }
  const comments = await fetchAllComments(token, discussion.id)
  return {
    discussion: {
      id: discussion.id,
      url: discussion.url,
      number: discussion.number,
      category: discussion.category.name,
    },
    comments,
  }
}

async function fetchDiscussionMetaById(token, id) {
  const data = await githubGql(token, `query($id: ID!) {
    node(id: $id) {
      ... on Discussion {
        id title url number
        category { name }
        repository { nameWithOwner }
      }
    }
  }`, { id })
  return data?.node?.id ? data.node : null
}

async function searchDiscussion(token, pagePath, categoryName, config) {
  const searchQuery = `repo:${config.repoOwner}/${config.repoName} in:title ${JSON.stringify(pagePath)} category:${JSON.stringify(categoryName)}`
  const data = await githubGql(token, `query($query: String!) {
    search(query: $query, type: DISCUSSION, first: 10) {
      nodes {
        ... on Discussion { id title url number category { name } }
      }
    }
  }`, { query: searchQuery })

  return (data?.search?.nodes || []).find(node =>
    node?.title === pagePath && node.category?.name === categoryName) || null
}

async function fetchAllComments(token, discussionId) {
  const comments = []
  let cursor = null
  let page = 0
  let hasNextPage = true

  while (hasNextPage && page < MAX_COMMENT_PAGES) {
    const data = await githubGql(token, `query($id: ID!, $after: String) {
      node(id: $id) {
        ... on Discussion {
          comments(first: 100, after: $after) {
            nodes { ${COMMENT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { id: discussionId, after: cursor })

    const connection = data?.node?.comments
    if (!connection) break
    comments.push(...(connection.nodes || []))
    hasNextPage = !!connection.pageInfo?.hasNextPage
    cursor = connection.pageInfo?.endCursor || null
    page++
  }

  return comments
}

async function fetchUserReactions(token, subjectIds) {
  const result = {}
  for (let start = 0; start < subjectIds.length; start += 100) {
    const ids = subjectIds.slice(start, start + 100)
    const data = await githubGql(token, `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on DiscussionComment {
          id
          reactionGroups { content viewerHasReacted }
        }
      }
    }`, { ids })

    for (const node of data?.nodes || []) {
      if (!node?.id) continue
      for (const group of node.reactionGroups || []) {
        if (!group.viewerHasReacted) continue
        result[node.id] ||= {}
        result[node.id][group.content] = true
      }
    }
  }
  return result
}

function toSharedResult(result) {
  const shared = structuredClone(result)
  stripViewerReactions(shared.comments)
  return shared
}

function stripViewerReactions(comments) {
  overlayReactions(comments, {})
}

function extractReactions(comments) {
  const result = {}
  forEachCommentNode(comments, node => {
    for (const group of node.reactionGroups || []) {
      if (!group.viewerHasReacted) continue
      result[node.id] ||= {}
      result[node.id][group.content] = true
    }
  })
  return result
}

function overlayReactions(comments, reactionMap) {
  forEachCommentNode(comments, node => {
    const nodeReactions = reactionMap[node.id] || {}
    for (const group of node.reactionGroups || []) {
      group.viewerHasReacted = !!nodeReactions[group.content]
    }
  })
}

function collectSubjectIds(comments) {
  const ids = []
  forEachCommentNode(comments, node => ids.push(node.id))
  return ids
}

function forEachCommentNode(comments, callback) {
  for (const comment of comments || []) {
    callback(comment)
    for (const reply of comment.replies?.nodes || []) callback(reply)
  }
}

async function githubGql(token, query, variables) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'github-reader-worker',
    },
    body: JSON.stringify({ query, variables }),
  })
  const data = await safeResponseJson(response)

  if (!response.ok) throw workerError(`GitHub API request failed (${response.status})`, response.status)
  if (data.errors?.length) {
    throw workerError(data.errors.map(error => error.message).join('; '), 502)
  }
  return data.data
}

async function validateGithubTokenCached(cache, origin, token) {
  const tokenHash = await hashToken(token)
  const key = buildTokenValidationCacheKey(origin, tokenHash)
  if (await cache.match(key)) return true

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'github-reader-worker',
    },
  }).catch(() => null)
  if (!response?.ok) return false

  await cache.put(key, new Response('ok', {
    headers: { 'Cache-Control': `public, max-age=${TOKEN_VALIDATION_TTL}` },
  }))
  return true
}

function validateDiscussionParams(url, configOrEnv = {}) {
  const config = configOrEnv?.allowedCategories instanceof Set
    ? configOrEnv
    : getWorkerConfig(configOrEnv)
  const pagePath = url.searchParams.get('path')
  const categoryName = url.searchParams.get('category')
  const knownId = url.searchParams.get('id')

  if (!pagePath || !categoryName) return { error: 'Missing path or category' }
  const pathSegments = pagePath.split('/')
  if (
    pagePath.length > 400
    || !pagePath.startsWith(config.documentPathPrefix)
    || !pagePath.endsWith('.html')
    || pagePath.includes('\\')
    || pagePath.includes('//')
    || pathSegments.includes('..')
    || /[\r\n]/.test(pagePath)
  ) {
    return { error: 'Invalid path' }
  }
  if (!config.allowedCategories.has(categoryName)) return { error: 'Invalid category' }
  if (knownId && knownId.length > 200) return { error: 'Invalid discussion id' }
  return { pagePath, categoryName, knownId }
}

function validateReactionMutation(url) {
  const subjectId = url.searchParams.get('subject_id')
  const reaction = url.searchParams.get('reaction')
  const delta = url.searchParams.get('delta')
  const active = subjectId !== null || reaction !== null || delta !== null

  if (!active) return { active: false }
  if (!subjectId || subjectId.length > 200 || /[\r\n]/.test(subjectId)) {
    return { error: 'Invalid reaction subject' }
  }
  if (!reaction || !ALLOWED_REACTIONS.has(reaction)) {
    return { error: 'Invalid reaction' }
  }
  if (delta !== '1' && delta !== '-1') {
    return { error: 'Invalid reaction delta' }
  }
  return { active: true, subjectId, reaction, delta: Number(delta) }
}

function selectOAuthCredentials(env, clientId) {
  if (clientId === env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return { id: env.GITHUB_CLIENT_ID, secret: env.GITHUB_CLIENT_SECRET }
  }
  if (clientId === env.GITHUB_CLIENT_ID_DEV && env.GITHUB_CLIENT_SECRET_DEV) {
    return { id: env.GITHUB_CLIENT_ID_DEV, secret: env.GITHUB_CLIENT_SECRET_DEV }
  }
  return null
}

function isAllowedRedirectUri(value, env) {
  try {
    const url = new URL(value)
    return allowedOrigins(env).has(url.origin)
  } catch {
    return false
  }
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin')
  return !origin || allowedOrigins(env).has(origin)
}

function allowedOrigins(env) {
  return new Set(readCommaSeparated(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS))
}

function getWorkerConfig(env = {}) {
  return {
    repoOwner: readSetting(env.REPO_OWNER, DEFAULT_REPO_OWNER),
    repoName: readSetting(env.REPO_NAME, DEFAULT_REPO_NAME),
    documentPathPrefix: normalizePathPrefix(
      readSetting(env.DOCUMENT_PATH_PREFIX, DEFAULT_DOCUMENT_PATH_PREFIX),
    ),
    allowedCategories: new Set(readCommaSeparated(
      env.DISCUSSION_CATEGORIES,
      DEFAULT_DISCUSSION_CATEGORIES,
    )),
  }
}

function readSetting(value, fallback) {
  const configured = String(value || '').trim()
  return configured || fallback
}

function readCommaSeparated(value, fallback) {
  const configured = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return configured.length ? configured : [...fallback]
}

function normalizePathPrefix(value) {
  const clean = `/${String(value).trim().replace(/^\/+|\/+$/g, '')}/`
  return clean === '//' ? '/' : clean
}

function buildCorsHeaders(request, env) {
  const origin = request.headers.get('Origin')
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Purge-Key, X-Cache-Purge-Key',
    Vary: 'Origin',
  }
  if (origin && allowedOrigins(env).has(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

function buildCacheKey(url) {
  const normalized = new URL(`${url.origin}/api/discussions`)
  normalized.searchParams.set('path', url.searchParams.get('path'))
  normalized.searchParams.set('category', url.searchParams.get('category'))
  return new Request(normalized.toString(), { method: 'GET' })
}

function buildUserCacheKey(url, tokenHash) {
  const normalized = new URL(`${url.origin}/api/reactions`)
  normalized.searchParams.set('path', url.searchParams.get('path'))
  normalized.searchParams.set('category', url.searchParams.get('category'))
  normalized.searchParams.set('u', tokenHash)
  return new Request(normalized.toString(), { method: 'GET' })
}

function buildTokenValidationCacheKey(origin, tokenHash) {
  const url = new URL(`${origin}/api/_token_ok`)
  url.searchParams.set('u', tokenHash)
  return new Request(url.toString(), { method: 'GET' })
}

async function hashToken(token) {
  const data = new TextEncoder().encode(token)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash).slice(0, 8))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function readJsonBody(request) {
  try { return await request.json() } catch { return {} }
}

async function safeResponseJson(response) {
  try { return await response.json() } catch { return {} }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers })
}

function workerError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

function publicErrorMessage(error, status) {
  if (status === 401) return 'GitHub authentication failed'
  if (status === 403) return 'Request forbidden'
  if (status === 429) return 'GitHub rate limit exceeded'
  if (error?.message?.includes('Could not resolve to a node')) return 'Discussion not found'
  return 'GitHub Discussions service is temporarily unavailable'
}

export { getWorkerConfig, validateDiscussionParams, validateReactionMutation }
