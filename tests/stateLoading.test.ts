import { beforeEach, describe, expect, it, vi } from 'vitest'

const githubMocks = vi.hoisted(() => ({
  findDiscussionWithComments: vi.fn(),
}))

vi.mock('../docs/.vitepress/theme/composables/useGithubGql', () => ({
  addDiscussionComment: vi.fn(),
  addDiscussionReply: vi.fn(),
  createDiscussion: vi.fn(),
  deleteDiscussionComment: vi.fn(),
  findDiscussionWithComments: githubMocks.findDiscussionWithComments,
  updateDiscussionComment: vi.fn(),
}))

import { useAnnotations } from '../docs/.vitepress/theme/composables/useAnnotations'
import { useComments } from '../docs/.vitepress/theme/composables/useComments'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('repeated loading', () => {
  beforeEach(() => {
    githubMocks.findDiscussionWithComments.mockReset()
  })

  it('settles comments when the same page requests an in-flight load twice', async () => {
    const request = deferred<{ discussion: null; comments: unknown[] }>()
    githubMocks.findDiscussionWithComments.mockReturnValue(request.promise)
    const state = useComments()

    const first = state.loadComments('/chapters/01-introduction')
    const second = state.loadComments('/chapters/01-introduction')
    request.resolve({ discussion: null, comments: [] })
    await Promise.all([first, second])

    expect(state.loading.value).toBe(false)
    expect(state.loaded.value).toBe(true)
  })

  it('settles annotations when the same page requests an in-flight load twice', async () => {
    const request = deferred<{ discussion: null; comments: unknown[] }>()
    githubMocks.findDiscussionWithComments.mockReturnValue(request.promise)
    const state = useAnnotations()

    const first = state.loadAnnotations('/chapters/01-introduction')
    const second = state.loadAnnotations('/chapters/01-introduction')
    request.resolve({ discussion: null, comments: [] })
    await Promise.all([first, second])

    expect(state.loading.value).toBe(false)
    expect(state.loaded.value).toBe(true)
  })
})
