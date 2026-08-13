import { describe, expect, it } from 'vitest'
import {
  defaultAllowedDocumentIds,
  validateDiscussionParams,
} from '../worker/src/validation'

function workerUrl(params: Record<string, string>) {
  const url = new URL('https://worker.example/api/discussions')
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return url
}

describe('Worker request validation', () => {
  it('accepts generated project pages and rejects unrelated or unknown paths', () => {
    expect(validateDiscussionParams(workerUrl({
      path: '/ebook/chapters/01-introduction.html',
      category: 'Ideas',
    }), {
      documentPathPrefix: '/ebook/',
      allowedCategories: new Set(['Ideas', 'Announcements', 'General']),
      allowedDocumentIds: defaultAllowedDocumentIds(),
    })).toMatchObject({
      pagePath: '/ebook/chapters/01-introduction.html',
      categoryName: 'Ideas',
    })

    expect(validateDiscussionParams(workerUrl({
      path: '/another-project/page.html',
      category: 'Ideas',
    }), {
      documentPathPrefix: '/ebook/',
      allowedCategories: new Set(['Ideas']),
      allowedDocumentIds: defaultAllowedDocumentIds(),
    })).toMatchObject({ error: 'Invalid path', status: 400 })

    expect(validateDiscussionParams(workerUrl({
      path: '/ebook/chapters/not-built.html',
      category: 'Ideas',
    }), {
      documentPathPrefix: '/ebook/',
      allowedCategories: new Set(['Ideas']),
      allowedDocumentIds: defaultAllowedDocumentIds(),
    })).toMatchObject({ error: 'Unknown document', status: 404 })
  })

  it('does not weaken the generated document whitelist for another deployment prefix', () => {
    expect(validateDiscussionParams(workerUrl({
      path: '/another-book/chapter.html',
      category: 'Annotations',
    }), {
      documentPathPrefix: '/another-book/',
      allowedCategories: new Set(['Annotations', 'General']),
      allowedDocumentIds: defaultAllowedDocumentIds(),
    })).toMatchObject({ error: 'Unknown document', status: 404 })
  })

  it('rejects invalid categories and untrusted known IDs', () => {
    const config = {
      documentPathPrefix: '/ebook/',
      allowedCategories: new Set(['Ideas', 'Announcements', 'General']),
      allowedDocumentIds: defaultAllowedDocumentIds(),
    }
    expect(validateDiscussionParams(workerUrl({
      path: '/ebook/index.html',
      category: 'Notes',
    }), config)).toMatchObject({ error: 'Invalid category', status: 400 })

    expect(validateDiscussionParams(workerUrl({
      path: '/ebook/index.html',
      category: 'Ideas',
      id: 'bad\nvalue',
    }), config)).toMatchObject({ error: 'Invalid discussion id', status: 400 })
  })
})
