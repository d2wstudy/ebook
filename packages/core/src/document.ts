import type { ReaderConfig } from './types'

/** Normalize a deployed site base to one leading and trailing slash. */
export function normalizeBase(base: string): string {
  const trimmed = base.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`
}

/**
 * Build a stable document key from a static-site route.
 *
 * The default implementation preserves the existing VitePress/GitHub Pages
 * convention, but applications may provide a frontmatter-backed resolver
 * through their DocumentAdapter instead.
 */
export function canonicalDocumentPath(path: string, base = '/'): string {
  let cleanPath = path.split(/[?#]/, 1)[0] || '/'

  if (/^https?:\/\//i.test(cleanPath)) {
    try {
      cleanPath = new URL(cleanPath).pathname
    } catch {
      cleanPath = '/'
    }
  }

  if (!cleanPath.startsWith('/')) cleanPath = `/${cleanPath}`
  cleanPath = cleanPath.replace(/\/{2,}/g, '/')

  const normalizedBase = normalizeBase(base)
  if (normalizedBase !== '/') {
    const baseWithoutTrailingSlash = normalizedBase.slice(0, -1)
    if (cleanPath === baseWithoutTrailingSlash) {
      cleanPath = normalizedBase
    } else if (!cleanPath.startsWith(normalizedBase)) {
      cleanPath = `${baseWithoutTrailingSlash}${cleanPath}`
    }
  }

  if (cleanPath.endsWith('/')) cleanPath += 'index'

  const lastSegment = cleanPath.slice(cleanPath.lastIndexOf('/') + 1)
  if (!lastSegment.includes('.')) cleanPath += '.html'

  return cleanPath
}

export function discussionStorageKey(projectId: string, category: string, documentId: string): string {
  return `github-reader::${projectId}::discussion::${category}::${documentId}`
}

export function defineReaderConfig<const T extends ReaderConfig>(config: T): Readonly<T> {
  return config
}
