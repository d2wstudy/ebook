import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_NOTE_MARKER,
  decodeAnnotationBody,
  encodeAnnotationBody,
  type AnnotationAnchor,
} from '@github-reader/core'

const anchor: AnnotationAnchor<'zh' | 'en'> = {
  paragraphId: 'chapter-1-p0',
  startOffset: 3,
  endOffset: 7,
  selectedText: '阅读模板',
  prefix: '理解',
  suffix: '的基础',
  language: 'zh',
}

describe('annotation codec', () => {
  it('reads schema v1 annotations without a language', () => {
    const decoded = decodeAnnotationBody(JSON.stringify({
      type: 'annotation',
      paragraphId: 'legacy-p0',
      startOffset: 0,
      endOffset: 4,
      selectedText: '旧笔记',
      note: '仍然可读',
    }))

    expect(decoded).toMatchObject({
      schemaVersion: 1,
      anchor: { paragraphId: 'legacy-p0', selectedText: '旧笔记' },
      note: '仍然可读',
    })
    expect(decoded?.anchor.language).toBeUndefined()
  })

  it('round-trips schema v2 JSON with cross-block segments', () => {
    const second = { ...anchor, paragraphId: 'chapter-1-p1', startOffset: 0, endOffset: 4 }
    const body = encodeAnnotationBody({ anchor, segments: [anchor, second], note: '跨段' }, 'legacy-json')
    const decoded = decodeAnnotationBody(body)

    expect(decoded?.schemaVersion).toBe(2)
    expect(decoded?.segments).toEqual([anchor, second])
    expect(decoded?.note).toBe('跨段')
  })

  it('writes readable schema v3 Markdown and preserves Unicode metadata', () => {
    const body = encodeAnnotationBody({
      documentId: '/book/chapter-1.html',
      anchor,
      note: '这里支持 **Markdown** 与 emoji 🚀',
    })

    expect(body).toMatch(/^<!-- github-reader-annotation:v3:/)
    expect(body).toContain('> 阅读模板')
    expect(body).toContain(ANNOTATION_NOTE_MARKER)
    expect(body).toContain('这里支持 **Markdown** 与 emoji 🚀')
    expect(decodeAnnotationBody(body)).toEqual({
      schemaVersion: 3,
      documentId: '/book/chapter-1.html',
      anchor,
      note: '这里支持 **Markdown** 与 emoji 🚀',
    })
  })
})
