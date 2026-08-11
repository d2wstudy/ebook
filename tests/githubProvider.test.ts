import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGitHubDiscussionProvider } from '@github-reader/github'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub Discussion provider', () => {
  it('reads through the configured Worker and normalizes GitHub nodes', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://reader-worker.example')
      expect(url.searchParams.get('path')).toBe('/book/chapter.html')
      expect(url.searchParams.get('category')).toBe('Notes')
      return Response.json({
        discussion: { id: 'D1', url: 'https://github.test/d/1', number: 1, category: 'Notes' },
        comments: [{
          id: 'C1',
          body: 'hello',
          author: { login: 'reader', avatarUrl: 'avatar' },
          createdAt: '2026-01-01T00:00:00Z',
          replies: { nodes: [] },
          reactionGroups: [{
            content: 'HEART',
            viewerHasReacted: true,
            reactors: { totalCount: 2 },
          }],
        }],
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = createGitHubDiscussionProvider({
      owner: 'owner',
      repo: 'repo',
      workerUrl: 'https://reader-worker.example/',
    }, { getToken: () => null, invalidate: vi.fn() })

    const result = await provider.findDiscussion('/book/chapter.html', 'Notes')
    expect(result.comments[0]).toMatchObject({
      id: 'C1',
      author: 'reader',
      authorAvatar: 'avatar',
      reactions: [{ content: 'HEART', count: 2, viewerHasReacted: true }],
      replies: [],
    })
  })

  it('uses deployment configuration when creating a Discussion', async () => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }
      requests.push(request)

      if (request.query.includes('discussionCategories')) {
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

    const provider = createGitHubDiscussionProvider({
      owner: 'another-owner',
      repo: 'another-book',
      workerUrl: 'https://reader-worker.example',
      graphqlUrl: 'https://graphql.example',
    }, { getToken: () => 'token', invalidate: vi.fn() })

    await provider.createDiscussion('/another-book/chapter.html', 'Notes', 'Reader notes')

    expect(requests[0].variables).toEqual({ owner: 'another-owner', name: 'another-book' })
    expect(requests[1].variables).toMatchObject({
      repoId: 'R1',
      categoryId: 'CAT1',
      title: '/another-book/chapter.html',
      body: 'Reader notes',
    })
  })
})
