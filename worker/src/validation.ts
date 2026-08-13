import { VALID_DOCUMENT_IDS } from '../generated/document-ids'

export interface ValidationConfig {
  documentPathPrefix: string
  allowedCategories: Set<string>
  allowedDocumentIds: Set<string>
}

export interface DiscussionParams {
  pagePath: string
  categoryName: string
  knownId: string | null
}

export function validateDiscussionParams(
  url: URL,
  config: ValidationConfig,
): DiscussionParams | { error: string; status: number } {
  const pagePath = url.searchParams.get('path')
  const categoryName = url.searchParams.get('category')
  const knownId = url.searchParams.get('id')

  if (!pagePath || !categoryName) return { error: 'Missing path or category', status: 400 }
  if (!isSafePagePath(pagePath, config.documentPathPrefix)) {
    return { error: 'Invalid path', status: 400 }
  }
  if (!config.allowedDocumentIds.has(pagePath)) {
    return { error: 'Unknown document', status: 404 }
  }
  if (!config.allowedCategories.has(categoryName)) {
    return { error: 'Invalid category', status: 400 }
  }
  if (knownId && (knownId.length > 200 || /[\r\n]/.test(knownId))) {
    return { error: 'Invalid discussion id', status: 400 }
  }
  return { pagePath, categoryName, knownId }
}

export function defaultAllowedDocumentIds(): Set<string> {
  return new Set(VALID_DOCUMENT_IDS)
}

function isSafePagePath(pagePath: string, prefix: string): boolean {
  const pathSegments = pagePath.split('/')
  return pagePath.length <= 400
    && pagePath.startsWith(prefix)
    && pagePath.endsWith('.html')
    && !pagePath.includes('\\')
    && !pagePath.includes('//')
    && !pathSegments.includes('..')
    && !/[\r\n]/.test(pagePath)
}
