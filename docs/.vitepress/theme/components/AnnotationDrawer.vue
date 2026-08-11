<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AnnotationThread } from '../composables/useAnnotations'
import CommentItem from './CommentItem.vue'
import MarkdownEditor from './MarkdownEditor.vue'

type AsyncAction = (...args: any[]) => Promise<void>

const props = defineProps<{
  open: boolean
  threads: AnnotationThread[]
  pendingNote?: { text: string } | null
  loading?: boolean
  error?: string | null
  submittingNote?: boolean
  discussionUrl?: string
  copyStatus?: string | null
  replyAction?: AsyncAction
  reactAction?: AsyncAction
  editAction?: AsyncAction
  deleteAction?: AsyncAction
  copyLinkAction?: AsyncAction
}>()

const emit = defineEmits<{
  close: []
  retry: []
  'submit-note': [note: string]
  'cancel-note': []
}>()

const editorRef = ref<InstanceType<typeof MarkdownEditor> | null>(null)
const closeButton = ref<HTMLButtonElement | null>(null)
const sidebar = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
let previousBodyOverflow = ''

watch(() => props.open, open => {
  if (typeof document === 'undefined') return
  if (open) {
    previousFocus = document.activeElement as HTMLElement | null
    previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeydown)
    void nextTick(() => {
      if (props.pendingNote) editorRef.value?.focus()
      else closeButton.value?.focus()
    })
  } else {
    restoreDocumentState()
  }
})

onBeforeUnmount(restoreDocumentState)

function restoreDocumentState() {
  if (typeof document === 'undefined') return
  document.body.style.overflow = previousBodyOverflow
  document.removeEventListener('keydown', onKeydown)
  previousFocus?.focus?.()
  previousFocus = null
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !sidebar.value) return

  const focusable = Array.from(sidebar.value.querySelectorAll<HTMLElement>([
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))).filter(element => element.getClientRects().length > 0)
  if (!focusable.length) {
    event.preventDefault()
    sidebar.value.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function threadQuote(thread: AnnotationThread): string {
  if (thread.segments?.length) return thread.segments.map(segment => segment.selectedText).join(' … ')
  return thread.anchor.selectedText
}
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer-slide">
      <div v-if="open" class="annotation-drawer-layer" data-annotation-ui="true">
        <button class="drawer-backdrop" type="button" aria-label="关闭笔记面板" @click="emit('close')" />

        <aside
          ref="sidebar"
          class="annotation-sidebar"
          role="dialog"
          aria-modal="true"
          aria-labelledby="annotation-drawer-title"
          tabindex="-1"
          @click.stop
        >
          <header class="sidebar-header">
            <div>
              <h2 id="annotation-drawer-title">划词笔记</h2>
              <p>{{ pendingNote ? '创建新笔记' : `${threads.length} 个讨论串` }}</p>
            </div>
            <div class="header-actions">
              <a
                v-if="discussionUrl"
                class="github-link"
                :href="discussionUrl"
                target="_blank"
                rel="noopener noreferrer"
                title="在 GitHub Discussions 查看"
              >GitHub</a>
              <button ref="closeButton" type="button" class="sidebar-close" aria-label="关闭" @click="emit('close')">×</button>
            </div>
          </header>

          <div class="sidebar-body">
            <div v-if="error" class="drawer-message error-message" role="alert">
              <span>{{ error }}</span>
              <button type="button" @click="emit('retry')">重试</button>
            </div>

            <div v-if="pendingNote" class="sidebar-card new-note-card">
              <div class="card-quote">
                <span class="quote-mark" aria-hidden="true">“</span>
                <span>{{ pendingNote.text }}</span>
              </div>
              <MarkdownEditor
                ref="editorRef"
                placeholder="写下你的笔记... 支持 Markdown 语法"
                :busy="submittingNote"
                :submit-label="submittingNote ? '提交中...' : '发布笔记'"
                @submit="text => emit('submit-note', text)"
                @cancel="emit('cancel-note')"
              />
              <p class="storage-hint">笔记将以可读评论保存到 GitHub Discussions，并附带定位元数据。</p>
            </div>

            <div v-if="loading && !pendingNote" class="drawer-loading" aria-label="正在加载笔记">
              <span v-for="item in 3" :key="item" class="skeleton-card" />
            </div>

            <section v-for="thread in threads" :key="thread.id" class="sidebar-card thread-card">
              <div class="card-quote">
                <span class="quote-mark" aria-hidden="true">“</span>
                <span>{{ threadQuote(thread) }}</span>
              </div>
              <CommentItem
                :id="thread.id"
                :body="thread.note"
                :author="thread.author"
                :author-avatar="thread.authorAvatar"
                :created-at="thread.createdAt"
                :last-edited-at="thread.lastEditedAt"
                :url="thread.url"
                :author-association="thread.authorAssociation"
                :reactions="thread.reactions"
                :replies="thread.replies"
                :reply-action="replyAction"
                :react-action="reactAction"
                :edit-action="editAction"
                :delete-action="deleteAction"
                :copy-link-action="copyLinkAction"
                compact
              />
            </section>

            <div v-if="!loading && !threads.length && !pendingNote && !error" class="sidebar-empty">
              <span class="empty-icon" aria-hidden="true">✎</span>
              <strong>这里还没有划词笔记</strong>
              <p>选择正文中的文字即可开始讨论。</p>
            </div>
          </div>

          <Transition name="toast-fade">
            <div v-if="copyStatus" class="drawer-toast" role="status">{{ copyStatus }}</div>
          </Transition>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.annotation-drawer-layer { position: fixed; inset: 0; z-index: 400; }
.drawer-backdrop { position: absolute; inset: 0; width: 100%; border: 0; background: rgba(15, 23, 42, 0.12); cursor: default; }
.annotation-sidebar { position: absolute; top: 0; right: 0; display: flex; flex-direction: column; width: min(460px, 92vw); height: 100vh; height: 100dvh; border-left: 1px solid var(--vp-c-divider); background: var(--vp-c-bg); box-shadow: -12px 0 40px rgba(15, 23, 42, .14); }

.sidebar-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 18px; border-bottom: 1px solid var(--vp-c-divider); background: color-mix(in srgb, var(--vp-c-bg) 92%, transparent); backdrop-filter: blur(12px); }
.sidebar-header h2 { margin: 0; color: var(--vp-c-text-1); font-size: 16px; line-height: 1.4; }
.sidebar-header p { margin: 2px 0 0; color: var(--vp-c-text-2); font-size: 11px; }
.header-actions { display: flex; align-items: center; gap: 7px; }
.github-link { padding: 4px 8px; border: 1px solid var(--vp-c-divider); border-radius: 7px; color: var(--vp-c-text-2); font-size: 11px; text-decoration: none; }
.github-link:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.sidebar-close { width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--vp-c-text-2); font-size: 23px; line-height: 1; cursor: pointer; }
.sidebar-close:hover { background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }

.sidebar-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px 32px; }
.sidebar-card { padding: 12px; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg); }
.sidebar-card + .sidebar-card { margin-top: 10px; }
.new-note-card { border-color: color-mix(in srgb, var(--vp-c-brand-1) 45%, var(--vp-c-divider)); background: color-mix(in srgb, var(--vp-c-brand-soft) 40%, var(--vp-c-bg)); }
.card-quote { display: flex; gap: 7px; margin-bottom: 9px; padding: 7px 9px; border-left: 3px solid var(--vp-c-warning-1); border-radius: 0 7px 7px 0; background: color-mix(in srgb, var(--vp-c-warning-1) 7%, transparent); color: var(--vp-c-text-2); font-size: 12px; font-style: italic; line-height: 1.55; }
.card-quote span:last-child { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
.quote-mark { flex: 0 0 auto; color: var(--vp-c-warning-1); font-size: 18px; font-style: normal; line-height: 1; }
.storage-hint { margin: 7px 2px 0; color: var(--vp-c-text-2); font-size: 10px; }

.drawer-message { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; padding: 9px 11px; border-radius: 9px; font-size: 12px; }
.error-message { background: color-mix(in srgb, var(--vp-c-danger-1) 10%, transparent); color: var(--vp-c-danger-1); }
.drawer-message button { flex: 0 0 auto; padding: 3px 8px; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }

.drawer-loading { display: grid; gap: 10px; }
.skeleton-card { display: block; height: 132px; border-radius: 12px; background: linear-gradient(90deg, var(--vp-c-bg-soft), var(--vp-c-bg-mute), var(--vp-c-bg-soft)); background-size: 200% 100%; animation: skeleton 1.3s infinite linear; }
@keyframes skeleton { to { background-position: -200% 0; } }

.sidebar-empty { display: grid; place-items: center; padding: 64px 20px; color: var(--vp-c-text-2); text-align: center; }
.sidebar-empty strong { margin-top: 8px; color: var(--vp-c-text-2); font-size: 14px; }
.sidebar-empty p { margin: 4px 0 0; font-size: 12px; }
.empty-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 50%; background: var(--vp-c-bg-soft); color: var(--vp-c-brand-1); font-size: 20px; }
.drawer-toast { position: absolute; right: 18px; bottom: 18px; padding: 8px 12px; border-radius: 8px; background: var(--vp-c-text-1); color: var(--vp-c-bg); box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 12px; }

.drawer-slide-enter-active,
.drawer-slide-leave-active { transition: opacity .2s ease; }
.drawer-slide-enter-active .annotation-sidebar,
.drawer-slide-leave-active .annotation-sidebar { transition: transform .22s ease; }
.drawer-slide-enter-from,
.drawer-slide-leave-to { opacity: 0; }
.drawer-slide-enter-from .annotation-sidebar,
.drawer-slide-leave-to .annotation-sidebar { transform: translateX(100%); }
.toast-fade-enter-active,
.toast-fade-leave-active { transition: opacity .15s; }
.toast-fade-enter-from,
.toast-fade-leave-to { opacity: 0; }

@media (max-width: 640px) {
  .drawer-backdrop { background: rgba(15, 23, 42, .28); }
  .annotation-sidebar { width: 100vw; border-left: 0; }
  .sidebar-body { padding-inline: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  .drawer-slide-enter-active,
  .drawer-slide-leave-active,
  .drawer-slide-enter-active .annotation-sidebar,
  .drawer-slide-leave-active .annotation-sidebar { transition: none; }
  .skeleton-card { animation: none; }
}
</style>
