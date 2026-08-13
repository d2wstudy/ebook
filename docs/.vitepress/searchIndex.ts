import { bookPages, pageContent, type BookPage } from './bookContent'

interface SearchSection {
  anchor?: string
  titles: string[]
  text: string
}

export interface SearchMarkdownRenderer {
  render(source: string, env?: Record<string, unknown>): string
}

const headingRegex = /<h(\d*).*?>(.*?<a.*? href="#.*?".*?>.*?<\/a>)<\/h\1>/gi
const headingContentRegex = /(.*?)<a.*? href="#(.*?)".*?>.*?<\/a>/i

/**
 * Tokenize both indexed fields and browser queries with the same multilingual
 * rules. VitePress serializes this function into the client search bundle, so
 * it must remain self-contained and must not close over module state.
 */
export function tokenizeSearchText(text: string): string[] {
  const normalized = text.normalize('NFKC')
  const fallback = () => normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)

  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
    return fallback()
  }

  try {
    const cache = globalThis as typeof globalThis & {
      __ebookSearchSegmenter?: Intl.Segmenter
    }
    const segmenter = cache.__ebookSearchSegmenter ||= new Intl.Segmenter(
      ['zh-CN', 'en'],
      { granularity: 'word' },
    )
    return [...segmenter.segment(normalized)]
      .filter(part => part.isWordLike)
      .map(part => part.segment)
  } catch {
    return fallback()
  }
}

/**
 * Normalize terms and add Han-character subterms. The subterms make queries
 * resilient to small ICU segmentation differences between Node.js (build)
 * and the reader's browser without switching to a much larger n-gram index.
 */
export function processSearchTerm(term: string): string | string[] | null {
  const normalized = term.normalize('NFKC').toLowerCase().trim()
  if (!normalized) return null

  const hanCharacters = [...normalized].filter(character => /\p{Script=Han}/u.test(character))
  if (hanCharacters.length <= 1) return normalized
  return [...new Set([normalized, ...hanCharacters])]
}

/**
 * VitePress 1.x reads source files from disk while building its local index.
 * Dynamic route pages have no physical Markdown file, so provide their
 * sections directly from the discovered bilingual book content.
 */
export function splitBookSearchSections(
  file: string,
  html: string,
  markdown?: SearchMarkdownRenderer,
): SearchSection[] {
  const page = findBookPage(file)
  if (!page) return splitRenderedPageIntoSections(html)

  if (markdown) {
    const rendered = markdown.render(pageContent(page), {
      path: file,
      relativePath: chapterRelativePath(page),
      cleanUrls: false,
    })
    const sections = splitRenderedPageIntoSections(rendered)
    if (sections.length) return sections
  }

  return [{
    anchor: slugifyHeading(page.title) || undefined,
    titles: [page.title],
    text: bookPageSearchText(page),
  }]
}

function chapterRelativePath(page: BookPage): string {
  return `chapters/${page.slug}.md`
}

function bookPageSearchText(page: BookPage): string {
  return page.languages
    .flatMap(language => {
      const source = page.sources[language]
      if (!source) return []
      return [
        source.title,
        source.sidebarTitle,
        markdownToSearchText(source.body),
      ]
    })
    .filter(Boolean)
    .join('\n')
}

function findBookPage(file: string): BookPage | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = '/chapters/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex < 0 || !normalized.endsWith('.md')) return undefined

  const rawSlug = normalized.slice(markerIndex + marker.length, -3)
  let slug = rawSlug
  try {
    slug = decodeURIComponent(rawSlug)
  } catch {
    // The route may legitimately contain a literal percent sign.
  }
  return bookPages.find(page => page.slug === slug)
}

function markdownToSearchText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, ' $1 ')
    .replace(/~~~[^\n]*\n([\s\S]*?)~~~/g, ' $1 ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*:{3,}.*$/gm, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[`*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function slugifyHeading(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036F]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

/** Preserve VitePress's normal indexing behavior for physical Markdown pages. */
export function splitRenderedPageIntoSections(html: string): SearchSection[] {
  const result = html.split(headingRegex)
  result.shift()
  const sections: SearchSection[] = []
  let parentTitles: string[] = []

  for (let index = 0; index < result.length; index += 3) {
    const level = Number.parseInt(result[index], 10) - 1
    const heading = result[index + 1]
    const headingResult = headingContentRegex.exec(heading)
    const title = clearHtmlTags(headingResult?.[1] || '').trim()
    const anchor = headingResult?.[2] || ''
    const content = result[index + 2]
    if (!title || !content) continue

    let titles = parentTitles.slice(0, level)
    titles[level] = title
    titles = titles.filter(Boolean)
    sections.push({ anchor, titles, text: clearHtmlTags(content) })

    if (level === 0) parentTitles = [title]
    else parentTitles[level] = title
  }

  return sections
}

function clearHtmlTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}
