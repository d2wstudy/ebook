import { describe, expect, it } from 'vitest'
import { useMarkdown } from '../docs/.vitepress/theme/composables/useMarkdown'

describe('comment Markdown hardening', () => {
  it('removes protocol-relative and unsafe image sources', () => {
    const { renderMarkdown } = useMarkdown()
    const html = renderMarkdown([
      '![bad](//evil.example/image.png)',
      '![also-bad](javascript:alert(1))',
      '![local](/images/local.png)',
      '![https](https://example.com/image.png)',
    ].join('\n\n'))

    const root = document.createElement('div')
    root.innerHTML = html
    const sources = Array.from(root.querySelectorAll('img')).map(image => image.getAttribute('src'))
    expect(sources).toEqual(['/images/local.png', 'https://example.com/image.png'])
  })
})
