import { defineReaderConfig } from '@github-reader/core'
import { bookConfig } from '../../../book.config'

/** Language identifiers are discovered from content directory names at build time. */
export type ReaderLanguage = string

export const readerConfig = defineReaderConfig({
  projectId: bookConfig.id,
  document: {
    base: import.meta.env.BASE_URL,
    rootSelector: '.vp-doc',
    blockSelector: '[data-reader-block]',
    readyEvent: 'github-reader:document-ready',
  },
  language: {
    defaultLanguage: bookConfig.defaultLanguage || '',
    names: bookConfig.languageNames || {},
  },
  github: {
    owner: import.meta.env.VITE_GITHUB_REPO_OWNER || bookConfig.github.owner,
    repo: import.meta.env.VITE_GITHUB_REPO_NAME || bookConfig.github.repo,
    workerUrl: (
      import.meta.env.VITE_WORKER_URL || bookConfig.github.workerUrl
    ).replace(/\/+$/, ''),
    graphqlUrl: 'https://api.github.com/graphql',
    oauthClientId: import.meta.env.VITE_GITHUB_CLIENT_ID || '',
    oauthScope: 'public_repo',
  },
  discussions: {
    annotationCategory: 'Notes',
    commentReadCategories: ['Announcements', 'General'] as const,
    commentCreateCategory: 'General',
    annotationBody(documentId: string) {
      return `读者笔记：${documentId}`
    },
    commentBody(documentId: string) {
      return `章节讨论：${documentId}`
    },
  },
})
