import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitHubDiscussionProvider } from '@github-reader/github'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub Discussion provider', () => {
  it('reads shared data without sending the user token to the Worker', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://reader-worker.example')
      expect(url.searchParams.get('path')).toBe('/book/chapter.html')
      expect(url.searchParams.get('category')).toBe('Notes')
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return Response.json({
        discussion: { id: 'D1', url: 'https://github.test/d/1', number: 1, category: 'Notes' },
        comments: [commentNode(false)],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = providerWithToken(null)
    const result = await provider.findDiscussion('/book/chapter.html', 'Notes')
    expect(result.comments[0]).toMatchObject({
      id: 'C1',
      author: 'reader',
      reactions: [{ content: 'HEART', count: 2, viewerHasReacted: false }],
    })
  })

  it('overlays viewerHasReacted through a browser-to-GitHub query', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, authorization: headers.get('Authorization') })
      if (url.startsWith('https://reader-worker.example/api/discussions')) {
        return Response.json({ discussion: null, comments: [commentNode(false)] })
      }
      return Response.json({ data: {
        nodes: [{ id: 'C1', reactionGroups: [{ content: 'HEART', viewerHasReacted: true }] }],
      } })
    }))

    const result = await providerWithToken('user-token').findDiscussion('/book/chapter.html', 'Notes')
    expect(result.comments[0].reactions[0].viewerHasReacted).toBe(true)
    expect(requests).toEqual([
      { url: expect.stringContaining('https://reader-worker.example/api/discussions'), authorization: null },
      { url: 'https://api.github.com/graphql', authorization: 'Bearer user-token' },
    ])
  })

  it('uses the tokenless invalidation endpoint for an explicit refresh', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input))
      if (String(input).endsWith('/api/cache/invalidate')) {
        return Response.json({ ok: true }, { status: 202 })
      }
      return Response.json({ discussion: null, comments: [] })
    }))

    await providerWithToken(null).findDiscussion('/book/chapter.html', 'Notes', null, true)
    expect(urls).toEqual([
      'https://reader-worker.example/api/cache/invalidate',
      expect.stringContaining('https://reader-worker.example/api/discussions'),
    ])
    expect(urls[1]).not.toContain('force=')
  })

  it('refreshes once on 401 and retries the browser GraphQL request', async () => {
    let token = 'expired-token'
    const refresh = vi.fn(async () => {
      token = 'fresh-token'
      return token
    })
    const authorizations: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('Authorization'))
      if (authorizations.length === 1) return Response.json({}, { status: 401 })
      return Response.json({ data: {
        repository: {
          id: 'R1',
          discussionCategories: { nodes: [{ id: 'CAT1', name: 'Notes' }] },
        },
      } })
    }))

    const provider = createGitHubDiscussionProvider(config(), {
      getToken: () => token,
      refresh,
    })
    await provider.createDiscussion('/book/chapter.html', 'Notes', 'body').catch(() => {})
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(authorizations.slice(0, 2)).toEqual(['Bearer expired-token', 'Bearer fresh-token'])
  })

  it('uses direct GitHub GraphQL and sends a tokenless invalidation after mutation', async () => {
    const requests: Array<{ url: string; body: any; authorization: string | null }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      const request = {
        url: String(input),
        body,
        authorization: new Headers(init?.headers).get('Authorization'),
      }
      requests.push(request)
      if (request.url.endsWith('/api/cache/invalidate')) return Response.json({ ok: true }, { status: 202 })
      if (body.query.includes('discussionCategories')) {
        return Response.json({ data: {
          repository: {
            id: 'R1',
            discussionCategories: { nodes: [{ id: 'CAT1', name: 'Notes' }] },
          },
        } })
      }
      return Response.json({ data: {
        createDiscussion: {
          discussion: {
            id: 'D1',
            url: 'https://github.test/d/1',
            number: 1,
            category: { name: 'Notes' },
          },
        },
      } })
    }))

    const provider = providerWithToken('token')
    await provider.createDiscussion('/book/chapter.html', 'Notes', 'Reader notes')
    await vi.waitFor(() => expect(requests).toHaveLength(3))

    expect(requests[0]).toMatchObject({
      url: 'https://api.github.com/graphql',
      authorization: 'Bearer token',
      body: { variables: { owner: 'owner', name: 'repo' } },
    })
    expect(requests[1].url).toBe('https://api.github.com/graphql')
    expect(requests[2]).toMatchObject({
      url: 'https://reader-worker.example/api/cache/invalidate',
      authorization: null,
      body: {
        documentId: '/book/chapter.html',
        categoryName: 'Notes',
        dropCache: true,
      },
    })
  })

  it('does not turn a successful GitHub mutation into failure when invalidation fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/cache/invalidate')) throw new Error('offline')
      const body = JSON.parse(String(init?.body))
      return Response.json({ data: body.query.includes('discussionCategories') ? {
        repository: { id: 'R1', discussionCategories: { nodes: [{ id: 'CAT1', name: 'Notes' }] } },
      } : {
        createDiscussion: {
          discussion: { id: 'D1', url: 'url', number: 1, category: { name: 'Notes' } },
        },
      } })
    }))

    await expect(providerWithToken('token').createDiscussion('/book/chapter.html', 'Notes', 'body'))
      .resolves.toMatchObject({ id: 'D1' })
  })
})

function config() {
  return { owner: 'owner', repo: 'repo', workerUrl: 'https://reader-worker.example' }
}

function providerWithToken(token: string | null) {
  return createGitHubDiscussionProvider(config(), {
    getToken: () => token,
    refresh: async () => token,
  })
}

function commentNode(viewerHasReacted: boolean) {
  return {
    id: 'C1',
    body: 'hello',
    author: { login: 'reader', avatarUrl: 'avatar' },
    createdAt: '2026-01-01T00:00:00Z',
    replies: { nodes: [] },
    reactionGroups: [{
      content: 'HEART',
      viewerHasReacted,
      reactors: { totalCount: 2 },
    }],
  }
}
