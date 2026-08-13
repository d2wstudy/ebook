import {
  type DiscussionMeta,
  type ReactionGroup,
  type ThreadComment,
  type ThreadEntry,
  type ThreadReply,
} from '@github-reader/core'
import { mapGitHubComment, mapGitHubReply } from '@github-reader/github'
import { ref, shallowReadonly } from 'vue'
import { readerConfig } from '../readerConfig'
import { readerDocument } from '../readerRuntime'
import { useAuth } from './useAuth'
import {
  addDiscussionComment,
  addDiscussionReply,
  createDiscussion,
  deleteDiscussionComment,
  findDiscussionWithComments,
  mutationContext,
  mutationContextFromDocumentId,
  updateDiscussionComment,
} from './useGithubGql'
import { createReactionToggler } from './useDiscussionThread'
import { discussionStorageKey } from './discussionConfig'

export type { ReactionGroup }
export type Reply = ThreadReply
export type Comment = ThreadComment

const comments = ref<Comment[]>([])
const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const discussion = ref<DiscussionMeta | null>(null)

const discussionByDocument = new Map<string, DiscussionMeta>()
const commentReadCategories = [...new Set(readerConfig.discussions.commentReadCategories)]
let currentDocumentId = ''
let loadSequence = 0

function storedDiscussionId(category: string, documentId: string): string | null {
  if (typeof sessionStorage === 'undefined') return null
  try { return sessionStorage.getItem(discussionStorageKey(category, documentId)) } catch { return null }
}

function storeDiscussion(meta: DiscussionMeta, documentId: string) {
  discussionByDocument.set(documentId, meta)
  if (typeof sessionStorage === 'undefined') return
  try { sessionStorage.setItem(discussionStorageKey(meta.category, documentId), meta.id) } catch { /* ignore */ }
}

export function useComments() {
  const { token } = useAuth()

  async function loadComments(routePath: string, force = false) {
    if (typeof window === 'undefined') return

    const documentId = readerDocument.getDocumentId(routePath)
    currentDocumentId = documentId
    const sequence = ++loadSequence

    comments.value = []
    discussion.value = null
    loaded.value = false
    loading.value = true
    error.value = null

    return doLoadComments(routePath, documentId, sequence, force)
  }

  async function doLoadComments(
    routePath: string,
    documentId: string,
    sequence: number,
    force: boolean,
  ) {
    try {
      const cached = discussionByDocument.get(documentId)
      const categories = cached ? [cached.category] : commentReadCategories

      let result: Awaited<ReturnType<typeof findDiscussionWithComments>> | null = null
      for (const category of categories) {
        const knownId = cached?.category === category
          ? cached.id
          : storedDiscussionId(category, documentId)
        const candidate = await findDiscussionWithComments(routePath, category, knownId, force)
        if (candidate.discussion) {
          result = candidate
          break
        }
      }

      if (sequence !== loadSequence || documentId !== currentDocumentId) return

      if (result?.discussion) {
        storeDiscussion(result.discussion, documentId)
        discussion.value = result.discussion
        comments.value = result.comments.map(mapComment)
      }
    } catch (cause) {
      if (sequence === loadSequence && documentId === currentDocumentId) {
        error.value = messageFromError(cause, '加载章节讨论失败。')
      }
    } finally {
      if (sequence === loadSequence && documentId === currentDocumentId) {
        loading.value = false
        loaded.value = true
      }
    }
  }

  async function ensureDiscussion(routePath: string): Promise<DiscussionMeta> {
    const documentId = readerDocument.getDocumentId(routePath)
    const existing = discussionByDocument.get(documentId)
      || (currentDocumentId === documentId ? discussion.value : null)
    if (existing) return existing

    for (const category of commentReadCategories) {
      const result = await findDiscussionWithComments(
        routePath,
        category,
        storedDiscussionId(category, documentId),
        true,
      )
      if (result.discussion) {
        storeDiscussion(result.discussion, documentId)
        if (currentDocumentId === documentId) discussion.value = result.discussion
        return result.discussion
      }
    }

    const category = readerConfig.discussions.commentCreateCategory
    const created = await createDiscussion(
      routePath,
      category,
      readerConfig.discussions.commentBody(documentId),
    )
    storeDiscussion(created, documentId)
    if (currentDocumentId === documentId) discussion.value = created
    return created
  }

  async function addComment(routePath: string, body: string) {
    if (!token.value) throw new Error('请先登录 GitHub。')
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)

    try {
      const meta = await ensureDiscussion(routePath)
      const context = mutationContext(routePath, meta.category, meta.id)
      const newComment = await addDiscussionComment(context, body)
      if (currentDocumentId === documentId) {
        comments.value = [...comments.value, mapComment(newComment)]
      }
    } catch (cause) {
      error.value = messageFromError(cause, '发表评论失败。')
      throw cause
    }
  }

  async function replyToComment(routePath: string, commentId: string, body: string) {
    if (!token.value) throw new Error('请先登录 GitHub。')
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)

    try {
      const meta = await ensureDiscussion(routePath)
      const context = mutationContext(routePath, meta.category, meta.id)
      const newReply = await addDiscussionReply(context, commentId, body)
      if (currentDocumentId === documentId) {
        const parent = comments.value.find(comment => comment.id === commentId)
        if (parent) parent.replies = [...parent.replies, mapGitHubReply(newReply)]
      }
    } catch (cause) {
      error.value = messageFromError(cause, '发表回复失败。')
      throw cause
    }
  }

  async function editComment(routePath: string, subjectId: string, body: string) {
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)
    try {
      const meta = await ensureDiscussion(routePath)
      const updated = await updateDiscussionComment(
        mutationContext(routePath, meta.category, meta.id),
        subjectId,
        body,
      )
      if (currentDocumentId === documentId) updateLocalComment(subjectId, updated)
    } catch (cause) {
      error.value = messageFromError(cause, '更新内容失败。')
      throw cause
    }
  }

  async function removeComment(routePath: string, subjectId: string) {
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)
    try {
      const meta = await ensureDiscussion(routePath)
      await deleteDiscussionComment(mutationContext(routePath, meta.category, meta.id), subjectId)
      if (currentDocumentId === documentId) {
        const topLevelIndex = comments.value.findIndex(comment => comment.id === subjectId)
        if (topLevelIndex >= 0) {
          comments.value = comments.value.filter(comment => comment.id !== subjectId)
        } else {
          for (const comment of comments.value) {
            if (comment.replies.some(reply => reply.id === subjectId)) {
              comment.replies = comment.replies.filter(reply => reply.id !== subjectId)
              break
            }
          }
        }
      }
    } catch (cause) {
      error.value = messageFromError(cause, '删除内容失败。')
      throw cause
    }
  }

  const toggleReaction = createReactionToggler((subjectId) => {
    for (const comment of comments.value) {
      if (comment.id === subjectId) return comment
      const reply = comment.replies.find(item => item.id === subjectId)
      if (reply) return reply
    }
    return null
  }, () => discussion.value && currentDocumentId
    ? mutationContextFromDocumentId(currentDocumentId, discussion.value.category, discussion.value.id)
    : null)

  function clearError() {
    error.value = null
  }

  return {
    comments: shallowReadonly(comments),
    discussion: shallowReadonly(discussion),
    loaded: shallowReadonly(loaded),
    loading: shallowReadonly(loading),
    error: shallowReadonly(error),
    loadComments,
    addComment,
    replyToComment,
    editComment,
    removeComment,
    toggleReaction,
    clearError,
  }
}

function mapComment(raw: unknown): Comment {
  return mapGitHubComment(raw)
}

function updateLocalComment(subjectId: string, raw: ThreadEntry) {
  const topLevel = comments.value.find(comment => comment.id === subjectId)
  if (topLevel) {
    topLevel.body = raw.body
    topLevel.lastEditedAt = raw.lastEditedAt || new Date().toISOString()
    return
  }

  for (const comment of comments.value) {
    const reply = comment.replies.find(item => item.id === subjectId)
    if (reply) {
      reply.body = raw.body
      reply.lastEditedAt = raw.lastEditedAt || new Date().toISOString()
      return
    }
  }
}

function messageFromError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
