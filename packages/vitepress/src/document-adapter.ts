import {
  canonicalDocumentPath,
  type AnnotationDocumentAdapter,
  type AnnotationDocumentBlock,
} from '@github-reader/core'

export interface VitePressDocumentAdapterOptions<TLanguage extends string = string> {
  base: string
  rootSelector?: string
  blockSelector: string
  readyEvent?: string
  getBlockId(element: HTMLElement): string | null
  getLegacyIds?(element: HTMLElement): string[]
  getLanguage?(element: HTMLElement): TLanguage | undefined
  getGroup?(element: HTMLElement): HTMLElement | null
  getDocumentId?(routePath: string): string
}

export function createVitePressDocumentAdapter<TLanguage extends string = string>(
  options: VitePressDocumentAdapterOptions<TLanguage>,
): AnnotationDocumentAdapter<TLanguage> {
  const rootSelector = options.rootSelector || '.vp-doc'
  const readyEvent = options.readyEvent || 'github-reader:document-ready'

  function getRoot(): HTMLElement | null {
    if (typeof document === 'undefined') return null
    return document.querySelector<HTMLElement>(rootSelector)
  }

  function mapBlock(element: HTMLElement): AnnotationDocumentBlock<TLanguage> | null {
    const id = options.getBlockId(element)
    const group = options.getGroup?.(element) || element
    if (!id || !group) return null
    return {
      id,
      legacyIds: options.getLegacyIds?.(element) || [],
      language: options.getLanguage?.(element),
      element,
      group,
    }
  }

  function getBlocks(): AnnotationDocumentBlock<TLanguage>[] {
    const root = getRoot()
    if (!root) return []
    return Array.from(root.querySelectorAll<HTMLElement>(options.blockSelector))
      .map(mapBlock)
      .filter((block): block is AnnotationDocumentBlock<TLanguage> => !!block)
  }

  function findBlock(node: Node): AnnotationDocumentBlock<TLanguage> | null {
    const root = getRoot()
    if (!root) return null
    const element = node instanceof HTMLElement ? node : node.parentElement
    const block = element?.closest<HTMLElement>(options.blockSelector) || null
    if (!block || !root.contains(block)) return null
    return mapBlock(block)
  }

  return {
    readyEvent,
    getDocumentId(routePath: string) {
      return options.getDocumentId?.(routePath) || canonicalDocumentPath(routePath, options.base)
    },
    getRoot,
    getBlocks,
    findBlock,
    rangeIncludesOtherLanguage(range: Range, language?: TLanguage): boolean {
      if (!language) return false
      return getBlocks().some(block => {
        if (!block.language || block.language === language) return false
        const style = window.getComputedStyle(block.element)
        if (style.display === 'none' || style.visibility === 'hidden' || !block.element.textContent?.trim()) {
          return false
        }
        try {
          return range.intersectsNode(block.element)
        } catch {
          return false
        }
      })
    },
    notifyReady() {
      if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent(readyEvent))
    },
  }
}
