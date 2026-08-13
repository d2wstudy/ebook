import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import { onMounted, watch, h } from 'vue'
import { useRoute } from 'vitepress'
import {
  useLang,
  applyDefaultLang,
} from './composables/useLang'
import { useAuth } from './composables/useAuth'
import LanguageToggle from './components/LanguageToggle.vue'
import LoginButton from './components/LoginButton.vue'
import Anno from './components/Anno.vue'
import AnnotationLayer from './components/AnnotationLayer.vue'
import ChapterComments from './components/ChapterComments.vue'
import { readerDocument } from './readerRuntime'
import { bookConfig } from '../../../book.config'
import './style.css'

const SEARCH_DETAILS_STORAGE_KEY = 'vitepress:local-search-detailed-list'
const SEARCH_DETAILS_MIGRATION_KEY = `github-reader::${bookConfig.id}::search-details-version`
const SEARCH_DETAILS_VERSION = '1'

/** djb2 hash -> short base-36 string, used for stable reader block IDs. */
function hashText(str: string): string {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff
  }
  return (hash >>> 0).toString(36)
}

function routeKey(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'home'
}

export default {
  extends: DefaultTheme,

  enhanceApp({ app }) {
    app.component('LanguageToggle', LanguageToggle)
    app.component('LoginButton', LoginButton)
    app.component('Anno', Anno)
    app.component('AnnotationLayer', AnnotationLayer)
    app.component('ChapterComments', ChapterComments)
  },

  Layout() {
    return h(DefaultTheme.Layout, null, {
      'nav-bar-content-after': () => [h(LanguageToggle), h(LoginButton)],
      'doc-after': () => [h(AnnotationLayer), h(ChapterComments)],
    })
  },

  setup() {
    enableDetailedSearchByDefault()
    const { defaultLanguage, initLang, refreshLanguages } = useLang()
    const { init: initAuth } = useAuth()
    const route = useRoute()

    onMounted(() => {
      initLang()
      initAuth()
      decorateReaderBlocks(route.path)
      refreshLanguages()
    })

    watch(() => route.path, () => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        decorateReaderBlocks(route.path)
        refreshLanguages()
      }))
    })

    watch(defaultLanguage, () => {
      applyDefaultLang()
    })
  },
} satisfies Theme

/** Enable the upgraded excerpt view once while preserving later user choices. */
function enableDetailedSearchByDefault() {
  if (typeof localStorage === 'undefined') return
  if (localStorage.getItem(SEARCH_DETAILS_MIGRATION_KEY) === SEARCH_DETAILS_VERSION) return
  localStorage.setItem(SEARCH_DETAILS_STORAGE_KEY, 'true')
  localStorage.setItem(SEARCH_DETAILS_MIGRATION_KEY, SEARCH_DETAILS_VERSION)
}

/** Add generic annotation blocks without assuming a fixed language set. */
function decorateReaderBlocks(path: string) {
  if (typeof document === 'undefined') return

  const content = document.querySelector('.vp-doc')
  if (!content) return

  const pageKey = routeKey(path)
  for (const section of content.querySelectorAll<HTMLElement>('.reader-language')) {
    const language = section.dataset.language
    if (!language) continue
    section.dataset.readerLanguage = language

    const occurrences = new Map<string, number>()
    const blocks = Array.from(section.querySelectorAll<HTMLElement>('p, blockquote, pre, li, table'))
      .filter(element => !element.closest('[data-reader-block]'))

    for (const block of blocks) {
      const text = (block.textContent || '').trim()
      if (!text) continue
      if (block.dataset.readerBlock) continue

      const base = `${pageKey}-${language}-${hashText(text.slice(0, 400))}`
      const occurrence = (occurrences.get(base) || 0) + 1
      occurrences.set(base, occurrence)
      block.dataset.readerBlock = occurrence === 1 ? base : `${base}-${occurrence}`
      block.dataset.readerLanguage = language
    }
  }

  readerDocument.notifyReady()
}
