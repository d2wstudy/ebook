import { describe, expect, it } from 'vitest'
import { canonicalPagePath, normalizeBase } from '../docs/.vitepress/theme/composables/discussionConfig'

describe('canonicalPagePath', () => {
  it('normalizes dev routes to production discussion titles', () => {
    expect(canonicalPagePath('/chapters/01-introduction', '/reader-template/'))
      .toBe('/reader-template/chapters/01-introduction.html')
  })

  it('keeps an existing base path and html extension', () => {
    expect(canonicalPagePath('/reader-template/chapters/01-introduction.html', '/reader-template/'))
      .toBe('/reader-template/chapters/01-introduction.html')
  })

  it('normalizes the site root', () => {
    expect(canonicalPagePath('/', '/reader-template/'))
      .toBe('/reader-template/index.html')
  })

  it('normalizes a base path without its trailing slash', () => {
    expect(canonicalPagePath('/reader-template', '/reader-template/'))
      .toBe('/reader-template/index.html')
  })

  it('accepts absolute URLs', () => {
    expect(canonicalPagePath('https://example.com/chapters/ch01?x=1', '/book/'))
      .toBe('/book/chapters/ch01.html')
  })

  it('falls back safely for malformed absolute URLs', () => {
    expect(canonicalPagePath('https://', '/book/')).toBe('/book/index.html')
  })
})

describe('normalizeBase', () => {
  it('normalizes slashes', () => {
    expect(normalizeBase('reader-template')).toBe('/reader-template/')
    expect(normalizeBase('/')).toBe('/')
  })
})
