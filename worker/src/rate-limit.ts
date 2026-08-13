import { DurableObject } from 'cloudflare:workers'
import type {
  ApiRequestAcquireResult,
  ApiRequestBudget,
  GitHubRateState,
  RateAcquireResult,
  WorkerEnv,
} from './types'

type PrimaryBudgetRow = Record<string, SqlStorageValue> & {
  remaining: number | null
  limit_value: number | null
  reset_at: number
  blocked_until: number
  pending: number
  pending_until: number
  updated_at: number
}

type RollingWindowRow = Record<string, SqlStorageValue> & {
  event_id: number
  occurred_at: number
  cost: number
}

type LeaseRow = Record<string, SqlStorageValue> & {
  expires_at: number
}

type MutationRow = Record<string, SqlStorageValue> & {
  last_started_at: number
}

export class RateLimitCoordinator extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS primary_budget (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          remaining INTEGER,
          limit_value INTEGER,
          reset_at INTEGER NOT NULL,
          blocked_until INTEGER NOT NULL,
          pending INTEGER NOT NULL,
          pending_until INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rolling_window (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          window_name TEXT NOT NULL,
          occurred_at INTEGER NOT NULL,
          cost INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rolling_window_name_time
          ON rolling_window(window_name, occurred_at, event_id);
        CREATE TABLE IF NOT EXISTS api_request_lease (
          lease_id TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_request_lease_expires_at
          ON api_request_lease(expires_at);
        CREATE TABLE IF NOT EXISTS mutation_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          last_started_at INTEGER NOT NULL
        );
      `)
    })
  }

  async acquirePrimary(cost: number, reserve: number): Promise<RateAcquireResult> {
    requirePositiveInteger(cost, 'primary cost')
    requireNonNegativeInteger(reserve, 'primary reserve')
    const now = Date.now()
    const current = this.primaryRow()
    let remaining = current?.remaining ?? null
    let resetAt = current?.reset_at || 0
    let blockedUntil = current?.blocked_until || 0
    let pending = current?.pending || 0

    if (resetAt && resetAt <= now) {
      remaining = null
      resetAt = 0
      blockedUntil = 0
      pending = 0
    }
    if ((current?.pending_until || 0) <= now) pending = 0
    if (blockedUntil > now) return { allowed: false, retryAt: blockedUntil }
    if (remaining !== null && resetAt > now && remaining - pending - cost < reserve) {
      return { allowed: false, retryAt: resetAt }
    }

    this.writePrimary({
      remaining,
      limit_value: current?.limit_value ?? null,
      reset_at: resetAt,
      blocked_until: blockedUntil,
      pending: pending + cost,
      pending_until: now + 30_000,
      updated_at: current?.updated_at || now,
    })
    return { allowed: true, retryAt: 0 }
  }

  async updatePrimary(rate: GitHubRateState, reservedCost: number): Promise<void> {
    requireNonNegativeInteger(reservedCost, 'reserved primary cost')
    const current = this.primaryRow()
    const sameWindow = !!current
      && current.reset_at > 0
      && rate.resetAt > 0
      && current.reset_at === rate.resetAt
    const staleWindow = !!current
      && current.reset_at > 0
      && rate.resetAt > 0
      && rate.resetAt < current.reset_at
    const remaining = staleWindow
      ? current.remaining
      : sameWindow
        ? minimumNullable(current.remaining, rate.remaining)
        : rate.remaining ?? current?.remaining ?? null
    const limit = staleWindow
      ? current.limit_value
      : rate.limit ?? current?.limit_value ?? null
    const resetAt = staleWindow
      ? current.reset_at
      : rate.resetAt || current?.reset_at || 0
    const blockedUntil = rate.updatedAt >= (current?.updated_at || 0)
      ? Math.max(rate.blockedUntil, current?.blocked_until || 0)
      : current?.blocked_until || 0
    this.writePrimary({
      remaining,
      limit_value: limit,
      reset_at: resetAt,
      blocked_until: blockedUntil,
      pending: Math.max(0, (current?.pending || 0) - reservedCost),
      pending_until: current?.pending_until || 0,
      updated_at: Math.max(rate.updatedAt, current?.updated_at || 0),
    })
  }

  async releasePrimary(reservedCost: number): Promise<void> {
    requireNonNegativeInteger(reservedCost, 'reserved primary cost')
    const current = this.primaryRow()
    if (!current) return
    this.writePrimary({
      ...current,
      pending: Math.max(0, current.pending - reservedCost),
    })
  }

  async consumeRollingWindow(
    windowName: string,
    cost: number,
    limit: number,
    windowMs: number,
  ): Promise<RateAcquireResult> {
    const now = Date.now()
    const checked = this.checkRollingWindow(windowName, cost, limit, windowMs, now)
    if (!checked.allowed) return checked
    this.recordWindowEvent(windowName, now, cost)
    return { allowed: true, retryAt: 0 }
  }

  async acquireApiRequest(budget: ApiRequestBudget): Promise<ApiRequestAcquireResult> {
    validateApiBudget(budget)
    const now = Date.now()
    const windows = [
      {
        name: `secondary:${budget.protocol}`,
        cost: budget.secondaryCost,
        limit: budget.secondaryLimit,
        windowMs: 60_000,
      },
      ...(budget.contentGenerating
        ? [
            {
              name: 'content:minute',
              cost: 1,
              limit: budget.contentMinuteLimit,
              windowMs: 60_000,
            },
            {
              name: 'content:hour',
              cost: 1,
              limit: budget.contentHourLimit,
              windowMs: 60 * 60 * 1000,
            },
          ]
        : []),
    ]
    const retryAt: number[] = []

    for (const window of windows) {
      const checked = this.checkRollingWindow(
        window.name,
        window.cost,
        window.limit,
        window.windowMs,
        now,
      )
      if (!checked.allowed) retryAt.push(checked.retryAt)
    }

    this.ctx.storage.sql.exec('DELETE FROM api_request_lease WHERE expires_at <= ?', now)
    const activeLeases = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM api_request_lease',
    ).one().count
    if (activeLeases >= budget.concurrencyLimit) {
      const earliest = this.ctx.storage.sql.exec<LeaseRow>(
        'SELECT expires_at FROM api_request_lease ORDER BY expires_at LIMIT 1',
      ).toArray()[0]
      retryAt.push(earliest?.expires_at || now + budget.leaseTtlMs)
    }

    if (budget.mutation && budget.mutationSpacingMs > 0) {
      const mutation = this.ctx.storage.sql.exec<MutationRow>(
        'SELECT last_started_at FROM mutation_state WHERE id = 1',
      ).toArray()[0]
      const nextMutationAt = (mutation?.last_started_at || 0) + budget.mutationSpacingMs
      if (nextMutationAt > now) retryAt.push(nextMutationAt)
    }

    if (retryAt.length) {
      return {
        allowed: false,
        retryAt: Math.max(...retryAt),
        leaseId: null,
      }
    }

    for (const window of windows) {
      this.recordWindowEvent(window.name, now, window.cost)
    }
    if (budget.mutation) {
      this.ctx.storage.sql.exec(
        `INSERT INTO mutation_state (id, last_started_at) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET last_started_at = excluded.last_started_at`,
        now,
      )
    }

    const leaseId = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO api_request_lease (lease_id, expires_at) VALUES (?, ?)',
      leaseId,
      now + budget.leaseTtlMs,
    )
    return { allowed: true, retryAt: 0, leaseId }
  }

  async releaseApiRequest(leaseId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'DELETE FROM api_request_lease WHERE lease_id = ?',
      leaseId,
    )
  }

  private primaryRow(): PrimaryBudgetRow | undefined {
    return this.ctx.storage.sql.exec<PrimaryBudgetRow>(`
      SELECT remaining, limit_value, reset_at, blocked_until, pending, pending_until, updated_at
      FROM primary_budget WHERE id = 1
    `).toArray()[0]
  }

  private writePrimary(row: PrimaryBudgetRow): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO primary_budget (
        id, remaining, limit_value, reset_at, blocked_until, pending, pending_until, updated_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        remaining = excluded.remaining,
        limit_value = excluded.limit_value,
        reset_at = excluded.reset_at,
        blocked_until = excluded.blocked_until,
        pending = excluded.pending,
        pending_until = excluded.pending_until,
        updated_at = excluded.updated_at`,
      row.remaining,
      row.limit_value,
      row.reset_at,
      row.blocked_until,
      row.pending,
      row.pending_until,
      row.updated_at,
    )
  }

  private checkRollingWindow(
    windowName: string,
    cost: number,
    limit: number,
    windowMs: number,
    now: number,
  ): RateAcquireResult {
    if (
      !windowName
      || !Number.isSafeInteger(cost)
      || cost <= 0
      || !Number.isSafeInteger(limit)
      || limit <= 0
      || !Number.isSafeInteger(windowMs)
      || windowMs <= 0
    ) {
      throw new RangeError('Invalid rolling-window configuration')
    }

    const cutoff = now - windowMs
    this.ctx.storage.sql.exec(
      'DELETE FROM rolling_window WHERE window_name = ? AND occurred_at <= ?',
      windowName,
      cutoff,
    )
    const events = this.ctx.storage.sql.exec<RollingWindowRow>(
      `SELECT event_id, occurred_at, cost
       FROM rolling_window
       WHERE window_name = ?
       ORDER BY occurred_at, event_id`,
      windowName,
    ).toArray()
    const used = events.reduce((total, event) => total + event.cost, 0)
    if (used + cost <= limit) return { allowed: true, retryAt: 0 }

    let expiringCost = 0
    const required = used + cost - limit
    for (const event of events) {
      expiringCost += event.cost
      if (expiringCost >= required) {
        return {
          allowed: false,
          retryAt: Math.max(now + 1, event.occurred_at + windowMs + 1),
        }
      }
    }
    return { allowed: false, retryAt: now + windowMs }
  }

  private recordWindowEvent(windowName: string, occurredAt: number, cost: number): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO rolling_window (window_name, occurred_at, cost) VALUES (?, ?, ?)',
      windowName,
      occurredAt,
      cost,
    )
  }
}

function minimumNullable(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.min(left, right)
}

function validateApiBudget(budget: ApiRequestBudget): void {
  requirePositiveInteger(budget.secondaryCost, 'secondary cost')
  requirePositiveInteger(budget.secondaryLimit, 'secondary limit')
  requirePositiveInteger(budget.contentMinuteLimit, 'content minute limit')
  requirePositiveInteger(budget.contentHourLimit, 'content hour limit')
  requirePositiveInteger(budget.concurrencyLimit, 'concurrency limit')
  requireNonNegativeInteger(budget.mutationSpacingMs, 'mutation spacing')
  requirePositiveInteger(budget.leaseTtlMs, 'lease TTL')
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Invalid ${name}`)
  }
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid ${name}`)
  }
}
