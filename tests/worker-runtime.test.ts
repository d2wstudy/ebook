import { env, exports } from 'cloudflare:workers'
import { runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cacheObjectName } from '../worker/src/config'
import { DiscussionCache } from '../worker/src/discussion-cache'
import { githubGraphQl, githubRestRequest } from '../worker/src/github'
import { RateLimitCoordinator } from '../worker/src/rate-limit'
import type { ApiRequestBudget, WorkerEnv } from '../worker/src/types'

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

  it('does not expose the former authenticated GraphQL proxy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const response = await exports.default.fetch('https://worker.example/api/github/graphql', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer user-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: 'query { viewer { login } }', variables: {} }),
    })

    expect(response.status).toBe(404)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('coalesces concurrent cold reads and serves subsequent reads from SQLite', async () => {
    let requestCount = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
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

  it('accepts tokenless cache invalidation for an allowed document', async () => {
    const response = await exports.default.fetch('https://worker.example/api/cache/invalidate', {
      method: 'POST',
      headers: {
        Origin: 'https://d2wstudy.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ documentId: DOCUMENT_ID, categoryName: CATEGORY }),
    })
    expect(response.status).toBe(202)
  })

  it('rejects cache invalidation without a browser Origin', async () => {
    const response = await exports.default.fetch('https://worker.example/api/cache/invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: DOCUMENT_ID, categoryName: CATEGORY }),
    })
    expect(response.status).toBe(403)
  })

  it('exchanges a GitHub App authorization code into an encrypted session', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.url === 'https://github.com/login/oauth/access_token') {
        return Response.json({
          access_token: 'ghu_test',
          expires_in: 28_800,
          refresh_token: 'ghr_test',
          refresh_token_expires_in: 15_897_600,
          token_type: 'bearer',
        })
      }
      return fetch(input, init)
    })

    const response = await exports.default.fetch('https://worker.example/api/auth/exchange', {
      method: 'POST',
      headers: {
        Origin: 'https://d2wstudy.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: 'authorization-code',
        code_verifier: 'v'.repeat(43),
        redirect_uri: 'https://d2wstudy.github.io/ebook/',
      }),
    })
    const data = await response.json() as { access_token: string; session: string }
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(data.access_token).toBe('ghu_test')
    expect(data.session).toMatch(/^v1\./)

    const githubRequest = new Request(vi.mocked(globalThis.fetch).mock.calls[0][0])
    expect(githubRequest.url).toBe('https://github.com/login/oauth/access_token')
  })

  it('rotates an expiring GitHub App session without another authorization page', async () => {
    let oauthRequests = 0
    const oauthBodies: Array<Record<string, string>> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.url !== 'https://github.com/login/oauth/access_token') return fetch(input, init)
      oauthRequests++
      oauthBodies.push(Object.fromEntries(
        [...(await request.clone().formData()).entries()]
          .map(([key, value]) => [key, String(value)]),
      ))
      return Response.json(oauthRequests === 1 ? {
        access_token: 'ghu_old',
        expires_in: 1,
        refresh_token: 'ghr_old',
        refresh_token_expires_in: 15_897_600,
      } : {
        access_token: 'ghu_new',
        expires_in: 28_800,
        refresh_token: 'ghr_new',
        refresh_token_expires_in: 15_897_600,
      })
    })

    const exchange = await exports.default.fetch('https://worker.example/api/auth/exchange', {
      method: 'POST',
      headers: {
        Origin: 'https://d2wstudy.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: 'authorization-code',
        code_verifier: 'v'.repeat(43),
        redirect_uri: 'https://d2wstudy.github.io/ebook/',
      }),
    })
    const first = await exchange.json() as { session: string }
    const restored = await exports.default.fetch('https://worker.example/api/auth/session', {
      method: 'POST',
      headers: {
        Origin: 'https://d2wstudy.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session: first.session, force: true }),
    })
    const second = await restored.json() as { access_token: string; session: string }
    expect(second.access_token).toBe('ghu_new')
    expect(second.session).not.toBe(first.session)
    expect(oauthBodies[1].grant_type).toBe('refresh_token')
  })

  it('verifies GitHub webhook HMAC before invalidating cache', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'd2wstudy/ebook' },
      discussion: { title: DOCUMENT_ID, category: { name: CATEGORY } },
    })
    const signature = await webhookSignature(body, 'test-webhook-secret')
    const accepted = await exports.default.fetch('https://worker.example/api/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'discussion',
        'X-Hub-Signature-256': signature,
      },
      body,
    })
    expect(accepted.status).toBe(202)

    const rejected = await exports.default.fetch('https://worker.example/api/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'discussion',
        'X-Hub-Signature-256': 'sha256=' + '00'.repeat(32),
      },
      body,
    })
    expect(rejected.status).toBe(401)
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

async function webhookSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(body),
  ))
  return `sha256=${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`
}
