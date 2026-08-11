import { createGitHubDiscussionProvider } from '@github-reader/github'
import { createVitePressDocumentAdapter } from '@github-reader/vitepress'
import { useAuth } from './composables/useAuth'
import { readerConfig, type ReaderLanguage } from './readerConfig'

export const readerDocument = createVitePressDocumentAdapter<ReaderLanguage>({
  base: readerConfig.document.base,
  rootSelector: readerConfig.document.rootSelector,
  blockSelector: readerConfig.document.blockSelector,
  readyEvent: readerConfig.document.readyEvent,
  getBlockId(element) {
    return element.dataset.readerBlock || null
  },
  getLegacyIds(element) {
    const legacyId = element.dataset.readerLegacyId
    return legacyId ? [legacyId] : []
  },
  getLanguage(element) {
    return element.dataset.readerLanguage || undefined
  },
  getGroup(element) {
    return element
  },
})

export const githubDiscussionProvider = createGitHubDiscussionProvider(
  {
    owner: readerConfig.github.owner,
    repo: readerConfig.github.repo,
    workerUrl: readerConfig.github.workerUrl,
    graphqlUrl: readerConfig.github.graphqlUrl,
    development: import.meta.env.DEV,
  },
  {
    getToken() {
      return useAuth().token.value
    },
    invalidate() {
      useAuth().invalidate()
    },
  },
)
