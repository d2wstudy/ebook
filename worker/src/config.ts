import type { WorkerEnv } from './types'
import {
  defaultAllowedDocumentIds,
  validateDiscussionParams as validateParams,
} from './validation'
import type { DiscussionParams } from './validation'

const DEFAULT_REPO_OWNER = 'example'
const DEFAULT_REPO_NAME = 'reader-template'
const DEFAULT_DOCUMENT_PATH_PREFIX = '/reader-template/'
const DEFAULT_DISCUSSION_CATEGORIES = ['Ideas', 'Announcements', 'General']

export interface WorkerConfig {
  repoOwner: string
  repoName: string
  documentPathPrefix: string
  allowedCategories: Set<string>
  allowedDocumentIds: Set<string>
  freshTtlMs: number
  staleTtlMs: number
  rateLimitReserve: number
  graphQlSecondaryBudget: number
  restSecondaryBudget: number
  oauthSecondaryBudget: number
  contentMinuteBudget: number
  contentHourBudget: number
  githubConcurrencyLimit: number
  mutationMinIntervalMs: number
}

export function getWorkerConfig(env: Partial<WorkerEnv> = {}): WorkerConfig {
  const freshTtlSeconds = readPositiveInteger(env.CACHE_FRESH_TTL, 600)
  const staleTtlSeconds = Math.max(
    freshTtlSeconds,
    readPositiveInteger(env.CACHE_STALE_TTL, 86400),
  )
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
    allowedDocumentIds: defaultAllowedDocumentIds(),
    freshTtlMs: freshTtlSeconds * 1000,
    staleTtlMs: staleTtlSeconds * 1000,
    rateLimitReserve: readNonNegativeInteger(env.RATE_LIMIT_RESERVE, 250),
    graphQlSecondaryBudget: readPositiveInteger(env.GRAPHQL_SECONDARY_BUDGET, 1000),
    restSecondaryBudget: readPositiveInteger(env.REST_SECONDARY_BUDGET, 450),
    oauthSecondaryBudget: readPositiveInteger(env.OAUTH_SECONDARY_BUDGET, 50),
    contentMinuteBudget: readPositiveInteger(env.CONTENT_MINUTE_BUDGET, 60),
    contentHourBudget: readPositiveInteger(env.CONTENT_HOUR_BUDGET, 400),
    githubConcurrencyLimit: readPositiveInteger(env.GITHUB_CONCURRENCY_LIMIT, 80),
    mutationMinIntervalMs: readNonNegativeInteger(env.MUTATION_MIN_INTERVAL_MS, 1000),
  }
}

export function validateDiscussionParams(
  url: URL,
  configOrEnv: WorkerConfig | Partial<WorkerEnv> = {},
): DiscussionParams | { error: string; status: number } {
  const config = isWorkerConfig(configOrEnv) ? configOrEnv : getWorkerConfig(configOrEnv)
  return validateParams(url, config)
}

export function cacheObjectName(pagePath: string, categoryName: string): string {
  return `${categoryName}\n${pagePath}`
}

export function allowedOrigins(env: Partial<WorkerEnv>): Set<string> {
  return new Set(readCommaSeparated(env.ALLOWED_ORIGINS, [
    'https://example.github.io',
    'http://localhost:15689',
    'http://127.0.0.1:15689',
  ]))
}

function isWorkerConfig(value: WorkerConfig | Partial<WorkerEnv>): value is WorkerConfig {
  return 'allowedCategories' in value
    && value.allowedCategories instanceof Set
    && 'allowedDocumentIds' in value
    && value.allowedDocumentIds instanceof Set
}

function readSetting(value: string | undefined, fallback: string): string {
  const configured = String(value || '').trim()
  return configured || fallback
}

function readCommaSeparated(value: string | undefined, fallback: readonly string[]): string[] {
  const configured = String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return configured.length ? configured : [...fallback]
}

function normalizePathPrefix(value: string): string {
  const clean = `/${String(value).trim().replace(/^\/+|\/+$/g, '')}/`
  return clean === '//' ? '/' : clean
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
