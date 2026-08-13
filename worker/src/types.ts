export interface WorkerSecrets {
  GITHUB_PAT?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GITHUB_CLIENT_ID_DEV?: string
  GITHUB_CLIENT_SECRET_DEV?: string
}

export type WorkerEnv = Env & WorkerSecrets

export interface DiscussionMeta {
  id: string
  url: string
  number: number
  category: string
}

export interface DiscussionResult {
  discussion: DiscussionMeta | null
  comments: GitHubCommentNode[]
}

export interface GitHubReactionGroup {
  content: string
  viewerHasReacted: boolean
  reactors?: { totalCount?: number }
}

export interface GitHubCommentNode {
  id: string
  body: string
  createdAt: string
  lastEditedAt?: string | null
  url: string
  authorAssociation?: string
  author?: { login?: string; avatarUrl?: string } | null
  reactionGroups?: GitHubReactionGroup[]
  replies?: {
    totalCount?: number
    nodes?: GitHubCommentNode[]
  }
}

export type UserReactionMap = Record<string, Record<string, boolean>>

export interface ReadRequest {
  pagePath: string
  categoryName: string
  knownId: string | null
  userToken: string | null
  force: boolean
}

export interface InvalidateRequest {
  userToken: string | null
  shared: boolean
  drop: boolean
}

export interface CacheResponse {
  result: DiscussionResult
  cacheStatus: 'HIT' | 'MISS' | 'STALE'
  ageSeconds: number
}

export interface CacheReadSuccess {
  ok: true
  response: CacheResponse
}

export interface CacheReadFailure {
  ok: false
  error: {
    message: string
    status: number
    blockedUntil: number
  }
}

export type CacheReadResult = CacheReadSuccess | CacheReadFailure

export interface GitHubRateState {
  remaining: number | null
  limit: number | null
  resetAt: number
  blockedUntil: number
  updatedAt: number
}

export interface CacheRecord {
  pagePath: string
  categoryName: string
  result: DiscussionResult
  fetchedAt: number
  freshUntil: number
  staleUntil: number
}

export interface RateAcquireResult {
  allowed: boolean
  retryAt: number
}

export interface ApiRequestBudget {
  protocol: 'graphql' | 'rest'
  secondaryCost: number
  secondaryLimit: number
  contentGenerating: boolean
  mutation: boolean
  contentMinuteLimit: number
  contentHourLimit: number
  concurrencyLimit: number
  mutationSpacingMs: number
  leaseTtlMs: number
}

export type ApiRequestAcquireResult =
  | { allowed: true; retryAt: 0; leaseId: string }
  | { allowed: false; retryAt: number; leaseId: null }

export interface ReactionRecord {
  reactions: UserReactionMap
  expiresAt: number
}
