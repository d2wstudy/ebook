import {
  canonicalDocumentPath,
  discussionStorageKey as createDiscussionStorageKey,
  normalizeBase,
  type DiscussionMeta,
  type DiscussionThreadResult,
} from '@github-reader/core'
import { readerConfig, type ReaderLanguage } from '../readerConfig'

export const REPO_OWNER = readerConfig.github.owner
export const REPO_NAME = readerConfig.github.repo
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`
export const WORKER_URL = readerConfig.github.workerUrl

export const ANNOTATION_CATEGORY = readerConfig.discussions.annotationCategory
export const LEGACY_COMMENT_CATEGORY = readerConfig.discussions.commentReadCategories[0]
export const COMMENT_CATEGORY = readerConfig.discussions.commentCreateCategory

export type AnnotationLanguage = ReaderLanguage
export type { DiscussionMeta, DiscussionThreadResult }

/**
 * Build one environment-independent Discussion title for a VitePress route.
 *
 * Existing production threads use the GitHub Pages base path and `.html`, while
 * the dev server usually exposes extension-less routes. Canonicalizing both
 * forms prevents duplicate Discussions between development and production.
 */
export function canonicalPagePath(path: string, base = readerConfig.document.base): string {
  return canonicalDocumentPath(path, base)
}

export { normalizeBase }

export function discussionStorageKey(category: string, pagePath: string): string {
  return createDiscussionStorageKey(readerConfig.projectId, category, pagePath)
}
