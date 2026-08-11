import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { bookConfig } from '../../book.config'

export interface LocalizedBookSource {
  language: string
  title: string
  sidebarTitle: string
  group: string
  order: number
  body: string
  file: string
}

export interface BookPage {
  slug: string
  title: string
  sidebarTitle: string
  group: string
  order: number
  languages: readonly string[]
  sources: Readonly<Record<string, LocalizedBookSource>>
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const contentRoot = resolve(projectRoot, bookConfig.contentDir)
const languageDirectoryPattern = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*$/

function isDirectory(entry: Dirent): boolean {
  return entry.isDirectory() || (entry.isSymbolicLink() && statSync(resolve(contentRoot, entry.name)).isDirectory())
}

interface LanguageDirectory {
  directory: string
  language: string
}

function languageDirectories(): LanguageDirectory[] {
  if (!statSafe(contentRoot)?.isDirectory()) return []
  return readdirSync(contentRoot, { withFileTypes: true })
    .filter(entry => isDirectory(entry) && languageDirectoryPattern.test(entry.name))
    .map(entry => ({
      directory: entry.name,
      language: entry.name.replaceAll('_', '-'),
    }))
    .sort((left, right) => left.language.localeCompare(right.language))
}

function statSafe(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function markdownFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true })
  return entries.flatMap(entry => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return extname(entry.name).toLowerCase() === '.md' ? [path] : []
  })
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

function parseMarkdownFile(
  file: string,
  language: string,
  languageRoot: string,
): LocalizedBookSource & { slug: string } {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  const metadata = (match ? parse(match[1]) : {}) as Record<string, unknown>
  const body = (match ? raw.slice(match[0].length) : raw).trim()
  const relativeFile = normalizePath(relative(languageRoot, file))
  const inferredSlug = relativeFile
    .replace(/^chapters\//, '')
    .replace(/\.md$/i, '')
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim()
  const title = stringValue(metadata.title) || heading || inferredSlug

  return {
    language,
    title,
    sidebarTitle: stringValue(metadata.sidebar) || title,
    group: stringValue(metadata.group) || '内容',
    order: numberValue(metadata.order) ?? 0,
    body,
    file,
    slug: stringValue(metadata.slug) || inferredSlug,
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function removeLeadingTitle(body: string, title: string): string {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return body
    .replace(new RegExp(`^\\s*#\\s+${escapedTitle}\\s*(?:\\r?\\n)+`, 'i'), '')
    .trim()
}

function discoverPages(): BookPage[] {
  const bySlug = new Map<string, {
    sources: Record<string, LocalizedBookSource>
    sidebarTitle: string
    group: string
    order: number
  }>()

  for (const languageDirectory of languageDirectories()) {
    const { language } = languageDirectory
    const directory = resolve(contentRoot, languageDirectory.directory)
    for (const file of markdownFiles(directory)) {
      const source = parseMarkdownFile(file, language, directory)
      const existing = bySlug.get(source.slug) || {
        sources: {},
        sidebarTitle: source.sidebarTitle,
        group: source.group,
        order: source.order,
      }
      existing.sources[language] = source
      if (existing.sidebarTitle === '内容') existing.sidebarTitle = source.sidebarTitle
      if (existing.group === '内容') existing.group = source.group
      if (existing.order === 0) existing.order = source.order
      bySlug.set(source.slug, existing)
    }
  }

  return [...bySlug.entries()]
    .map(([slug, value]) => {
      const languages = Object.keys(value.sources).sort((left, right) => left.localeCompare(right))
      const preferred = value.sources[bookConfig.defaultLanguage || ''] || value.sources[languages[0]]
      return {
        slug,
        title: preferred.title,
        sidebarTitle: preferred.sidebarTitle,
        group: preferred.group,
        order: preferred.order,
        languages,
        sources: value.sources,
      }
    })
    .sort((left, right) => left.group.localeCompare(right.group) || left.order - right.order || left.slug.localeCompare(right.slug))
}

export const bookPages: readonly BookPage[] = discoverPages()

export const bookLanguages: readonly string[] = [...new Set(bookPages.flatMap(page => page.languages))]

export function languageLabel(language: string): string {
  const names = bookConfig.languageNames as Record<string, string> | undefined
  return names?.[language] || language
}

export function pageContent(page: BookPage): string {
  const preferred = page.sources[bookConfig.defaultLanguage || ''] || page.sources[page.languages[0]]
  if (!preferred) return ''

  const lines = [
    '---',
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(`${page.title} - ${bookConfig.title}`)}`,
    '---',
    '',
    `# ${page.title}`,
    '',
  ]

  for (const language of page.languages) {
    const source = page.sources[language]
    if (!source) continue
    lines.push(`:::: reader-language-${language}${language === preferred.language ? ' default' : ''}`)
    lines.push(removeLeadingTitle(source.body, source.title))
    lines.push('::::')
    lines.push('')
  }

  return lines.join('\n')
}

export function chapterPages(group: string): readonly BookPage[] {
  return bookPages.filter(page => page.group === group)
}

export const bookGroups: readonly string[] = [...new Set(bookPages.map(page => page.group))]
