import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createVitePressDocumentAdapter } from '@github-reader/vitepress'

describe('VitePress document adapter', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main class="reader-root">
        <section class="group">
          <p class="reader-block zh" data-id="p0" data-legacy="legacy-p0">中文段落</p>
          <p class="reader-block en" data-id="p0">English paragraph</p>
        </section>
      </main>
    `
  })

  function createAdapter() {
    return createVitePressDocumentAdapter<'zh' | 'en'>({
      base: '/book/',
      rootSelector: '.reader-root',
      blockSelector: '.reader-block',
      readyEvent: 'test:reader-ready',
      getBlockId: element => element.dataset.id || null,
      getLegacyIds: element => element.dataset.legacy ? [element.dataset.legacy] : [],
      getLanguage: element => element.classList.contains('en') ? 'en' : 'zh',
      getGroup: element => element.closest<HTMLElement>('.group'),
    })
  }

  it('maps routes, blocks, legacy IDs and text nodes through one adapter', () => {
    const adapter = createAdapter()
    const blocks = adapter.getBlocks()

    expect(adapter.getDocumentId('/chapters/one')).toBe('/book/chapters/one.html')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ id: 'p0', legacyIds: ['legacy-p0'], language: 'zh' })
    expect(adapter.findBlock(blocks[1].element.firstChild!)).toMatchObject({
      id: 'p0',
      language: 'en',
    })
  })

  it('detects visible selections that cross another language and emits readiness', () => {
    const adapter = createAdapter()
    const [zh, en] = adapter.getBlocks()
    const range = document.createRange()
    range.setStart(zh.element.firstChild!, 0)
    range.setEnd(en.element.firstChild!, 3)

    expect(adapter.rangeIncludesOtherLanguage(range, 'zh')).toBe(true)
    en.element.style.display = 'none'
    expect(adapter.rangeIncludesOtherLanguage(range, 'zh')).toBe(false)

    const ready = vi.fn()
    document.addEventListener(adapter.readyEvent, ready, { once: true })
    adapter.notifyReady()
    expect(ready).toHaveBeenCalledOnce()
  })
})
