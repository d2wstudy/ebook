import { DurableObject } from 'cloudflare:workers'
import { getWorkerConfig } from './config'
import { fetchDiscussion, GitHubRequestError } from './github'
import { publicReadToken } from './github-app'
import type {
  CacheReadResult,
  CacheRecord,
  CacheResponse,
  DiscussionResult,
  GitHubCommentNode,
  InvalidateRequest,
  ReadRequest,
  WorkerEnv,
} from './types'

type DiscussionCacheRow = Record<string, SqlStorageValue> & {
  page_path: string
  category_name: string
  result_json: string
  fetched_at: number
  fresh_until: number
  stale_until: number
}

export class DiscussionCache extends DurableObject<WorkerEnv> {
  private refreshPromise: Promise<CacheRecord> | null = null

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS discussion_cache (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          page_path TEXT NOT NULL,
          category_name TEXT NOT NULL,
          result_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          fresh_until INTEGER NOT NULL,
          stale_until INTEGER NOT NULL
        );
        DROP TABLE IF EXISTS reaction_cache;
      `)
    })
  }

  async read(request: ReadRequest): Promise<CacheReadResult> {
    try {
      return { ok: true, response: await this.readDiscussion(request) }
    } catch (error) {
      return { ok: false, error: serializeError(error) }
    }
  }

  async invalidate(request: InvalidateRequest): Promise<{ invalidated: boolean }> {
    if (request.drop) {
      this.ctx.storage.sql.exec('DELETE FROM discussion_cache WHERE id = 1')
    } else {
      this.ctx.storage.sql.exec('UPDATE discussion_cache SET fresh_until = 0 WHERE id = 1')
    }
    return { invalidated: true }
  }

  private async readDiscussion(request: ReadRequest): Promise<CacheResponse> {
    const requestedAt = Date.now()
    let record = this.readCacheRecord()
    let cacheStatus: CacheResponse['cacheStatus'] = 'HIT'

    if (!record || record.freshUntil <= requestedAt) {
      try {
        record = await this.refresh(request, record)
        cacheStatus = 'MISS'
      } catch (error) {
        if (!record || record.staleUntil <= requestedAt) throw error
        cacheStatus = 'STALE'
        log('warn', 'serving stale discussion cache', {
          pagePath: request.pagePath,
          categoryName: request.categoryName,
          error: errorMessage(error),
        })
      }
    }

    const result = structuredClone(record.result)
    stripViewerReactions(result.comments)
    return {
      result,
      cacheStatus,
      ageSeconds: Math.max(0, Math.floor((Date.now() - record.fetchedAt) / 1000)),
    }
  }

  private async refresh(request: ReadRequest, stale: CacheRecord | undefined): Promise<CacheRecord> {
    if (this.refreshPromise) return this.refreshPromise
    const promise = this.doRefresh(request, stale)
    this.refreshPromise = promise
    try {
      return await promise
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = null
    }
  }

  private async doRefresh(request: ReadRequest, stale: CacheRecord | undefined): Promise<CacheRecord> {
    const token = await publicReadToken(this.env)
    if (!token) {
      if (stale) throw new GitHubRequestError('GitHub API credentials are unavailable', 503)
      const empty = createCacheRecord(
        request.pagePath,
        request.categoryName,
        { discussion: null, comments: [] },
        Date.now(),
        getWorkerConfig(this.env),
      )
      this.writeCacheRecord(empty)
      return empty
    }

    const pagePath = request.pagePath || stale?.pagePath || ''
    const categoryName = request.categoryName || stale?.categoryName || ''
    if (!pagePath || !categoryName) {
      throw new GitHubRequestError('Missing refresh identity', 500)
    }

    const result = await fetchDiscussion(
      this.env,
      token,
      pagePath,
      categoryName,
      request.knownId || stale?.result.discussion?.id || null,
      async () => {},
    )
    const record = createCacheRecord(
      pagePath,
      categoryName,
      toSharedResult(result),
      Date.now(),
      getWorkerConfig(this.env),
    )
    this.writeCacheRecord(record)
    log('info', 'discussion cache refreshed', {
      pagePath,
      categoryName,
      comments: result.comments.length,
    })
    return record
  }

  private readCacheRecord(): CacheRecord | undefined {
    const row = this.ctx.storage.sql.exec<DiscussionCacheRow>(`
      SELECT page_path, category_name, result_json, fetched_at, fresh_until, stale_until
      FROM discussion_cache WHERE id = 1
    `).toArray()[0]
    if (!row) return undefined

    try {
      return {
        pagePath: row.page_path,
        categoryName: row.category_name,
        result: JSON.parse(row.result_json) as DiscussionResult,
        fetchedAt: row.fetched_at,
        freshUntil: row.fresh_until,
        staleUntil: row.stale_until,
      }
    } catch (error) {
      this.ctx.storage.sql.exec('DELETE FROM discussion_cache WHERE id = 1')
      log('error', 'discarded corrupt discussion cache', { error: errorMessage(error) })
      return undefined
    }
  }

  private writeCacheRecord(record: CacheRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO discussion_cache (
        id, page_path, category_name, result_json, fetched_at, fresh_until, stale_until
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        page_path = excluded.page_path,
        category_name = excluded.category_name,
        result_json = excluded.result_json,
        fetched_at = excluded.fetched_at,
        fresh_until = excluded.fresh_until,
        stale_until = excluded.stale_until`,
      record.pagePath,
      record.categoryName,
      JSON.stringify(record.result),
      record.fetchedAt,
      record.freshUntil,
      record.staleUntil,
    )
  }
}

function createCacheRecord(
  pagePath: string,
  categoryName: string,
  result: DiscussionResult,
  now: number,
  config: ReturnType<typeof getWorkerConfig>,
): CacheRecord {
  return {
    pagePath,
    categoryName,
    result,
    fetchedAt: now,
    freshUntil: now + config.freshTtlMs,
    staleUntil: now + config.staleTtlMs,
  }
}

function toSharedResult(result: DiscussionResult): DiscussionResult {
  const shared = structuredClone(result)
  stripViewerReactions(shared.comments)
  return shared
}

function stripViewerReactions(comments: GitHubCommentNode[]): void {
  for (const comment of comments) {
    for (const group of comment.reactionGroups || []) group.viewerHasReacted = false
    for (const reply of comment.replies?.nodes || []) {
      for (const group of reply.reactionGroups || []) group.viewerHasReacted = false
    }
  }
}

function serializeError(error: unknown): {
  message: string
  status: number
  blockedUntil: number
} {
  if (error instanceof GitHubRequestError) {
    return {
      message: error.message,
      status: error.status,
      blockedUntil: error.blockedUntil,
    }
  }
  return { message: errorMessage(error), status: 502, blockedUntil: 0 }
}

function log(level: 'info' | 'warn' | 'error', message: string, data: Record<string, unknown>): void {
  const output = JSON.stringify({ level, message, ...data })
  if (level === 'error') console.error(output)
  else if (level === 'warn') console.warn(output)
  else console.log(output)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
