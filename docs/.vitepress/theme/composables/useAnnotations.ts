import {
  decodeAnnotationBody,
  encodeAnnotationBody,
  type AnnotationAnchor as CoreAnnotationAnchor,
  type AnnotationThread as CoreAnnotationThread,
  type DiscussionMeta,
  type ThreadComment,
  type ThreadReply,
} from '@github-reader/core'
import { mapGitHubComment } from '@github-reader/github'
import { ref, shallowReadonly } from 'vue'
import { readerConfig, type ReaderLanguage } from '../readerConfig'
import { readerDocument } from '../readerRuntime'
import { useAuth } from './useAuth'
import {
  addDiscussionComment,
  addDiscussionReply,
  createDiscussion,
  deleteDiscussionComment,
  findDiscussionWithComments,
  purgeWorkerCache,
  updateDiscussionComment,
} from './useGithubGql'
import { createReactionToggler, mapReply } from './useDiscussionThread'
import { ANNOTATION_CATEGORY, discussionStorageKey } from './discussionConfig'

export type AnnotationAnchor = CoreAnnotationAnchor<ReaderLanguage>
export type AnnotationThread = CoreAnnotationThread<ReaderLanguage>

const annotations = ref<Map<string, AnnotationThread[]>>(new Map())
const loaded = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const discussion = ref<DiscussionMeta | null>(null)

const discussionByDocument = new Map<string, DiscussionMeta>()
let currentDocumentId = ''
let loadSequence = 0

function storedDiscussionId(documentId: string): string | null {
  if (typeof sessionStorage === 'undefined') return null
  try { return sessionStorage.getItem(discussionStorageKey(ANNOTATION_CATEGORY, documentId)) } catch { return null }
}

function storeDiscussion(meta: DiscussionMeta, documentId: string) {
  discussionByDocument.set(documentId, meta)
  if (typeof sessionStorage === 'undefined') return
  try { sessionStorage.setItem(discussionStorageKey(meta.category, documentId), meta.id) } catch { /* ignore */ }
}

export function useAnnotations() {
  const { token } = useAuth()

  async function loadAnnotations(routePath: string, force = false) {
    if (typeof window === 'undefined') return

    const documentId = readerDocument.getDocumentId(routePath)
    currentDocumentId = documentId
    const sequence = ++loadSequence

    annotations.value = new Map()
    discussion.value = null
    loaded.value = false
    loading.value = true
    error.value = null

    return doLoadAnnotations(routePath, documentId, sequence, force)
  }

  async function doLoadAnnotations(
    routePath: string,
    documentId: string,
    sequence: number,
    force: boolean,
  ) {
    try {
      const cached = discussionByDocument.get(documentId)
      const knownId = cached?.id || storedDiscussionId(documentId)
      const result = await findDiscussionWithComments(
        routePath,
        ANNOTATION_CATEGORY,
        knownId,
        force,
      )

      if (sequence !== loadSequence || documentId !== currentDocumentId) return

      const map = new Map<string, AnnotationThread[]>()
      if (result.discussion) {
        storeDiscussion(result.discussion, documentId)
        discussion.value = result.discussion
      }

      for (const raw of result.comments) {
        const thread = parseAnnotation(raw, documentId)
        if (thread) indexThread(map, thread)
      }
      annotations.value = map
    } catch (cause) {
      if (sequence === loadSequence && documentId === currentDocumentId) {
        error.value = messageFromError(cause, '加载读者笔记失败。')
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

    const result = await findDiscussionWithComments(
      routePath,
      ANNOTATION_CATEGORY,
      storedDiscussionId(documentId),
      true,
    )
    if (result.discussion) {
      storeDiscussion(result.discussion, documentId)
      if (currentDocumentId === documentId) discussion.value = result.discussion
      return result.discussion
    }

    const created = await createDiscussion(
      routePath,
      ANNOTATION_CATEGORY,
      readerConfig.discussions.annotationBody(documentId),
    )
    storeDiscussion(created, documentId)
    if (currentDocumentId === documentId) discussion.value = created
    return created
  }

  async function addAnnotation(
    routePath: string,
    anchor: AnnotationAnchor,
    note: string,
    segments?: AnnotationAnchor[],
  ) {
    if (!token.value) throw new Error('请先登录 GitHub。')
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)

    try {
      const meta = await ensureDiscussion(routePath)
      const body = encodeAnnotationBody({ documentId, anchor, note, segments })
      const newComment = await addDiscussionComment(meta.id, body)
      const thread = buildThread(newComment, anchor, note, segments)

      if (currentDocumentId === documentId) {
        const map = new Map(annotations.value)
        indexThread(map, thread)
        annotations.value = map
      }
      await purgeWorkerCache(routePath, meta.category, false, undefined, meta.id)
    } catch (cause) {
      error.value = messageFromError(cause, '添加笔记失败。')
      throw cause
    }
  }

  async function replyToAnnotation(routePath: string, threadId: string, body: string) {
    if (!token.value) throw new Error('请先登录 GitHub。')
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)

    try {
      const meta = await ensureDiscussion(routePath)
      const newReply = await addDiscussionReply(meta.id, threadId, body)
      if (currentDocumentId === documentId) {
        const parent = findThread(threadId)
        if (parent) parent.replies = [...parent.replies, mapReply(newReply)]
      }
      await purgeWorkerCache(routePath, meta.category, false, undefined, meta.id)
    } catch (cause) {
      error.value = messageFromError(cause, '发表回复失败。')
      throw cause
    }
  }

  async function editAnnotationContent(routePath: string, subjectId: string, body: string) {
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)
    try {
      const thread = findThread(subjectId)
      const apiBody = thread
        ? encodeAnnotationBody({
            documentId,
            anchor: thread.anchor,
            note: body,
            segments: thread.segments,
          })
        : body
      const updated = await updateDiscussionComment(subjectId, apiBody)

      if (thread && currentDocumentId === documentId) {
        thread.note = body
        thread.lastEditedAt = updated.lastEditedAt || new Date().toISOString()
      } else if (currentDocumentId === documentId) {
        const reply = findReply(subjectId)
        if (reply) {
          reply.body = updated.body
          reply.lastEditedAt = updated.lastEditedAt || new Date().toISOString()
        }
      }

      const meta = await ensureDiscussion(routePath)
      await purgeWorkerCache(routePath, meta.category, false, undefined, meta.id)
    } catch (cause) {
      error.value = messageFromError(cause, '更新笔记失败。')
      throw cause
    }
  }

  async function removeAnnotationContent(routePath: string, subjectId: string) {
    error.value = null
    const documentId = readerDocument.getDocumentId(routePath)
    try {
      await deleteDiscussionComment(subjectId)

      if (currentDocumentId !== documentId) {
        // The GitHub mutation succeeded, but the reader has navigated away.
      } else if (findThread(subjectId)) {
        const map = new Map<string, AnnotationThread[]>()
        for (const thread of uniqueThreads()) {
          if (thread.id !== subjectId) indexThread(map, thread)
        }
        annotations.value = map
      } else {
        const reply = findReply(subjectId)
        if (reply) {
          for (const thread of uniqueThreads()) {
            thread.replies = thread.replies.filter(item => item.id !== subjectId)
          }
        }
      }

      const meta = await ensureDiscussion(routePath)
      await purgeWorkerCache(routePath, meta.category, false, undefined, meta.id)
    } catch (cause) {
      error.value = messageFromError(cause, '删除笔记失败。')
      throw cause
    }
  }

  const toggleReaction = createReactionToggler((subjectId) => {
    const thread = findThread(subjectId)
    return thread || findReply(subjectId)
  })

  function clearError() {
    error.value = null
  }

  return {
    annotations: shallowReadonly(annotations),
    discussion: shallowReadonly(discussion),
    loaded: shallowReadonly(loaded),
    loading: shallowReadonly(loading),
    error: shallowReadonly(error),
    loadAnnotations,
    addAnnotation,
    replyToAnnotation,
    editAnnotationContent,
    removeAnnotationContent,
    toggleReaction,
    clearError,
  }
}

/** Parse both legacy GitHub JSON comments and the readable v3 annotation format. */
export function parseAnnotation(raw: unknown, expectedDocumentId?: string): AnnotationThread | null {
  const comment = mapGitHubComment(raw)
  if (!comment.id || typeof comment.body !== 'string') return null

  const record = decodeAnnotationBody(comment.body)
  if (!record) return null
  if (expectedDocumentId && record.documentId && record.documentId !== expectedDocumentId) return null

  return {
    id: comment.id,
    anchor: record.anchor as AnnotationAnchor,
    ...(record.segments?.length ? { segments: record.segments as AnnotationAnchor[] } : {}),
    note: record.note,
    author: comment.author,
    authorAvatar: comment.authorAvatar,
    createdAt: comment.createdAt,
    lastEditedAt: comment.lastEditedAt,
    url: comment.url,
    authorAssociation: comment.authorAssociation,
    replies: comment.replies,
    reactions: comment.reactions,
  }
}

function buildThread(
  raw: ThreadComment,
  anchor: AnnotationAnchor,
  note: string,
  segments?: AnnotationAnchor[],
): AnnotationThread {
  const comment = mapGitHubComment(raw)
  return {
    id: comment.id,
    anchor,
    ...(segments?.length ? { segments } : {}),
    note,
    author: comment.author,
    authorAvatar: comment.authorAvatar,
    createdAt: comment.createdAt,
    lastEditedAt: comment.lastEditedAt,
    url: comment.url,
    authorAssociation: comment.authorAssociation,
    replies: comment.replies,
    reactions: comment.reactions,
  }
}

function indexThread(map: Map<string, AnnotationThread[]>, thread: AnnotationThread) {
  const paragraphIds = thread.segments?.length
    ? [...new Set(thread.segments.map(segment => segment.paragraphId))]
    : [thread.anchor.paragraphId]

  for (const paragraphId of paragraphIds) {
    const list = map.get(paragraphId) || []
    if (!list.some(item => item.id === thread.id)) list.push(thread)
    map.set(paragraphId, list)
  }
}

function uniqueThreads(): AnnotationThread[] {
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

function findThread(threadId: string): AnnotationThread | null {
  return uniqueThreads().find(thread => thread.id === threadId) || null
}

function findReply(replyId: string): ThreadReply | null {
  for (const thread of uniqueThreads()) {
    const reply = thread.replies.find(item => item.id === replyId)
    if (reply) return reply
  }
  return null
}

function messageFromError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}
