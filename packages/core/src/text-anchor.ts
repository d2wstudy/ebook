/** Context length captured before and after a text selection. */
const CONTEXT_LEN = 32

export const DEFAULT_IGNORED_TEXT_SELECTOR = [
  '.anno-popup',
  '.anno-inline-bubble',
  '.note-bubble',
  '.annotation-sidebar',
  '[data-annotation-ui="true"]',
].join(',')

export interface TextWalkerOptions {
  ignoredSelector?: string
}

export interface TextQuoteSelector {
  exact: string
  prefix: string
  suffix: string
}

export interface ResolvedRange {
  startOffset: number
  endOffset: number
}

export function getFullText(container: Node, options?: TextWalkerOptions): string {
  const walker = createContentTextWalker(container, options)
  let text = ''
  while (walker.nextNode()) text += walker.currentNode.textContent || ''
  return text
}

export function createContentTextWalker(container: Node, options?: TextWalkerOptions): TreeWalker {
  const ignoredSelector = options?.ignoredSelector || DEFAULT_IGNORED_TEXT_SELECTOR
  return document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      return ignoredSelector && parent?.closest(ignoredSelector)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT
    },
  })
}

export function getTextOffset(
  root: Node,
  targetNode: Node,
  targetOffset: number,
  options?: TextWalkerOptions,
): number {
  const walker = createContentTextWalker(root, options)
  let total = 0
  let current: Node | null

  while ((current = walker.nextNode())) {
    if (current === targetNode) return total + targetOffset
    total += current.textContent?.length || 0
  }

  try {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(targetNode, targetOffset)
    return getFullText(range.cloneContents(), options).length
  } catch {
    return total
  }
}

export function captureSelector(
  container: Node,
  startOffset: number,
  endOffset: number,
  options?: TextWalkerOptions,
): TextQuoteSelector {
  const full = getFullText(container, options)
  return {
    exact: full.slice(startOffset, endOffset),
    prefix: full.slice(Math.max(0, startOffset - CONTEXT_LEN), startOffset),
    suffix: full.slice(endOffset, endOffset + CONTEXT_LEN),
  }
}

export function resolveSelector(
  container: Node,
  selector: TextQuoteSelector,
  hintStart?: number,
  hintEnd?: number,
  options?: TextWalkerOptions,
): ResolvedRange | null {
  const full = getFullText(container, options)
  if (!selector.exact) return null

  if (hintStart !== undefined && hintEnd !== undefined) {
    if (full.slice(hintStart, hintEnd) === selector.exact) {
      return { startOffset: hintStart, endOffset: hintEnd }
    }
  }

  const candidates = allIndexesOf(full, selector.exact)
  if (candidates.length === 1) {
    return { startOffset: candidates[0], endOffset: candidates[0] + selector.exact.length }
  }
  if (candidates.length > 1) {
    const best = pickBestCandidate(full, candidates, selector)
    return { startOffset: best, endOffset: best + selector.exact.length }
  }
  return fuzzyMatch(full, selector)
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const results: number[] = []
  let position = 0
  while (position <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, position)
    if (index === -1) break
    results.push(index)
    position = index + 1
  }
  return results
}

function pickBestCandidate(full: string, candidates: number[], selector: TextQuoteSelector): number {
  let bestIndex = candidates[0]
  let bestScore = -1

  for (const index of candidates) {
    let score = 0
    if (selector.prefix) {
      const before = full.slice(Math.max(0, index - selector.prefix.length), index)
      score += commonSuffixLength(before, selector.prefix)
    }
    if (selector.suffix) {
      const after = full.slice(index + selector.exact.length, index + selector.exact.length + selector.suffix.length)
      score += commonPrefixLength(after, selector.suffix)
    }
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return bestIndex
}

function fuzzyMatch(full: string, selector: TextQuoteSelector): ResolvedRange | null {
  const exactLength = selector.exact.length
  if (!exactLength) return null

  const minWindow = Math.max(1, Math.floor(exactLength * 0.7))
  const maxWindow = Math.max(minWindow, Math.ceil(exactLength * 1.35))
  let bestScore = 0
  let bestStart = -1
  let bestEnd = -1

  for (let start = 0; start <= full.length - minWindow; start++) {
    for (let length = minWindow; length <= maxWindow; length++) {
      if (start + length > full.length) break
      const candidate = full.slice(start, start + length)
      const exactScore = similarity(selector.exact, candidate)
      if (exactScore < 0.35) continue

      const before = full.slice(Math.max(0, start - selector.prefix.length), start)
      const after = full.slice(start + length, start + length + selector.suffix.length)
      const prefixScore = selector.prefix
        ? commonSuffixLength(before, selector.prefix) / selector.prefix.length
        : 1
      const suffixScore = selector.suffix
        ? commonPrefixLength(after, selector.suffix) / selector.suffix.length
        : 1
      const lengthPenalty = Math.abs(length - exactLength) / Math.max(exactLength, 1)
      const score = exactScore * 0.72 + prefixScore * 0.14 + suffixScore * 0.14 - lengthPenalty * 0.08

      if (score > bestScore) {
        bestScore = score
        bestStart = start
        bestEnd = start + length
      }
    }
  }

  return bestScore >= 0.58 && bestStart >= 0 && bestEnd > bestStart
    ? { startOffset: bestStart, endOffset: bestEnd }
    : null
}

function similarity(left: string, right: string): number {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0

  const bigrams = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index++) {
    const bigram = left.slice(index, index + 2)
    bigrams.set(bigram, (bigrams.get(bigram) || 0) + 1)
  }

  let intersection = 0
  for (let index = 0; index < right.length - 1; index++) {
    const bigram = right.slice(index, index + 2)
    const count = bigrams.get(bigram)
    if (count && count > 0) {
      bigrams.set(bigram, count - 1)
      intersection++
    }
  }

  return (2 * intersection) / (left.length - 1 + right.length - 1)
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[index] === right[index]) index++
  return index
}

function commonSuffixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length)
  let index = 0
  while (index < length && left[left.length - 1 - index] === right[right.length - 1 - index]) index++
  return index
}
