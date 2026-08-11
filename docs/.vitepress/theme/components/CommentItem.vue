<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useAuth } from '../composables/useAuth'
import { useMarkdown } from '../composables/useMarkdown'
import {
  formatRelativeTime,
  type ReactionGroup,
  type ThreadReply,
} from '../composables/useDiscussionThread'
import MarkdownEditor from './MarkdownEditor.vue'

type AsyncAction = (...args: any[]) => Promise<void>

const props = withDefaults(defineProps<{
  id: string
  body: string
  author: string
  authorAvatar: string
  createdAt: string
  lastEditedAt?: string | null
  url?: string
  authorAssociation?: string
  reactions: ReactionGroup[]
  replies: ThreadReply[]
  compact?: boolean
  replyAction?: AsyncAction
  reactAction?: AsyncAction
  editAction?: AsyncAction
  deleteAction?: AsyncAction
  copyLinkAction?: AsyncAction
}>(), {
  lastEditedAt: null,
  url: '',
  authorAssociation: 'NONE',
  compact: false,
})

const { user, login } = useAuth()
const { renderMarkdown } = useMarkdown()

const REACTION_EMOJI: Record<string, string> = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀',
}
const PICKER_REACTIONS = [
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
]

const rootElement = ref<HTMLElement | null>(null)
const pickerOpenFor = ref<string | null>(null)
const menuOpenFor = ref<string | null>(null)
const expandedReplies = ref(props.compact || props.replies.length <= 2)
const replyingTo = ref(false)
const replyMention = ref<string | null>(null)
const editingId = ref<string | null>(null)
const busyAction = ref<string | null>(null)
const actionError = ref<string | null>(null)
const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const isOwnComment = computed(() => user.value?.login === props.author)
const associationLabel = computed(() => associationText(props.authorAssociation))

watch(() => props.replies.length, length => {
  if (length <= 2) expandedReplies.value = true
})

const overlayOpen = computed(() => pickerOpenFor.value !== null || menuOpenFor.value !== null)

watch(overlayOpen, open => {
  if (open) {
    document.addEventListener('click', onOutsideClick, true)
    document.addEventListener('keydown', onKeydown)
  } else {
    removeOverlayListeners()
  }
})

onUnmounted(() => {
  removeOverlayListeners()
  if (copiedTimer) clearTimeout(copiedTimer)
})

function onOutsideClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element) || !rootElement.value?.contains(target)) {
    pickerOpenFor.value = null
    menuOpenFor.value = null
    return
  }
  if (!target.closest('.reaction-add-wrap')) pickerOpenFor.value = null
  if (!target.closest('.comment-menu-wrap')) menuOpenFor.value = null
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  pickerOpenFor.value = null
  menuOpenFor.value = null
}

function removeOverlayListeners() {
  document.removeEventListener('click', onOutsideClick, true)
  document.removeEventListener('keydown', onKeydown)
}

function togglePicker(subjectId: string) {
  if (!user.value) {
    void login()
    return
  }
  pickerOpenFor.value = pickerOpenFor.value === subjectId ? null : subjectId
  menuOpenFor.value = null
}

async function onReact(subjectId: string, content: string) {
  if (!user.value) {
    await login()
    return
  }
  if (!props.reactAction || busyAction.value) return

  pickerOpenFor.value = null
  actionError.value = null
  busyAction.value = `react:${subjectId}:${content}`
  try {
    await props.reactAction(subjectId, content)
  } catch (cause) {
    actionError.value = messageFromError(cause, '表情回应失败。')
  } finally {
    busyAction.value = null
  }
}

function startReply(mentionAuthor?: string) {
  if (!user.value) {
    void login()
    return
  }
  replyingTo.value = true
  replyMention.value = mentionAuthor || null
  expandedReplies.value = true
  actionError.value = null
}

async function onReplySubmit(text: string) {
  if (!props.replyAction || busyAction.value) return
  busyAction.value = `reply:${props.id}`
  actionError.value = null
  try {
    const body = replyMention.value ? `@${replyMention.value} ${text}` : text
    await props.replyAction(props.id, body)
    replyingTo.value = false
    replyMention.value = null
    expandedReplies.value = true
  } catch (cause) {
    actionError.value = messageFromError(cause, '发表回复失败。')
  } finally {
    busyAction.value = null
  }
}

async function onEditSubmit(subjectId: string, body: string) {
  if (!props.editAction || busyAction.value) return
  busyAction.value = `edit:${subjectId}`
  actionError.value = null
  try {
    await props.editAction(subjectId, body)
    editingId.value = null
  } catch (cause) {
    actionError.value = messageFromError(cause, '更新内容失败。')
  } finally {
    busyAction.value = null
  }
}

async function onDelete(subjectId: string, hasReplies = false) {
  if (!props.deleteAction || busyAction.value) return
  const message = hasReplies
    ? '删除这条内容也会删除其全部回复，确定继续吗？'
    : '确定删除这条内容吗？此操作会同步到 GitHub Discussions。'
  if (!window.confirm(message)) return

  busyAction.value = `delete:${subjectId}`
  menuOpenFor.value = null
  actionError.value = null
  try {
    await props.deleteAction(subjectId)
  } catch (cause) {
    actionError.value = messageFromError(cause, '删除内容失败。')
  } finally {
    busyAction.value = null
  }
}

async function copyLink(subjectId: string, url?: string) {
  menuOpenFor.value = null
  actionError.value = null
  try {
    if (props.copyLinkAction) await props.copyLinkAction(subjectId)
    else if (url) await navigator.clipboard.writeText(url)
    else throw new Error('当前内容暂无可复制链接。')

    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1800)
  } catch (cause) {
    actionError.value = messageFromError(cause, '复制链接失败。')
  }
}

function canEdit(author: string) {
  return user.value?.login === author && !!props.editAction
}

function canDelete(author: string) {
  return user.value?.login === author && !!props.deleteAction
}

function associationText(value?: string): string {
  if (value === 'OWNER') return '项目维护者'
  if (value === 'MEMBER' || value === 'COLLABORATOR') return '协作者'
  if (value === 'CONTRIBUTOR') return '贡献者'
  return ''
}

function messageFromError(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
</script>

<template>
  <article ref="rootElement" class="comment-thread-item" :class="{ compact }">
    <div class="comment-item">
      <img v-if="authorAvatar" :src="authorAvatar" class="comment-avatar" :alt="author" loading="lazy" referrerpolicy="no-referrer" />
      <span v-else class="comment-avatar avatar-fallback" aria-hidden="true">{{ author.slice(0, 1).toUpperCase() }}</span>

      <div class="comment-content">
        <div class="comment-meta-row">
          <div class="comment-meta">
            <a v-if="author !== 'ghost'" class="comment-author" :href="`https://github.com/${author}`" target="_blank" rel="noopener noreferrer">{{ author }}</a>
            <span v-else class="comment-author">{{ author }}</span>
            <span v-if="associationLabel" class="association-badge">{{ associationLabel }}</span>
            <time class="comment-time" :datetime="createdAt">{{ formatRelativeTime(createdAt) }}</time>
            <span v-if="lastEditedAt" class="edited-label">已编辑</span>
          </div>

          <div class="comment-menu-wrap">
            <button
              type="button"
              class="icon-action menu-trigger"
              aria-label="更多操作"
              :aria-expanded="menuOpenFor === id"
              @click.stop="menuOpenFor = menuOpenFor === id ? null : id; pickerOpenFor = null"
            >•••</button>
            <div v-if="menuOpenFor === id" class="comment-menu" role="menu">
              <button type="button" role="menuitem" @click="copyLink(id, url)">复制链接</button>
              <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer" role="menuitem">在 GitHub 查看</a>
              <button v-if="isOwnComment && editAction" type="button" role="menuitem" @click="editingId = id; menuOpenFor = null">编辑</button>
              <button v-if="isOwnComment && deleteAction" type="button" class="danger" role="menuitem" @click="onDelete(id, replies.length > 0)">删除</button>
            </div>
          </div>
        </div>

        <slot name="before-body" />

        <MarkdownEditor
          v-if="editingId === id"
          :initial-value="body"
          :busy="busyAction === `edit:${id}`"
          submit-label="保存"
          @submit="text => onEditSubmit(id, text)"
          @cancel="editingId = null"
        />
        <div v-else class="comment-body" v-html="renderMarkdown(body)" />

        <div class="interaction-row">
          <div class="reactions-bar">
            <button
              v-for="reaction in reactions"
              :key="reaction.content"
              type="button"
              class="reaction-pill"
              :class="{ 'reaction-active': reaction.viewerHasReacted }"
              :aria-label="`${REACTION_EMOJI[reaction.content]} ${reaction.count} 个回应`"
              @click="onReact(id, reaction.content)"
            >
              {{ REACTION_EMOJI[reaction.content] }} <span>{{ reaction.count }}</span>
            </button>
            <div class="reaction-add-wrap">
              <button type="button" class="reaction-add-btn" aria-label="添加表情回应" @click.stop="togglePicker(id)">
                <span aria-hidden="true">☺</span><span class="plus">+</span>
              </button>
              <div v-if="pickerOpenFor === id" class="reaction-picker" role="menu" aria-label="选择表情回应">
                <button
                  v-for="key in PICKER_REACTIONS"
                  :key="key"
                  type="button"
                  class="picker-emoji"
                  role="menuitem"
                  :aria-label="key"
                  @click="onReact(id, key)"
                >{{ REACTION_EMOJI[key] }}</button>
              </div>
            </div>
          </div>

          <div class="comment-actions">
            <button type="button" class="action-btn" @click="startReply()">回复</button>
            <button
              v-if="replies.length"
              type="button"
              class="action-btn expand-btn"
              :aria-expanded="expandedReplies"
              @click="expandedReplies = !expandedReplies"
            >
              {{ replies.length }} 条回复
              <span class="chevron" :class="{ open: expandedReplies }">⌄</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="replies.length && expandedReplies" class="replies-section">
      <article v-for="reply in replies" :key="reply.id" class="reply-item">
        <img v-if="reply.authorAvatar" :src="reply.authorAvatar" class="reply-avatar" :alt="reply.author" loading="lazy" referrerpolicy="no-referrer" />
        <span v-else class="reply-avatar avatar-fallback" aria-hidden="true">{{ reply.author.slice(0, 1).toUpperCase() }}</span>

        <div class="reply-content">
          <div class="comment-meta-row">
            <div class="comment-meta">
              <a v-if="reply.author !== 'ghost'" class="comment-author" :href="`https://github.com/${reply.author}`" target="_blank" rel="noopener noreferrer">{{ reply.author }}</a>
              <span v-else class="comment-author">{{ reply.author }}</span>
              <span v-if="associationText(reply.authorAssociation)" class="association-badge">{{ associationText(reply.authorAssociation) }}</span>
              <time class="comment-time" :datetime="reply.createdAt">{{ formatRelativeTime(reply.createdAt) }}</time>
              <span v-if="reply.lastEditedAt" class="edited-label">已编辑</span>
            </div>

            <div class="comment-menu-wrap">
              <button
                type="button"
                class="icon-action menu-trigger"
                aria-label="更多操作"
                :aria-expanded="menuOpenFor === reply.id"
                @click.stop="menuOpenFor = menuOpenFor === reply.id ? null : reply.id; pickerOpenFor = null"
              >•••</button>
              <div v-if="menuOpenFor === reply.id" class="comment-menu" role="menu">
                <button type="button" role="menuitem" @click="copyLink(reply.id, reply.url)">复制链接</button>
                <a v-if="reply.url" :href="reply.url" target="_blank" rel="noopener noreferrer" role="menuitem">在 GitHub 查看</a>
                <button v-if="canEdit(reply.author)" type="button" role="menuitem" @click="editingId = reply.id; menuOpenFor = null">编辑</button>
                <button v-if="canDelete(reply.author)" type="button" class="danger" role="menuitem" @click="onDelete(reply.id)">删除</button>
              </div>
            </div>
          </div>

          <MarkdownEditor
            v-if="editingId === reply.id"
            :initial-value="reply.body"
            :busy="busyAction === `edit:${reply.id}`"
            submit-label="保存"
            @submit="text => onEditSubmit(reply.id, text)"
            @cancel="editingId = null"
          />
          <div v-else class="comment-body" v-html="renderMarkdown(reply.body)" />

          <div class="interaction-row">
            <div class="reactions-bar">
              <button
                v-for="reaction in reply.reactions"
                :key="reaction.content"
                type="button"
                class="reaction-pill"
                :class="{ 'reaction-active': reaction.viewerHasReacted }"
                :aria-label="`${REACTION_EMOJI[reaction.content]} ${reaction.count} 个回应`"
                @click="onReact(reply.id, reaction.content)"
              >{{ REACTION_EMOJI[reaction.content] }} <span>{{ reaction.count }}</span></button>
              <div class="reaction-add-wrap">
                <button type="button" class="reaction-add-btn" aria-label="添加表情回应" @click.stop="togglePicker(reply.id)">☺<span class="plus">+</span></button>
                <div v-if="pickerOpenFor === reply.id" class="reaction-picker" role="menu" aria-label="选择表情回应">
                  <button v-for="key in PICKER_REACTIONS" :key="key" type="button" class="picker-emoji" role="menuitem" :aria-label="key" @click="onReact(reply.id, key)">{{ REACTION_EMOJI[key] }}</button>
                </div>
              </div>
            </div>
            <button type="button" class="action-btn" @click="startReply(reply.author)">回复</button>
          </div>
        </div>
      </article>
    </div>

    <div v-if="replyingTo" class="reply-editor-section">
      <div v-if="replyMention" class="reply-indicator">
        回复 <span>@{{ replyMention }}</span>
        <button type="button" aria-label="取消指定用户" @click="replyMention = null">×</button>
      </div>
      <MarkdownEditor
        :placeholder="replyMention ? `回复 @${replyMention}...` : '写下你的回复... 支持 Markdown 语法'"
        :busy="busyAction === `reply:${id}`"
        :submit-label="busyAction === `reply:${id}` ? '提交中...' : '回复'"
        @submit="onReplySubmit"
        @cancel="replyingTo = false; replyMention = null"
      />
    </div>

    <p v-if="actionError" class="comment-error" role="alert">{{ actionError }}</p>
    <p v-if="copied" class="comment-success" role="status">链接已复制</p>
  </article>
</template>

<style scoped>
.comment-thread-item { position: relative; }
.comment-item { display: flex; gap: 12px; padding: 14px 0 6px; }
.compact .comment-item { gap: 10px; padding-top: 10px; }

.comment-avatar,
.reply-avatar {
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--vp-c-bg-soft);
}
.compact .comment-avatar { width: 30px; height: 30px; }
.reply-avatar { width: 28px; height: 28px; }
.avatar-fallback { display: inline-flex; align-items: center; justify-content: center; color: var(--vp-c-text-2); font-size: 12px; font-weight: 700; }

.comment-content,
.reply-content { flex: 1; min-width: 0; }
.comment-meta-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.comment-meta { display: flex; align-items: center; gap: 6px; min-width: 0; margin-bottom: 5px; flex-wrap: wrap; }
.comment-author { color: var(--vp-c-text-1); font-size: 13px; font-weight: 650; text-decoration: none; }
.comment-author:hover { color: var(--vp-c-brand-1); }
.comment-time,
.edited-label { color: var(--vp-c-text-2); font-size: 11px; }
.association-badge { padding: 1px 5px; border: 1px solid var(--vp-c-brand-2); border-radius: 999px; color: var(--vp-c-brand-1); font-size: 10px; line-height: 1.4; }

.comment-body { color: var(--vp-c-text-1); font-size: 14px; line-height: 1.72; overflow-wrap: anywhere; }
.comment-body :deep(p) { margin: 5px 0; }
.comment-body :deep(code) { padding: 2px 5px; border-radius: 4px; background: var(--vp-c-bg-soft); font-size: 13px; }
.comment-body :deep(pre) { overflow-x: auto; padding: 10px; border-radius: 8px; background: var(--vp-c-bg-soft); }
.comment-body :deep(pre code) { padding: 0; background: none; }
.comment-body :deep(blockquote) { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--vp-c-divider); color: var(--vp-c-text-2); }
.comment-body :deep(a) { color: var(--vp-c-brand-1); }
.comment-body :deep(img) { max-width: 100%; border-radius: 8px; }
.comment-body :deep(table) { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.comment-body :deep(th),
.comment-body :deep(td) { padding: 5px 8px; border: 1px solid var(--vp-c-divider); }
.comment-body :deep(.mention) { padding: 1px 4px; border-radius: 4px; background: var(--vp-c-brand-soft); font-weight: 600; text-decoration: none; }

.interaction-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 28px; margin-top: 7px; flex-wrap: wrap; }
.reactions-bar,
.comment-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.reaction-pill,
.reaction-add-btn,
.action-btn,
.icon-action {
  border: 0;
  background: transparent;
  color: var(--vp-c-text-2);
  cursor: pointer;
}
.reaction-pill { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border: 1px solid var(--vp-c-divider); border-radius: 999px; font-size: 12px; }
.reaction-pill:hover,
.reaction-active { border-color: var(--vp-c-brand-1); background: var(--vp-c-brand-soft); color: var(--vp-c-brand-1); }
.reaction-add-wrap,
.comment-menu-wrap { position: relative; }
.reaction-add-btn { position: relative; min-width: 30px; height: 25px; border: 1px dashed var(--vp-c-divider); border-radius: 999px; font-size: 14px; }
.reaction-add-btn:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }
.reaction-add-btn .plus { position: absolute; right: 4px; bottom: 0; font-size: 10px; }
.reaction-picker { position: absolute; z-index: 30; bottom: calc(100% + 7px); left: 0; display: flex; gap: 2px; padding: 5px; border: 1px solid var(--vp-c-divider); border-radius: 10px; background: var(--vp-c-bg-elv); box-shadow: 0 8px 24px rgba(0,0,0,.14); white-space: nowrap; }
.picker-emoji { width: 32px; height: 32px; border: 0; border-radius: 7px; background: transparent; font-size: 18px; cursor: pointer; }
.picker-emoji:hover { background: var(--vp-c-bg-soft); transform: scale(1.08); }
.action-btn { padding: 3px 6px; border-radius: 5px; font-size: 12px; }
.action-btn:hover { background: var(--vp-c-bg-soft); color: var(--vp-c-brand-1); }
.chevron { display: inline-block; margin-left: 2px; transition: transform .15s; }
.chevron.open { transform: rotate(180deg); }

.menu-trigger { min-width: 28px; padding: 2px 5px; border-radius: 5px; font-weight: 700; letter-spacing: 1px; }
.menu-trigger:hover { background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.comment-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 35; min-width: 145px; padding: 5px; border: 1px solid var(--vp-c-divider); border-radius: 9px; background: var(--vp-c-bg-elv); box-shadow: 0 8px 24px rgba(0,0,0,.13); }
.comment-menu button,
.comment-menu a { display: block; width: 100%; padding: 7px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--vp-c-text-2); font-size: 12px; text-align: left; text-decoration: none; cursor: pointer; }
.comment-menu button:hover,
.comment-menu a:hover { background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); }
.comment-menu .danger:hover { color: var(--vp-c-danger-1); }

.replies-section { margin: 6px 0 0 48px; padding-left: 14px; border-left: 2px solid var(--vp-c-divider); }
.compact .replies-section { margin-left: 40px; }
.reply-item { display: flex; gap: 9px; padding: 10px 0 4px; }
.reply-editor-section { margin: 10px 0 0 48px; }
.compact .reply-editor-section { margin-left: 40px; }
.reply-indicator { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 6px; padding: 4px 8px; border-radius: 6px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); font-size: 12px; }
.reply-indicator span { color: var(--vp-c-brand-1); }
.reply-indicator button { border: 0; background: transparent; color: inherit; cursor: pointer; }

.comment-error,
.comment-success { margin: 7px 0 0 48px; font-size: 12px; }
.comment-error { color: var(--vp-c-danger-1); }
.comment-success { color: var(--vp-c-success-1); }

@media (max-width: 640px) {
  .comment-item { gap: 9px; }
  .comment-avatar { width: 32px; height: 32px; }
  .replies-section,
  .compact .replies-section,
  .reply-editor-section,
  .compact .reply-editor-section { margin-left: 18px; padding-left: 10px; }
  .reaction-picker { position: fixed; left: 12px; right: 12px; bottom: 16px; justify-content: space-around; }
  .comment-menu { position: fixed; top: auto; right: 12px; bottom: 16px; left: 12px; }
}
</style>
