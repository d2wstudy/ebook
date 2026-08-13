import type {
  ApiRequestBudget,
  DiscussionResult,
  GitHubCommentNode,
  GitHubRateState,
  UserReactionMap,
  WorkerEnv,
} from './types'

const MAX_COMMENT_PAGES = 10
const API_REQUEST_LEASE_TTL_MS = 30_000
const encoder = new TextEncoder()
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

interface GitHubGraphQlEnvelope {
  data?: Record<string, unknown> | null
  errors?: Array<{ message?: string; type?: string }>
}

interface GraphQlResult {
  data: Record<string, unknown>
  rate: GitHubRateState
}

export class GitHubRequestError extends Error {
  constructor(
    message: string,
    public status: number,
    public blockedUntil = 0,
    public rate?: GitHubRateState,
  ) {
    super(message)
    this.name = 'GitHubRequestError'
  }
}

export async function fetchDiscussion(
  env: WorkerEnv,
  token: string,
  pagePath: string,
  categoryName: string,
  knownId: string | null,
  onRate: (rate: GitHubRateState) => Promise<void>,
): Promise<DiscussionResult> {
  let discussion: Record<string, unknown> | null = null

  if (knownId) {
    const candidate = await fetchDiscussionMetaById(env, token, knownId, onRate)
    const category = candidate?.category as { name?: string } | undefined
    const repository = candidate?.repository as { nameWithOwner?: string } | undefined
    if (
      candidate?.title === pagePath
      && category?.name === categoryName
      && repository?.nameWithOwner?.toLowerCase() === `${env.REPO_OWNER}/${env.REPO_NAME}`.toLowerCase()
    ) {
      discussion = candidate
    }
  }

  if (!discussion) {
    discussion = await searchDiscussion(env, token, pagePath, categoryName, onRate)
  }
  if (!discussion) return { discussion: null, comments: [] }

  const comments = await fetchAllComments(env, token, String(discussion.id), onRate)
  const category = discussion.category as { name?: string }
  return {
    discussion: {
      id: String(discussion.id),
      url: String(discussion.url),
      number: Number(discussion.number),
      category: category.name || categoryName,
    },
    comments,
  }
}

export async function githubGraphQl(
  env: WorkerEnv,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return githubGql(env, token, query, variables, async () => {})
}

export async function githubRestJson(
  env: WorkerEnv,
  token: string,
  path: string,
): Promise<Record<string, unknown>> {
  const { response, rate } = await githubRestRequestWithRate(
    env,
    token,
    `https://api.github.com${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'github-reader-worker',
      },
    },
  )
  const data = await safeJson<Record<string, unknown>>(response)
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub API request failed (${response.status})`,
      response.status,
      rate.blockedUntil,
      rate,
    )
  }
  return data
}

export async function githubRestRequest(
  env: WorkerEnv,
  token: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  return (await githubRestRequestWithRate(env, token, url, init)).response
}

async function githubRestRequestWithRate(
  env: WorkerEnv,
  token: string,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; rate: GitHubRateState }> {
  const method = normalizedMethod(init.method)
  const requestCost = restSecondaryCost(method)
  const primary = env.GITHUB_RATE_LIMIT.getByName(`primary:${await hashToken(token)}`)
  const global = env.GITHUB_RATE_LIMIT.getByName(await globalCoordinatorName(env))
  const config = getRateConfig(env)
  const primaryResult = await primary.acquirePrimary(1, config.reserve)
  if (!primaryResult.allowed) {
    throw new GitHubRequestError(
      'GitHub API request budget is protected',
      429,
      primaryResult.retryAt,
    )
  }
  const globalResult = await global.acquireApiRequest(apiBudget(config, {
    protocol: 'rest',
    secondaryCost: requestCost,
    secondaryLimit: config.restBudget,
    contentGenerating: isContentGeneratingRestMethod(method),
    mutation: isContentGeneratingRestMethod(method),
  }))
  if (!globalResult.allowed) {
    await primary.releasePrimary(1)
    throw new GitHubRequestError('GitHub API request budget is protected', 429, globalResult.retryAt)
  }
  const leaseId = globalResult.leaseId

  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    await primary.releasePrimary(1)
    throw new GitHubRequestError('Unable to connect to GitHub API', 502)
  } finally {
    await releaseApiLease(global, leaseId)
  }

  const now = Date.now()
  const rate = rateStateFromResponse(response, now)
  await primary.updatePrimary(rate, 1)
  if (isRestRateLimited(response, rate)) {
    const blockedUntil = rate.blockedUntil || rate.resetAt || now + 60_000
    await primary.updatePrimary({ ...rate, blockedUntil }, 0)
    throw new GitHubRequestError('GitHub API rate limit exceeded', 429, blockedUntil, {
      ...rate,
      blockedUntil,
    })
  }
  return { response, rate }
}

export async function githubOAuthRequest(
  env: WorkerEnv,
  clientId: string,
  init: RequestInit,
): Promise<Response> {
  const coordinator = env.GITHUB_RATE_LIMIT.getByName(`oauth:${await hashToken(clientId)}`)
  const budget = getRateConfig(env).oauthBudget
  const acquired = await coordinator.consumeRollingWindow('oauth:exchange', 1, budget, 60 * 60 * 1000)
  if (!acquired.allowed) {
    throw new GitHubRequestError(
      'GitHub OAuth request budget is protected',
      429,
      acquired.retryAt,
    )
  }
  try {
    return await fetch('https://github.com/login/oauth/access_token', init)
  } catch {
    throw new GitHubRequestError('Unable to connect to GitHub OAuth service', 502)
  }
}

export async function fetchUserReactions(
  env: WorkerEnv,
  token: string,
  subjectIds: string[],
  onRate: (rate: GitHubRateState) => Promise<void>,
): Promise<UserReactionMap> {
  const result: UserReactionMap = {}
  for (let start = 0; start < subjectIds.length; start += 100) {
    const ids = subjectIds.slice(start, start + 100)
    const data = await githubGql(env, token, `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on DiscussionComment {
          id
          reactionGroups { content viewerHasReacted }
        }
      }
    }`, { ids }, onRate)

    for (const raw of asArray(data.nodes)) {
      const node = asRecord(raw)
      if (!node?.id) continue
      for (const rawGroup of asArray(node.reactionGroups)) {
        const group = asRecord(rawGroup)
        if (!group?.viewerHasReacted || typeof group.content !== 'string') continue
        result[String(node.id)] ||= {}
        result[String(node.id)][group.content] = true
      }
    }
  }
  return result
}

async function fetchDiscussionMetaById(
  env: WorkerEnv,
  token: string,
  id: string,
  onRate: (rate: GitHubRateState) => Promise<void>,
): Promise<Record<string, unknown> | null> {
  const data = await githubGql(env, token, `query($id: ID!) {
    node(id: $id) {
      ... on Discussion {
        id title url number
        category { name }
        repository { nameWithOwner }
      }
    }
  }`, { id }, onRate)
  return asRecord(data.node)
}

async function searchDiscussion(
  env: WorkerEnv,
  token: string,
  pagePath: string,
  categoryName: string,
  onRate: (rate: GitHubRateState) => Promise<void>,
): Promise<Record<string, unknown> | null> {
  const searchQuery = `repo:${env.REPO_OWNER}/${env.REPO_NAME} in:title ${JSON.stringify(pagePath)} category:${JSON.stringify(categoryName)}`
  const data = await githubGql(env, token, `query($query: String!) {
    search(query: $query, type: DISCUSSION, first: 10) {
      nodes {
        ... on Discussion { id title url number category { name } }
      }
    }
  }`, { query: searchQuery }, onRate)
  const search = asRecord(data.search)
  return asArray(search?.nodes)
    .map(asRecord)
    .find(node => {
      const category = asRecord(node?.category)
      return node?.title === pagePath && category?.name === categoryName
    }) || null
}

async function fetchAllComments(
  env: WorkerEnv,
  token: string,
  discussionId: string,
  onRate: (rate: GitHubRateState) => Promise<void>,
): Promise<GitHubCommentNode[]> {
  const comments: GitHubCommentNode[] = []
  let cursor: string | null = null
  let page = 0
  let hasNextPage = true

  while (hasNextPage && page < MAX_COMMENT_PAGES) {
    const data = await githubGql(env, token, `query($id: ID!, $after: String) {
      node(id: $id) {
        ... on Discussion {
          comments(first: 100, after: $after) {
            nodes { ${COMMENT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }`, { id: discussionId, after: cursor }, onRate)
    const node = asRecord(data.node)
    const connection = asRecord(node?.comments)
    if (!connection) break
    comments.push(...asArray(connection.nodes) as GitHubCommentNode[])
    const pageInfo = asRecord(connection.pageInfo)
    hasNextPage = pageInfo?.hasNextPage === true
    cursor = typeof pageInfo?.endCursor === 'string' ? pageInfo.endCursor : null
    page++
  }
  return comments
}

async function githubGql(
  env: WorkerEnv,
  token: string,
  query: string,
  variables: Record<string, unknown>,
  onRate: (rate: GitHubRateState) => Promise<void>,
): Promise<Record<string, unknown>> {
  const mutation = query.trimStart().startsWith('mutation')
  const secondaryCost = mutation ? 5 : 1
  const tokenHash = await hashToken(token)
  const primary = env.GITHUB_RATE_LIMIT.getByName(`primary:${tokenHash}`)
  const global = env.GITHUB_RATE_LIMIT.getByName(await globalCoordinatorName(env))
  const config = getRateConfig(env)
  const primaryResult = await primary.acquirePrimary(1, config.reserve)
  if (!primaryResult.allowed) {
    throw new GitHubRequestError(
      'GitHub API request budget is protected',
      429,
      primaryResult.retryAt,
    )
  }
  const globalResult = await global.acquireApiRequest(apiBudget(config, {
    protocol: 'graphql',
    secondaryCost,
    secondaryLimit: config.graphQlBudget,
    contentGenerating: mutation,
    mutation,
  }))
  if (!globalResult.allowed) {
    await primary.releasePrimary(1)
    throw new GitHubRequestError('GitHub API request budget is protected', 429, globalResult.retryAt)
  }
  const leaseId = globalResult.leaseId

  let response: Response
  try {
    response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'github-reader-worker',
      },
      body: JSON.stringify({ query, variables }),
    })
  } catch {
    await primary.releasePrimary(1)
    throw new GitHubRequestError('Unable to connect to GitHub API', 502)
  } finally {
    await releaseApiLease(global, leaseId)
  }

  const now = Date.now()
  const rate = rateStateFromResponse(response, now)
  await Promise.all([primary.updatePrimary(rate, 1), onRate(rate)])
  const envelope = await safeJson<GitHubGraphQlEnvelope>(response)
  const errorMessage = (envelope.errors || [])
    .map(error => error.message)
    .filter((message): message is string => !!message)
    .join('; ')
  const rateLimited = isRateLimited(response, envelope, rate)

  if (rateLimited) {
    const blockedUntil = rate.blockedUntil || rate.resetAt || now + 60_000
    if (blockedUntil > rate.blockedUntil) {
      await primary.updatePrimary({ ...rate, blockedUntil }, 0)
    }
    throw new GitHubRequestError('GitHub API rate limit exceeded', 429, blockedUntil, {
      ...rate,
      blockedUntil,
    })
  }
  if (!response.ok) {
    throw new GitHubRequestError(
      `GitHub API request failed (${response.status})`,
      response.status,
      rate.blockedUntil,
      rate,
    )
  }
  if (envelope.errors?.length) {
    throw new GitHubRequestError(errorMessage || 'GitHub GraphQL request failed', 502, 0, rate)
  }
  return asRecord(envelope.data) || {}
}

function isRestRateLimited(response: Response, rate: GitHubRateState): boolean {
  return response.status === 429
    || (response.status === 403 && (rate.blockedUntil > 0 || rate.remaining === 0))
}

function getRateConfig(env: WorkerEnv): {
  reserve: number
  graphQlBudget: number
  restBudget: number
  oauthBudget: number
  contentMinuteBudget: number
  contentHourBudget: number
  concurrencyLimit: number
  mutationSpacingMs: number
} {
  const reserve = parseSetting(env.RATE_LIMIT_RESERVE, 250, true)
  return {
    reserve,
    graphQlBudget: parseSetting(env.GRAPHQL_SECONDARY_BUDGET, 1000, false),
    restBudget: parseSetting(env.REST_SECONDARY_BUDGET, 450, false),
    oauthBudget: parseSetting(env.OAUTH_SECONDARY_BUDGET, 50, false),
    contentMinuteBudget: parseSetting(env.CONTENT_MINUTE_BUDGET, 60, false),
    contentHourBudget: parseSetting(env.CONTENT_HOUR_BUDGET, 400, false),
    concurrencyLimit: parseSetting(env.GITHUB_CONCURRENCY_LIMIT, 80, false),
    mutationSpacingMs: parseSetting(env.MUTATION_MIN_INTERVAL_MS, 1000, true),
  }
}

type RateConfig = ReturnType<typeof getRateConfig>

function apiBudget(
  config: RateConfig,
  request: Pick<
    ApiRequestBudget,
    'protocol' | 'secondaryCost' | 'secondaryLimit' | 'contentGenerating' | 'mutation'
  >,
): ApiRequestBudget {
  return {
    ...request,
    contentMinuteLimit: config.contentMinuteBudget,
    contentHourLimit: config.contentHourBudget,
    concurrencyLimit: config.concurrencyLimit,
    mutationSpacingMs: config.mutationSpacingMs,
    leaseTtlMs: API_REQUEST_LEASE_TTL_MS,
  }
}

function normalizedMethod(method: string | undefined): string {
  return String(method || 'GET').trim().toUpperCase()
}

function restSecondaryCost(method: string): number {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 1 : 5
}

function isContentGeneratingRestMethod(method: string): boolean {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)
}

async function releaseApiLease(
  coordinator: { releaseApiRequest(leaseId: string): Promise<void> },
  leaseId: string,
): Promise<void> {
  try {
    await coordinator.releaseApiRequest(leaseId)
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'GitHub API concurrency lease release failed',
      error: error instanceof Error ? error.message : String(error),
    }))
  }
}

function parseSetting(value: string | undefined, fallback: number, allowZero: boolean): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  if (!Number.isInteger(parsed)) return fallback
  if (allowZero ? parsed >= 0 : parsed > 0) return parsed
  return fallback
}

async function hashToken(token: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  return Array.from(new Uint8Array(hash).slice(0, 16))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function globalCoordinatorName(
  env: Pick<WorkerEnv, 'REPO_OWNER' | 'REPO_NAME'>,
): Promise<string> {
  return `api:global:${await hashToken(`${env.REPO_OWNER}/${env.REPO_NAME}`.toLowerCase())}`
}

function rateStateFromResponse(response: Response, now: number): GitHubRateState {
  const remaining = parseHeaderInteger(response.headers.get('x-ratelimit-remaining'))
  const limit = parseHeaderInteger(response.headers.get('x-ratelimit-limit'))
  const resetSeconds = parseHeaderInteger(response.headers.get('x-ratelimit-reset'))
  const retryAfterSeconds = parseHeaderInteger(response.headers.get('retry-after'))
  const resetAt = resetSeconds === null ? 0 : resetSeconds * 1000
  const blockedUntil = retryAfterSeconds === null ? 0 : now + retryAfterSeconds * 1000
  return { remaining, limit, resetAt, blockedUntil, updatedAt: now }
}

function isRateLimited(
  response: Response,
  envelope: GitHubGraphQlEnvelope,
  rate: GitHubRateState,
): boolean {
  if (response.status === 429) return true
  if (response.status === 403 && (rate.blockedUntil > 0 || rate.remaining === 0)) return true
  return (envelope.errors || []).some(error => {
    const message = `${error.type || ''} ${error.message || ''}`.toLowerCase()
    return message.includes('rate limit') || message.includes('secondary rate')
  })
}

function parseHeaderInteger(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    return {} as T
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
