import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  processSearchTerm,
  splitBookSearchSections,
  tokenizeSearchText,
} from '../docs/.vitepress/searchIndex'

describe('automatic local search index', () => {
  it('indexes every language of a dynamic chapter', () => {
    const sections = splitBookSearchSections(
      resolve('docs/chapters/01-introduction.md'),
      '',
    )

    expect(sections).toHaveLength(1)
    expect(sections[0]).toMatchObject({
      anchor: '引言',
      titles: ['引言'],
    })
    expect(sections[0].text).toContain('This is a placeholder page')
    expect(sections[0].text).toContain('构建器会自动发现')
    expect(sections[0].text).not.toContain('::: notes')
  })

  it('tokenizes Chinese and English search text', () => {
    const tokens = tokenizeSearchText('自动发现 Markdown content')

    expect(tokens).toEqual(expect.arrayContaining(['自动', '发现', 'Markdown', 'content']))
    expect(processSearchTerm('中文')).toEqual(expect.arrayContaining(['中文', '中', '文']))
    expect(processSearchTerm('VitePress')).toBe('vitepress')
  })

  it('keeps normal indexing for physical Markdown pages', () => {
    const sections = splitBookSearchSections(
      resolve('docs/other.md'),
      '<h1 id="example" tabindex="-1">Example <a class="header-anchor" href="#example">#</a></h1><p>Searchable text.</p>',
    )

    expect(sections).toEqual([{
      anchor: 'example',
      titles: ['Example'],
      text: 'Searchable text.',
    }])
  })
})
