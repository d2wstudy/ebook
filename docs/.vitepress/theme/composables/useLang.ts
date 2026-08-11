import { readonly, ref } from 'vue'
import { bookConfig } from '../../../../book.config'

export type ReaderLanguage = string

const STORAGE_KEY = `github-reader::${bookConfig.id}::language`
const LEGACY_STORAGE_KEY = 'rl-book-lang-mode'
const defaultLanguage = ref('')
const availableLanguages = ref<string[]>([])

export function useLang() {
  function setDefaultLanguage(language: string) {
    if (!language) return
    defaultLanguage.value = language
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, language)
      localStorage.removeItem(LEGACY_STORAGE_KEY)
    }
    applyDefaultLang()
  }

  function initLang() {
    if (typeof localStorage === 'undefined') return
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) defaultLanguage.value = saved
  }

  function refreshLanguages() {
    if (typeof document === 'undefined') return
    const found = [...document.querySelectorAll<HTMLElement>('.reader-language')]
      .map(element => element.dataset.language)
      .filter((language): language is string => !!language)
    availableLanguages.value = [...new Set(found)]

    // Keep a user's global preference even when this page has no translation;
    // applyDefaultLang() performs a page-local fallback without losing it.
    if (!defaultLanguage.value) {
      defaultLanguage.value = bookConfig.defaultLanguage
        || document.querySelector<HTMLElement>('.reader-language[data-default-language="true"]')?.dataset.language
        || availableLanguages.value[0]
        || ''
    }
    applyDefaultLang()
  }

  return {
    defaultLanguage: readonly(defaultLanguage),
    availableLanguages: readonly(availableLanguages),
    setDefaultLanguage,
    initLang,
    refreshLanguages,
  }
}

export function applyDefaultLang() {
  if (typeof document === 'undefined') return
  const sections = [...document.querySelectorAll<HTMLElement>('.reader-language')]
  if (!sections.length) return

  const selected = defaultLanguage.value
  const pageLanguages = [...new Set(sections.map(section => section.dataset.language).filter(Boolean))] as string[]
  const fallback = sections.find(section => section.dataset.defaultLanguage === 'true')?.dataset.language
    || pageLanguages[0]
  const visibleLanguage = selected && pageLanguages.includes(selected) ? selected : fallback

  for (const section of sections) {
    section.style.display = section.dataset.language === visibleLanguage ? '' : 'none'
  }
  document.documentElement.dataset.readerLanguage = visibleLanguage || ''
}

export function languageLabel(language: string): string {
  const names = bookConfig.languageNames as Record<string, string> | undefined
  return names?.[language] || LANGUAGE_LABELS[language] || language
}

export function languageShort(language: string): string {
  const label = languageLabel(language)
  return label.length <= 8 ? label : language.toUpperCase()
}

const LANGUAGE_LABELS: Record<string, string> = {
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  ja: '日本語',
  ko: '한국어',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  zh: '中文',
}
