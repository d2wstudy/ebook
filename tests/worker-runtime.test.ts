import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cacheObjectName } from '../worker/src/config'
import { DiscussionCache } from '../worker/src/discussion-cache'
import { githubGraphQl, githubRestRequest } from '../worker/src/github'
import { RateLimitCoordinator } from '../worker/src/rate-limit'
import type { ApiRequestBudget, WorkerEnv } from '../worker/src/types'
import { invalidateMutationCacheSafely } from '../worker/src/index'

const DOCUMENT_ID = '/ebook/chapters/01-introduction.html'
const CATEGORY = 'Ideas'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Worker HTTP guardrails', () => {
  it('rejects unknown documents before any GitHub request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await exports.default.fetch(
      'https://worker.example/api/discussions?path=/ebook/chapters/unknown.html&category=Ideas',
    )

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects arbitrary authenticated GraphQL before any GitHub request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await exports.default.fetch('https://worker.example/api/github/graphql', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'query { viewer { login } }', variables: {} }),
    })

    expect(response.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('coalesces concurrent cold reads and serves subsequent reads from SQLite', async () => {
    let requestCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const request = new Request(input)
      expect(request.url).toBe('https://api.github.com/graphql')
      requestCount++
      await Promise.resolve()
      return graphQlResponse({
        search: {
          nodes: [],
        },
      })
    })

    const url = discussionUrl()
    const [first, second] = await Promise.all([
      exports.default.fetch(url),
      exports.default.fetch(url),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(requestCount).toBe(1)
    expect([first.headers.get('X-Cache'), second.headers.get('X-Cache')]).toEqual([
      'MISS',
      'MISS',
    ])

    const cached = await exports.default.fetch(url)
    expect(cached.status).toBe(200)
    expect(cached.headers.get('X-Cache')).toBe('HIT')
    expect(requestCount).toBe(1)

    const stub = env.DISCUSSION_CACHE.getByName(cacheObjectName(DOCUMENT_ID, CATEGORY))
    await runInDurableObject(stub, (instance, state) => {
      expect(instance).toBeInstanceOf(DiscussionCache)
      const row = state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM discussion_cache',
      ).one()
      expect(row.count).toBe(1)
    })
  })

  it('serves stale SQLite content when refresh is rate-limited', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(graphQlResponse({
      search: { nodes: [] },
    }))
    const url = discussionUrl()
    expect((await exports.default.fetch(url)).status).toBe(200)

    const stub = env.DISCUSSION_CACHE.getByName(cacheObjectName(DOCUMENT_ID, CATEGORY))
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE discussion_cache SET fresh_until = 0 WHERE id = 1')
    })

    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({
      message: 'secondary rate limit',
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '60',
        'X-RateLimit-Remaining': '1000',
        'X-RateLimit-Limit': '5000',
        'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
      },
    }))

    const stale = await exports.default.fetch(url)
    expect(stale.status).toBe(200)
    expect(stale.headers.get('X-Cache')).toBe('STALE')
  })

  it('swallows cache invalidation errors after a successful mutation', async () => {
    const failingNamespace = new Proxy(env.DISCUSSION_CACHE, {
      get(target, property, receiver) {
        if (property === 'getByName') {
          return () => ({
            invalidate: () => Promise.reject(new Error('invalidation failed')),
          })
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const failingEnv = { ...env, DISCUSSION_CACHE: failingNamespace }

    await expect(invalidateMutationCacheSafely(
      failingEnv,
      'user-token',
      { documentId: DOCUMENT_ID, categoryName: CATEGORY },
    )).resolves.toBeUndefined()
  })
})

describe('RateLimitCoordinator', () => {
  it('protects the primary reserve and allows requests after a new reset window', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`primary:test-${crypto.randomUUID()}`)
    const now = Date.now()
    await stub.updatePrimary({
      remaining: 250,
      limit: 5000,
      resetAt: now + 60_000,
      blockedUntil: 0,
      updatedAt: now,
    }, 0)
    expect(await stub.acquirePrimary(1, 250)).toMatchObject({ allowed: false })

    await stub.updatePrimary({
      remaining: 5000,
      limit: 5000,
      resetAt: now + 120_000,
      blockedUntil: 0,
      updatedAt: now + 1,
    }, 0)
    expect(await stub.acquirePrimary(1, 250)).toMatchObject({ allowed: true })
  })

  it('does not let an older response increase remaining quota in the same window', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`primary:ordered-${crypto.randomUUID()}`)
    const resetAt = Date.now() + 60_000
    await stub.updatePrimary({
      remaining: 100,
      limit: 5000,
      resetAt,
      blockedUntil: 0,
      updatedAt: 200,
    }, 0)
    await stub.updatePrimary({
      remaining: 900,
      limit: 5000,
      resetAt,
      blockedUntil: 0,
      updatedAt: 100,
    }, 0)

    expect(await stub.acquirePrimary(101, 0)).toMatchObject({ allowed: false })
  })

  it('enforces independent rolling windows', async () => {
    const graphQl = env.GITHUB_RATE_LIMIT.getByName(`window:gql-${crypto.randomUUID()}`)
    const rest = env.GITHUB_RATE_LIMIT.getByName(`window:rest-${crypto.randomUUID()}`)

    expect(await graphQl.consumeRollingWindow('graphql', 5, 5, 60_000)).toMatchObject({ allowed: true })
    expect(await graphQl.consumeRollingWindow('graphql', 1, 5, 60_000)).toMatchObject({ allowed: false })
    expect(await rest.consumeRollingWindow('rest', 1, 1, 60_000)).toMatchObject({ allowed: true })
  })

  it('shares concurrency leases across REST and GraphQL requests', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`api:concurrency-${crypto.randomUUID()}`)
    const rest = apiBudget({ protocol: 'rest', concurrencyLimit: 1 })
    const graphQl = apiBudget({ protocol: 'graphql', concurrencyLimit: 1 })

    const first = await stub.acquireApiRequest(rest)
    expect(first).toMatchObject({ allowed: true })
    expect(await stub.acquireApiRequest(graphQl)).toMatchObject({ allowed: false })
    if (!first.allowed) throw new Error('Expected an acquired API lease')
    await stub.releaseApiRequest(first.leaseId)
    expect(await stub.acquireApiRequest(graphQl)).toMatchObject({ allowed: true })
  })

  it('atomically enforces shared content budgets without consuming secondary points on rejection', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`api:content-${crypto.randomUUID()}`)
    const mutation = apiBudget({
      protocol: 'graphql',
      secondaryCost: 5,
      secondaryLimit: 10,
      contentGenerating: true,
      mutation: true,
      contentMinuteLimit: 1,
      contentHourLimit: 1,
      mutationSpacingMs: 0,
    })

    const first = await stub.acquireApiRequest(mutation)
    expect(first).toMatchObject({ allowed: true })
    if (!first.allowed) throw new Error('Expected an acquired mutation lease')
    await stub.releaseApiRequest(first.leaseId)
    expect(await stub.acquireApiRequest(mutation)).toMatchObject({ allowed: false })

    const query = apiBudget({
      protocol: 'graphql',
      secondaryCost: 5,
      secondaryLimit: 10,
    })
    const queryResult = await stub.acquireApiRequest(query)
    expect(queryResult).toMatchObject({ allowed: true })
  })

  it('rejects mutations inside the configured spacing interval', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`api:spacing-${crypto.randomUUID()}`)
    const mutation = apiBudget({
      protocol: 'graphql',
      contentGenerating: true,
      mutation: true,
      mutationSpacingMs: 60_000,
    })
    const first = await stub.acquireApiRequest(mutation)
    expect(first).toMatchObject({ allowed: true })
    if (!first.allowed) throw new Error('Expected an acquired mutation lease')
    await stub.releaseApiRequest(first.leaseId)
    const second = await stub.acquireApiRequest(mutation)
    expect(second).toMatchObject({ allowed: false })
    expect(second.retryAt).toBeGreaterThan(Date.now())
  })

  it('returns the latest retry time when multiple guards reject a request', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`api:retry-${crypto.randomUUID()}`)
    const mutation = apiBudget({
      protocol: 'graphql',
      contentGenerating: true,
      mutation: true,
      contentMinuteLimit: 1,
      contentHourLimit: 1,
      mutationSpacingMs: 1000,
    })
    const first = await stub.acquireApiRequest(mutation)
    if (!first.allowed) throw new Error('Expected an acquired mutation lease')
    await stub.releaseApiRequest(first.leaseId)

    const rejected = await stub.acquireApiRequest(mutation)
    expect(rejected).toMatchObject({ allowed: false })
    expect(rejected.retryAt).toBeGreaterThan(Date.now() + 50 * 60 * 1000)
  })

  it('persists coordinator state in SQLite', async () => {
    const stub = env.GITHUB_RATE_LIMIT.getByName(`primary:sqlite-${crypto.randomUUID()}`)
    await stub.updatePrimary({
      remaining: 10,
      limit: 5000,
      resetAt: Date.now() + 60_000,
      blockedUntil: 0,
      updatedAt: Date.now(),
    }, 0)

    await runInDurableObject(stub, (instance, state) => {
      expect(instance).toBeInstanceOf(RateLimitCoordinator)
      expect(state.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM primary_budget',
      ).one().count).toBe(1)
    })
  })
})

describe('GitHub request budgeting', () => {
  it('charges REST DELETE as five secondary points and content generation', async () => {
    const rateEnv = workerEnv({
      REST_SECONDARY_BUDGET: '5',
      CONTENT_MINUTE_BUDGET: '1',
      CONTENT_HOUR_BUDGET: '1',
      MUTATION_MIN_INTERVAL_MS: '60000',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(restResponse(204))

    expect((await githubRestRequest(
      rateEnv,
      'delete-token',
      'https://api.github.com/applications/test/grant',
      { method: 'DELETE' },
    )).status).toBe(204)
    await expect(githubRestRequest(
      rateEnv,
      'delete-token',
      'https://api.github.com/applications/test/grant',
      { method: 'DELETE' },
    )).rejects.toMatchObject({ status: 429 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('shares the mutative spacing guard between REST and GraphQL', async () => {
    const rateEnv = workerEnv({
      MUTATION_MIN_INTERVAL_MS: '60000',
      CONTENT_MINUTE_BUDGET: '60',
      CONTENT_HOUR_BUDGET: '400',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(restResponse(204))
    await expect(githubRestRequest(
      rateEnv,
      'rest-mutation-token',
      'https://api.github.com/applications/test/grant',
      { method: 'DELETE' },
    )).resolves.toMatchObject({ status: 204 })

    const mutation = `mutation($subjectId: ID!) {
      addReaction(input: { subjectId: $subjectId, content: HEART }) { reaction { content } }
    }`
    await expect(githubGraphQl(rateEnv, 'graphql-mutation-token', mutation, { subjectId: 'a' }))
      .rejects.toMatchObject({ status: 429 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('shares the mutation spacing guard across tokens', async () => {
    const rateEnv = workerEnv({
      MUTATION_MIN_INTERVAL_MS: '60000',
      CONTENT_MINUTE_BUDGET: '60',
      CONTENT_HOUR_BUDGET: '400',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(graphQlResponse({
      addReaction: { reaction: { content: 'HEART' } },
    }))
    const mutation = `mutation($subjectId: ID!) {
      addReaction(input: { subjectId: $subjectId, content: HEART }) { reaction { content } }
    }`

    await expect(githubGraphQl(rateEnv, 'mutation-token-a', mutation, { subjectId: 'a' }))
      .resolves.toMatchObject({ addReaction: { reaction: { content: 'HEART' } } })
    await expect(githubGraphQl(rateEnv, 'mutation-token-b', mutation, { subjectId: 'b' }))
      .rejects.toMatchObject({ status: 429 })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })
})

function discussionUrl(): string {
  const url = new URL('https://worker.example/api/discussions')
  url.searchParams.set('path', DOCUMENT_ID)
  url.searchParams.set('category', CATEGORY)
  return url.toString()
}

function graphQlResponse(data: Record<string, unknown>): Response {
  return Response.json({ data }, {
    headers: {
      'X-RateLimit-Remaining': '4999',
      'X-RateLimit-Limit': '5000',
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  })
}

function restResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      'X-RateLimit-Remaining': '4999',
      'X-RateLimit-Limit': '5000',
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 3600),
    },
  })
}

function apiBudget(overrides: Partial<ApiRequestBudget> = {}): ApiRequestBudget {
  return {
    protocol: 'graphql',
    secondaryCost: 1,
    secondaryLimit: 1000,
    contentGenerating: false,
    mutation: false,
    contentMinuteLimit: 60,
    contentHourLimit: 400,
    concurrencyLimit: 80,
    mutationSpacingMs: 1000,
    leaseTtlMs: 30_000,
    ...overrides,
  }
}

function workerEnv(overrides: Record<string, string>): WorkerEnv {
  const rateEnv: WorkerEnv = {
    ...env,
    ...overrides,
  }
  Object.defineProperty(rateEnv, 'REPO_NAME', {
    value: `test-${crypto.randomUUID()}`,
    enumerable: true,
    configurable: true,
  })
  return rateEnv
}
