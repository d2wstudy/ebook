import { beforeEach, describe, expect, it } from 'vitest'
import { applyDefaultLang, useLang } from '../docs/.vitepress/theme/composables/useLang'

describe('dynamic page-level language switching', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', window.location.pathname)
    document.body.innerHTML = `
      <div class="reader-language" data-language="en">
        <p data-reader-block="en-p1">English</p>
      </div>
      <div class="reader-language" data-language="zh-CN" data-default-language="true">
        <p data-reader-block="zh-p1">中文</p>
      </div>
    `
  })

  it('shows the default language and switches to a discovered language', () => {
    const state = useLang()
    state.setDefaultLanguage('zh-CN')
    expect(document.querySelector<HTMLElement>('[data-language="en"]')!.style.display).toBe('none')
    expect(document.querySelector<HTMLElement>('[data-language="zh-CN"]')!.style.display).toBe('')

    state.setDefaultLanguage('en')
    expect(document.querySelector<HTMLElement>('[data-language="en"]')!.style.display).toBe('')
    expect(document.querySelector<HTMLElement>('[data-language="zh-CN"]')!.style.display).toBe('none')
  })

  it('falls back to the page default when the selected language is missing', () => {
    document.body.innerHTML = `
      <div class="reader-language" data-language="en" data-default-language="true">
        <p data-reader-block="en-p1">English only</p>
      </div>
    `
    const state = useLang()
    state.setDefaultLanguage('zh-CN')
    applyDefaultLang()
    expect(document.querySelector<HTMLElement>('.reader-language')!.style.display).toBe('')
  })

  it('reveals and remembers the language containing a search-result anchor', () => {
    document.body.innerHTML = `
      <div class="reader-language" data-language="en">
        <h2 id="english-section">English section</h2>
      </div>
      <div class="reader-language" data-language="zh-CN" data-default-language="true">
        <h2 id="中文小节">中文小节</h2>
      </div>
    `
    const state = useLang()
    state.setDefaultLanguage('zh-CN')
    window.history.replaceState({}, '', '#english-section')

    state.refreshLanguages()

    expect(state.defaultLanguage.value).toBe('en')
    expect(localStorage.getItem('github-reader::ebook::language')).toBe('en')
    expect(document.querySelector<HTMLElement>('[data-language="en"]')!.style.display).toBe('')
    expect(document.querySelector<HTMLElement>('[data-language="zh-CN"]')!.style.display).toBe('none')
  })
})
