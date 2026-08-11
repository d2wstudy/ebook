<script setup lang="ts">
import type { AnnotationDocumentBlock } from '@github-reader/core'
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vitepress'
import { useAuth } from '../composables/useAuth'
import {
  useAnnotations,
  type AnnotationAnchor,
  type AnnotationThread,
} from '../composables/useAnnotations'
import { purgeWorkerCache } from '../composables/useGithubGql'
import {
  captureSelector,
  createContentTextWalker,
  getFullText,
  getTextOffset,
  resolveSelector,
  type ResolvedRange,
} from '../composables/useTextAnchor'
import { readerConfig, type ReaderLanguage } from '../readerConfig'
import { readerDocument } from '../readerRuntime'
import NoteBubble from './NoteBubble.vue'
import AnnotationDrawer from './AnnotationDrawer.vue'

const MAX_SELECTION_LENGTH = 5000
const PENDING_SELECTION_KEY = `github-reader::${readerConfig.projectId}::pending-annotation`

interface SelectedInfo {
  anchor: AnnotationAnchor
  segments?: AnnotationAnchor[]
  text: string
}

interface ResolvedGroup {
  threads: AnnotationThread[]
  range: ResolvedRange
  showBubble: boolean
}

const { user, token, login } = useAuth()
const {
  annotations,
  discussion,
  loaded,
  loading,
  error,
  loadAnnotations,
  addAnnotation,
  replyToAnnotation,
  editAnnotationContent,
  removeAnnotationContent,
  toggleReaction,
  clearError,
} = useAnnotations()
const route = useRoute()

const showBubble = ref(false)
const bubbleX = ref(0)
const bubbleY = ref(0)
const bubblePlacement = ref<'above' | 'below'>('above')
const selectionError = ref<string | null>(null)

const selectedInfo = ref<SelectedInfo | null>(null)
const pendingNote = ref<{ text: string } | null>(null)
const submittingNote = ref(false)

const drawerOpen = ref(false)
const activeThreads = ref<AnnotationThread[]>([])
const copyStatus = ref<string | null>(null)

let selectionTimer: ReturnType<typeof setTimeout> | null = null
let copyTimer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  document.addEventListener('pointerup', scheduleSelectionCapture)
  document.addEventListener('keyup', onDocumentKeyup)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('click', onDocumentClick)
  document.addEventListener(readerDocument.readyEvent, onDocumentReady)
  window.addEventListener('resize', hideSelectionBubble)
  window.addEventListener('scroll', hideSelectionBubble, true)
  restorePendingSelection()
})

onUnmounted(() => {
  document.removeEventListener('pointerup', scheduleSelectionCapture)
  document.removeEventListener('keyup', onDocumentKeyup)
  document.removeEventListener('selectionchange', onSelectionChange)
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener(readerDocument.readyEvent, onDocumentReady)
  window.removeEventListener('resize', hideSelectionBubble)
  window.removeEventListener('scroll', hideSelectionBubble, true)
  if (selectionTimer) clearTimeout(selectionTimer)
  if (copyTimer) clearTimeout(copyTimer)
})

watch(() => route.path, (path) => {
  hideSelectionBubble()
  closeDrawer(false)
  void loadAnnotations(path)
}, { immediate: true })

watch(token, () => {
  if (typeof window !== 'undefined') void loadAnnotations(route.path, true)
})

watch(user, () => {
  if (user.value) restorePendingSelection()
})

watch([loaded, annotations, () => route.path], () => {
  void nextTick(() => {
    renderAnnotations()
    openAnnotationFromUrl()
  })
})

function scheduleSelectionCapture() {
  if (selectionTimer) clearTimeout(selectionTimer)
  selectionTimer = setTimeout(captureSelection, 40)
}

function onSelectionChange() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return
  if (selectionTimer) clearTimeout(selectionTimer)
  selectionTimer = setTimeout(captureSelection, 220)
}

function onDocumentKeyup(event: KeyboardEvent) {
  if (event.key === 'Shift' || event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
    scheduleSelectionCapture()
  }
}

function captureSelection() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return

  const range = selection.getRangeAt(0)
  const startBlock = readerDocument.findBlock(range.startContainer)
  const endBlock = readerDocument.findBlock(range.endContainer)
  if (!startBlock || !endBlock) return

  const language = startBlock.language
  if (endBlock.language !== language) {
    showSelectionError(range, '一次笔记只能选择同一种语言。')
    return
  }

  if (startBlock.group !== endBlock.group && readerDocument.rangeIncludesOtherLanguage(range, language)) {
    showSelectionError(range, '双语模式下跨段选择会混入另一种语言，请先切换到仅中文或仅英文。')
    return
  }

  const selectedText = selection.toString().trim()
  if (!selectedText) return
  if (selectedText.length > MAX_SELECTION_LENGTH) {
    showSelectionError(range, `选中文字不能超过 ${MAX_SELECTION_LENGTH} 个字符。`)
    return
  }

  const info = startBlock.group === endBlock.group
    ? captureSingleBlock(startBlock, range)
    : captureMultipleBlocks(startBlock, endBlock, range)
  if (!info) return

  selectedInfo.value = info
  selectionError.value = null
  positionBubble(range)
  showBubble.value = true
}

function captureSingleBlock(
  block: AnnotationDocumentBlock<ReaderLanguage>,
  range: Range,
): SelectedInfo | null {
  const rawStart = getTextOffset(block.element, range.startContainer, range.startOffset)
  const rawEnd = getTextOffset(block.element, range.endContainer, range.endOffset)
  const anchor = createAnchor(
    block.element,
    block.id,
    rawStart,
    rawEnd,
    block.language,
    true,
    true,
  )
  if (!anchor) return null
  return { anchor, text: anchor.selectedText }
}

function captureMultipleBlocks(
  startBlock: AnnotationDocumentBlock<ReaderLanguage>,
  endBlock: AnnotationDocumentBlock<ReaderLanguage>,
  range: Range,
): SelectedInfo | null {
  const blocks = blocksForLanguage(startBlock.language)
  const startIndex = blocks.findIndex(block => block.group === startBlock.group)
  const endIndex = blocks.findIndex(block => block.group === endBlock.group)
  if (startIndex < 0 || endIndex < startIndex) return null

  const segments: AnnotationAnchor[] = []
  for (let index = startIndex; index <= endIndex; index++) {
    const block = blocks[index]

    const textLength = getFullText(block.element).length
    const startOffset = index === startIndex
      ? getTextOffset(block.element, range.startContainer, range.startOffset)
      : 0
    const endOffset = index === endIndex
      ? getTextOffset(block.element, range.endContainer, range.endOffset)
      : textLength

    const anchor = createAnchor(
      block.element,
      block.id,
      startOffset,
      endOffset,
      block.language,
      index === startIndex,
      index === endIndex,
    )
    if (anchor) segments.push(anchor)
  }

  if (!segments.length) return null
  return {
    anchor: segments[0],
    segments: segments.length > 1 ? segments : undefined,
    text: segments.map(segment => segment.selectedText).join(' … '),
  }
}

function blocksForLanguage(language?: ReaderLanguage): AnnotationDocumentBlock<ReaderLanguage>[] {
  const seenGroups = new Set<HTMLElement>()
  return readerDocument.getBlocks().filter(block => {
    if (block.language !== language || seenGroups.has(block.group)) return false
    seenGroups.add(block.group)
    return true
  })
}

function createAnchor(
  block: HTMLElement,
  paragraphId: string,
  rawStart: number,
  rawEnd: number,
  language: ReaderLanguage | undefined,
  trimStart: boolean,
  trimEnd: boolean,
): AnnotationAnchor | null {
  const fullText = getFullText(block)
  let startOffset = Math.max(0, Math.min(rawStart, fullText.length))
  let endOffset = Math.max(startOffset, Math.min(rawEnd, fullText.length))
  let exact = fullText.slice(startOffset, endOffset)

  if (trimStart) {
    const leading = exact.length - exact.trimStart().length
    startOffset += leading
    exact = exact.slice(leading)
  }
  if (trimEnd) {
    const trailing = exact.length - exact.trimEnd().length
    endOffset -= trailing
  }
  if (startOffset >= endOffset) return null

  const selector = captureSelector(block, startOffset, endOffset)
  return {
    paragraphId,
    startOffset,
    endOffset,
    selectedText: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
    ...(language ? { language } : {}),
  }
}

function showSelectionError(range: Range, message: string) {
  selectedInfo.value = null
  selectionError.value = message
  positionBubble(range)
  showBubble.value = true
}

function positionBubble(range: Range) {
  const rects = Array.from(range.getClientRects()).filter(rect => rect.width || rect.height)
  const rect = rects.at(-1) || range.getBoundingClientRect()
  const viewportPadding = 16
  bubbleX.value = Math.min(
    window.innerWidth - viewportPadding,
    Math.max(viewportPadding, rect.left + rect.width / 2),
  )

  if (rect.top > 72) {
    bubbleY.value = rect.top - 10
    bubblePlacement.value = 'above'
  } else {
    bubbleY.value = rect.bottom + 10
    bubblePlacement.value = 'below'
  }
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('.note-bubble, .reader-anno, .annotation-sidebar')) return
  hideSelectionBubble()
}

function hideSelectionBubble() {
  showBubble.value = false
  selectionError.value = null
}

function openEditor() {
  if (!selectedInfo.value) return
  if (!user.value) {
    handleLogin()
    return
  }

  hideSelectionBubble()
  pendingNote.value = { text: selectedInfo.value.text }
  activeThreads.value = []
  drawerOpen.value = true
  window.getSelection()?.removeAllRanges()
}

function handleLogin() {
  if (selectedInfo.value) {
    try {
      sessionStorage.setItem(PENDING_SELECTION_KEY, JSON.stringify({
        documentId: readerDocument.getDocumentId(route.path),
        selectedInfo: selectedInfo.value,
        createdAt: Date.now(),
      }))
    } catch { /* ignore */ }
  }
  hideSelectionBubble()
  window.getSelection()?.removeAllRanges()
  void login()
}

function restorePendingSelection() {
  if (!user.value || typeof sessionStorage === 'undefined') return
  try {
    const raw = sessionStorage.getItem(PENDING_SELECTION_KEY)
    if (!raw) return
    const pending = JSON.parse(raw) as {
      documentId: string
      selectedInfo: SelectedInfo
      createdAt: number
    }
    sessionStorage.removeItem(PENDING_SELECTION_KEY)
    if (pending.documentId !== readerDocument.getDocumentId(route.path)) return
    if (Date.now() - pending.createdAt > 30 * 60 * 1000) return

    selectedInfo.value = pending.selectedInfo
    pendingNote.value = { text: pending.selectedInfo.text }
    activeThreads.value = []
    drawerOpen.value = true
  } catch {
    sessionStorage.removeItem(PENDING_SELECTION_KEY)
  }
}

async function submitNote(note: string) {
  if (!selectedInfo.value || submittingNote.value) return
  submittingNote.value = true
  clearError()

  try {
    await addAnnotation(
      route.path,
      selectedInfo.value.anchor,
      note,
      selectedInfo.value.segments,
    )
    pendingNote.value = null
    selectedInfo.value = null
  } catch {
    // The composable exposes a user-facing error while the editor stays open.
  } finally {
    submittingNote.value = false
  }
}

function cancelPendingNote() {
  pendingNote.value = null
  selectedInfo.value = null
}

function onAnnotationClick(event: Event, threads: AnnotationThread[]) {
  event.preventDefault()
  event.stopPropagation()
  pendingNote.value = null
  activeThreads.value = threads
  drawerOpen.value = true
  if (threads[0]) updateNoteQuery(threads[0].id)
}

async function onDrawerReply(threadId: string, body: string) {
  await replyToAnnotation(route.path, threadId, body)
  syncActiveThreads()
}

async function onDrawerReact(subjectId: string, content: string) {
  const result = await toggleReaction(subjectId, content)
  if (!result || !discussion.value) return
  await purgeWorkerCache(
    route.path,
    discussion.value.category,
    true,
    { subjectId, content, delta: result.delta },
    discussion.value.id,
  )
}

async function onDrawerEdit(subjectId: string, body: string) {
  await editAnnotationContent(route.path, subjectId, body)
  syncActiveThreads()
}

async function onDrawerDelete(subjectId: string) {
  await removeAnnotationContent(route.path, subjectId)
  syncActiveThreads()
  if (!activeThreads.value.length) closeDrawer()
}

function closeDrawer(removeDeepLink = true) {
  drawerOpen.value = false
  pendingNote.value = null
  selectedInfo.value = null
  activeThreads.value = []
  if (removeDeepLink) updateNoteQuery(null)
}

async function copyAnnotationLink(threadId: string) {
  const parentThread = uniqueAnnotationThreads().find(thread =>
    thread.id === threadId || thread.replies.some(reply => reply.id === threadId))
  const noteId = parentThread?.id || threadId
  const url = new URL(window.location.href)
  url.searchParams.set('note', noteId)
  url.searchParams.delete('code')
  url.searchParams.delete('state')

  try {
    await navigator.clipboard.writeText(url.toString())
    copyStatus.value = '笔记链接已复制'
  } catch {
    copyStatus.value = '无法自动复制，请复制浏览器地址'
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => { copyStatus.value = null }, 2400)
}

function syncActiveThreads() {
  if (!activeThreads.value.length) return
  const ids = new Set(activeThreads.value.map(thread => thread.id))
  activeThreads.value = uniqueAnnotationThreads().filter(thread => ids.has(thread.id))
}

function onDocumentReady() {
  renderAnnotations()
  openAnnotationFromUrl()
}

function openAnnotationFromUrl() {
  if (!loaded.value || drawerOpen.value) return
  const id = new URL(window.location.href).searchParams.get('note')
  if (!id) return
  const thread = uniqueAnnotationThreads().find(item => item.id === id)
  if (!thread) return

  activeThreads.value = [thread]
  drawerOpen.value = true
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`.reader-anno[data-anno-ids~="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
}

function updateNoteQuery(threadId: string | null) {
  const url = new URL(window.location.href)
  if (threadId) url.searchParams.set('note', threadId)
  else url.searchParams.delete('note')
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
}

/** Render all annotations, including legacy and re-anchored paragraph IDs. */
function renderAnnotations() {
  if (typeof document === 'undefined') return
  clearRenderedAnnotations()

  const threads = uniqueAnnotationThreads()
  if (!threads.length) return

  const blocks = readerDocument.getBlocks()
  const groupsByContainer = new Map<HTMLElement, ResolvedGroup[]>()

  for (const thread of threads) {
    const anchors = thread.segments?.length ? thread.segments : [thread.anchor]
    anchors.forEach((anchor, index) => {
      const placement = resolveAnchorPlacement(anchor, blocks)
      if (!placement) return

      const groups = groupsByContainer.get(placement.container) || []
      const existing = groups.find(group =>
        group.range.startOffset === placement.range.startOffset
        && group.range.endOffset === placement.range.endOffset)
      const showBubble = index === anchors.length - 1

      if (existing) {
        if (!existing.threads.some(item => item.id === thread.id)) existing.threads.push(thread)
        existing.showBubble ||= showBubble
      } else {
        groups.push({ threads: [thread], range: placement.range, showBubble })
      }
      groupsByContainer.set(placement.container, groups)
    })
  }

  for (const [container, groups] of groupsByContainer) {
    renderContainerGroups(container, groups)
  }
}

function resolveAnchorPlacement(
  anchor: AnnotationAnchor,
  blocks: AnnotationDocumentBlock<ReaderLanguage>[],
) {
  const languageMatches = (block: AnnotationDocumentBlock<ReaderLanguage>) =>
    !anchor.language || block.language === anchor.language
  const declaredBlocks = blocks.filter(block =>
    languageMatches(block)
    && (block.id === anchor.paragraphId || block.legacyIds.includes(anchor.paragraphId)))

  for (const block of declaredBlocks) {
    const range = resolveSelector(block.element, {
      exact: anchor.selectedText,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    }, anchor.startOffset, anchor.endOffset)
    if (range) return { container: block.element, range }
  }

  // Stable block IDs may still change while a book is being edited. Search the
  // current document by quote so older annotations remain recoverable.
  const candidates: { container: HTMLElement; range: ResolvedRange }[] = []
  for (const block of blocks) {
    if (!languageMatches(block) || !getFullText(block.element).includes(anchor.selectedText)) continue
    const range = resolveSelector(block.element, {
      exact: anchor.selectedText,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
    })
    if (range) candidates.push({ container: block.element, range })
  }
  return candidates.length ? candidates[0] : null
}

function renderContainerGroups(container: HTMLElement, groups: ResolvedGroup[]) {
  const boundaries = [...new Set(groups.flatMap(group => [group.range.startOffset, group.range.endOffset]))]
    .sort((a, b) => a - b)
  const atoms: {
    startOffset: number
    endOffset: number
    threads: AnnotationThread[]
    depth: number
    bubbleCount: number
  }[] = []

  for (let index = 0; index < boundaries.length - 1; index++) {
    const startOffset = boundaries[index]
    const endOffset = boundaries[index + 1]
    const covering = groups.filter(group =>
      group.range.startOffset <= startOffset && group.range.endOffset >= endOffset)
    if (!covering.length) continue

    const threadMap = new Map<string, AnnotationThread>()
    covering.forEach(group => group.threads.forEach(thread => threadMap.set(thread.id, thread)))
    const endingThreadIds = new Set<string>()
    covering
      .filter(group => group.showBubble && group.range.endOffset === endOffset)
      .forEach(group => group.threads.forEach(thread => endingThreadIds.add(thread.id)))
    const bubbleCount = [...threadMap.values()]
      .filter(thread => endingThreadIds.has(thread.id))
      .reduce((sum, thread) => sum + 1 + thread.replies.length, 0)

    atoms.push({
      startOffset,
      endOffset,
      threads: [...threadMap.values()],
      depth: covering.length,
      bubbleCount,
    })
  }

  atoms.sort((a, b) => b.startOffset - a.startOffset)
  for (const atom of atoms) {
    highlightRange(container, atom.threads, atom, atom.bubbleCount, atom.depth)
  }
}

function highlightRange(
  container: HTMLElement,
  threads: AnnotationThread[],
  range: ResolvedRange,
  bubbleCount: number,
  depth: number,
) {
  const walker = createContentTextWalker(container)
  let offset = 0
  const hits: { node: Text; relStart: number; relEnd: number }[] = []
  let node: Text | null

  while ((node = walker.nextNode() as Text | null)) {
    const nodeEnd = offset + node.length
    if (nodeEnd > range.startOffset && offset < range.endOffset) {
      hits.push({
        node,
        relStart: Math.max(0, range.startOffset - offset),
        relEnd: Math.min(node.length, range.endOffset - offset),
      })
    }
    if (nodeEnd >= range.endOffset) break
    offset = nodeEnd
  }
  if (!hits.length) return

  for (let index = hits.length - 1; index >= 0; index--) {
    const { node: textNode, relStart, relEnd } = hits[index]
    const text = textNode.textContent || ''
    const before = text.slice(0, relStart)
    const middle = text.slice(relStart, relEnd)
    const after = text.slice(relEnd)

    const span = document.createElement('span')
    span.className = 'reader-anno'
    if (depth > 1) span.classList.add('reader-anno-overlap')
    span.textContent = middle
    span.tabIndex = 0
    span.setAttribute('role', 'button')
    span.setAttribute('aria-label', `查看 ${threads.length} 条划词笔记`)
    span.dataset.annoIds = threads.map(thread => thread.id).join(' ')

    if (bubbleCount > 0 && index === hits.length - 1) {
      const bubble = document.createElement('span')
      bubble.className = 'anno-inline-bubble'
      bubble.dataset.annotationUi = 'true'
      bubble.setAttribute('aria-hidden', 'true')
      const count = document.createElement('span')
      count.className = 'anno-count'
      count.textContent = String(bubbleCount)
      bubble.appendChild(count)
      span.appendChild(bubble)
    }

    span.addEventListener('click', event => onAnnotationClick(event, threads))
    span.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') onAnnotationClick(event, threads)
    })

    const parent = textNode.parentNode
    if (!parent) continue
    if (after) parent.insertBefore(document.createTextNode(after), textNode.nextSibling)
    parent.insertBefore(span, textNode.nextSibling)
    if (before) parent.insertBefore(document.createTextNode(before), textNode.nextSibling)
    parent.removeChild(textNode)
  }
}

function clearRenderedAnnotations() {
  const parents = new Set<Node>()
  readerDocument.getRoot()?.querySelectorAll<HTMLElement>('.reader-anno').forEach(element => {
    let text = ''
    element.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent || ''
    })
    const parent = element.parentNode
    if (!parent) return
    parents.add(parent)
    parent.replaceChild(document.createTextNode(text), element)
  })
  parents.forEach(parent => parent.normalize())
}

function uniqueAnnotationThreads(): AnnotationThread[] {
  const seen = new Set<string>()
  const result: AnnotationThread[] = []
  for (const list of annotations.value.values()) {
    for (const thread of list) {
      if (seen.has(thread.id)) continue
      seen.add(thread.id)
      result.push(thread)
    }
  }
  return result
}

</script>

<template>
  <NoteBubble
    :visible="showBubble"
    :x="bubbleX"
    :y="bubbleY"
    :placement="bubblePlacement"
    :logged-in="!!user"
    :error="selectionError"
    @open-editor="openEditor"
    @login="handleLogin"
  />

  <AnnotationDrawer
    :open="drawerOpen"
    :threads="activeThreads"
    :pending-note="pendingNote"
    :loading="loading"
    :error="error"
    :submitting-note="submittingNote"
    :discussion-url="discussion?.url"
    :copy-status="copyStatus"
    :reply-action="onDrawerReply"
    :react-action="onDrawerReact"
    :edit-action="onDrawerEdit"
    :delete-action="onDrawerDelete"
    :copy-link-action="copyAnnotationLink"
    @close="closeDrawer"
    @retry="loadAnnotations(route.path, true)"
    @submit-note="submitNote"
    @cancel-note="cancelPendingNote"
  />
</template>
