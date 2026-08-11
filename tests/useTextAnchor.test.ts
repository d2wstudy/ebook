import { beforeEach, describe, expect, it } from 'vitest'
import {
  captureSelector,
  getFullText,
  getTextOffset,
  resolveSelector,
} from '../docs/.vitepress/theme/composables/useTextAnchor'

describe('text annotation anchors', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('ignores annotation UI text when calculating offsets', () => {
    const root = document.createElement('div')
    root.innerHTML = '阅读<span class="reader-anno">模板<span class="anno-inline-bubble"><span>12</span></span></span><span class="anno-popup">作者说明</span>示例'
    document.body.append(root)

    expect(getFullText(root)).toBe('阅读模板示例')

    const finalText = root.lastChild as Text
    expect(getTextOffset(root, finalText, 2)).toBe(6)
  })

  it('supports element-node range boundaries', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span>Alpha</span><strong>Beta</strong>'
    document.body.append(root)

    expect(getTextOffset(root, root, 1)).toBe(5)
    expect(getTextOffset(root, root.querySelector('strong')!, 1)).toBe(9)
  })

  it('uses prefix and suffix to disambiguate repeated text', () => {
    const root = document.createElement('div')
    root.textContent = '状态决定动作；下一个状态产生奖励。'
    document.body.append(root)

    const full = getFullText(root)
    const start = full.lastIndexOf('状态')
    const selector = captureSelector(root, start, start + 2)

    expect(resolveSelector(root, selector)).toEqual({ startOffset: start, endOffset: start + 2 })
  })

  it('falls back to a fuzzy match after a small edit', () => {
    const root = document.createElement('div')
    root.textContent = '智能体通过持续与环境交互来学习。'
    document.body.append(root)
    const selector = {
      exact: '通过与环境交互',
      prefix: '智能体',
      suffix: '来学习。',
    }

    const resolved = resolveSelector(root, selector)
    expect(resolved).not.toBeNull()
    expect(getFullText(root).slice(resolved!.startOffset, resolved!.endOffset)).toContain('环境交互')
  })
})
