import { describe, expect, it } from 'vitest'
import { encodeAnnotationBody } from '@github-reader/core'
import { parseAnnotation } from '../docs/.vitepress/theme/composables/useAnnotations'
import { mapReactions } from '../docs/.vitepress/theme/composables/useDiscussionThread'

function rawComment(body: unknown) {
  return {
    id: 'comment-1',
    body: JSON.stringify(body),
    author: { login: 'reader', avatarUrl: '' },
    createdAt: '2026-01-01T00:00:00Z',
    replies: { nodes: [] },
    reactionGroups: [],
  }
}

function rawCommentBody(body: string) {
  return { ...rawComment({}), body }
}

describe('annotation payload validation', () => {
  it('accepts legacy annotations without a language field', () => {
    const parsed = parseAnnotation(rawComment({
      type: 'annotation',
      paragraphId: '_1-1-reinforcement-learning-p0',
      startOffset: 46,
      endOffset: 50,
      selectedText: '四处张望',
      note: '看啥啊',
    }))

    expect(parsed?.anchor.language).toBeUndefined()
    expect(parsed?.anchor.selectedText).toBe('四处张望')
  })

  it('rejects malformed or unbounded anchors from public comments', () => {
    expect(parseAnnotation(rawComment({
      type: 'annotation',
      paragraphId: '',
      startOffset: -1,
      endOffset: 2,
      selectedText: 'bad',
    }))).toBeNull()

    expect(parseAnnotation(rawComment({
      type: 'annotation',
      paragraphId: 'p1',
      startOffset: 1,
      endOffset: 2,
      selectedText: 'x',
      segments: Array.from({ length: 129 }, () => ({
        paragraphId: 'p1',
        startOffset: 1,
        endOffset: 2,
        selectedText: 'x',
      })),
    }))).toBeNull()
  })

  it('reads v3 Markdown bodies and rejects another document namespace', () => {
    const body = encodeAnnotationBody({
      documentId: '/book/chapter-1.html',
      anchor: {
        paragraphId: 'p1',
        startOffset: 0,
        endOffset: 4,
        selectedText: '新格式',
        prefix: '',
        suffix: '',
        language: 'zh',
      },
      note: 'GitHub 中可直接阅读的笔记',
    })

    expect(parseAnnotation(rawCommentBody(body), '/book/chapter-1.html')?.note)
      .toBe('GitHub 中可直接阅读的笔记')
    expect(parseAnnotation(rawCommentBody(body), '/book/chapter-2.html')).toBeNull()
  })
})

describe('GitHub reactions', () => {
  it('keeps GitHub CONFUSED reactions in canonical order', () => {
    const mapped = mapReactions([
      { content: 'HEART', reactors: { totalCount: 1 } },
      { content: 'CONFUSED', reactors: { totalCount: 2 } },
      { content: 'LAUGH', reactors: { totalCount: 3 } },
    ])

    expect(mapped.map(item => item.content)).toEqual(['LAUGH', 'CONFUSED', 'HEART'])
  })
})
