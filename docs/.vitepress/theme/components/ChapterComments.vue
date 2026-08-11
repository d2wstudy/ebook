<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vitepress'
import { useAuth } from '../composables/useAuth'
import { useComments } from '../composables/useComments'
import { purgeWorkerCache } from '../composables/useGithubGql'
import MarkdownEditor from './MarkdownEditor.vue'
import CommentItem from './CommentItem.vue'

const { user, token, login } = useAuth()
const {
  comments,
  discussion,
  loaded,
  loading,
  error,
  loadComments,
  addComment,
  replyToComment,
  editComment,
  removeComment,
  toggleReaction,
  clearError,
} = useComments()
const route = useRoute()

const showEditor = ref(false)
const submitting = ref(false)

const totalCount = computed(() =>
  comments.value.reduce((sum, comment) => sum + 1 + comment.replies.length, 0))

watch(() => route.path, path => {
  showEditor.value = false
  void loadComments(path)
}, { immediate: true })

watch(token, () => {
  if (typeof window !== 'undefined') void loadComments(route.path, true)
})

async function onSubmit(text: string) {
  if (submitting.value) return
  submitting.value = true
  clearError()
  try {
    await addComment(route.path, text)
    showEditor.value = false
  } catch {
    // Keep the draft visible; the composable exposes the detailed error.
  } finally {
    submitting.value = false
  }
}

async function onReply(commentId: string, body: string) {
  await replyToComment(route.path, commentId, body)
}

async function onReact(subjectId: string, content: string) {
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

async function onEdit(subjectId: string, body: string) {
  await editComment(route.path, subjectId, body)
}

async function onDelete(subjectId: string) {
  await removeComment(route.path, subjectId)
}
</script>

<template>
  <section class="chapter-comments" aria-labelledby="chapter-comments-title">
    <header class="comments-header">
      <div>
        <h2 id="chapter-comments-title">章节讨论 <span>{{ totalCount }}</span></h2>
        <p>评论、回复和表情回应会同步到 GitHub Discussions。</p>
      </div>
      <a
        v-if="discussion?.url"
        class="discussion-link"
        :href="discussion.url"
        target="_blank"
        rel="noopener noreferrer"
      >在 GitHub 查看</a>
    </header>

    <div v-if="error" class="comments-message error-message" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="loadComments(route.path, true)">重试</button>
    </div>

    <div class="comments-composer">
      <template v-if="user">
        <button v-if="!showEditor" type="button" class="comment-input-placeholder" @click="showEditor = true">
          <img :src="user.avatar_url" class="comment-avatar-sm" :alt="user.login" />
          <span>分享你对本章的理解、疑问或补充...</span>
        </button>
        <MarkdownEditor
          v-else
          placeholder="分享你对本章的理解、疑问或补充... 支持 Markdown"
          :busy="submitting"
          :submit-label="submitting ? '提交中...' : '发表评论'"
          @submit="onSubmit"
          @cancel="showEditor = false"
        />
      </template>
      <div v-else class="comments-login">
        <div>
          <strong>加入章节讨论</strong>
          <p>使用 GitHub 登录后即可评论、回复和添加表情回应。</p>
        </div>
        <button type="button" class="login-btn" @click="login">登录 GitHub</button>
      </div>
    </div>

    <div v-if="loading" class="comments-loading" aria-label="正在加载评论">
      <span v-for="item in 3" :key="item" />
    </div>

    <div v-else-if="loaded && comments.length" class="comments-list">
      <CommentItem
        v-for="comment in comments"
        :key="comment.id"
        :id="comment.id"
        :body="comment.body"
        :author="comment.author"
        :author-avatar="comment.authorAvatar"
        :created-at="comment.createdAt"
        :last-edited-at="comment.lastEditedAt"
        :url="comment.url"
        :author-association="comment.authorAssociation"
        :reactions="comment.reactions"
        :replies="comment.replies"
        :reply-action="onReply"
        :react-action="onReact"
        :edit-action="onEdit"
        :delete-action="onDelete"
      />
    </div>

    <div v-else-if="loaded && !error" class="comments-empty">
      <span aria-hidden="true">💬</span>
      <strong>还没有公开讨论</strong>
      <p>{{ user ? '成为第一个发表评论的人。' : '登录后可以发起本章的第一个讨论。' }}</p>
    </div>
  </section>
</template>

<style scoped>
.chapter-comments { margin-top: 56px; padding-top: 28px; border-top: 1px solid var(--vp-c-divider); }
.comments-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
.comments-header h2 { margin: 0; border: 0; color: var(--vp-c-text-1); font-size: 18px; line-height: 1.4; }
.comments-header h2 span { display: inline-grid; place-items: center; min-width: 24px; height: 20px; margin-left: 4px; padding: 0 6px; border-radius: 999px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); font-size: 11px; vertical-align: 2px; }
.comments-header p { margin: 3px 0 0; color: var(--vp-c-text-2); font-size: 12px; }
.discussion-link { flex: 0 0 auto; padding: 5px 9px; border: 1px solid var(--vp-c-divider); border-radius: 7px; color: var(--vp-c-text-2); font-size: 11px; text-decoration: none; }
.discussion-link:hover { border-color: var(--vp-c-brand-1); color: var(--vp-c-brand-1); }

.comments-composer { margin-bottom: 22px; }
.comment-input-placeholder { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 14px; border: 1px solid var(--vp-c-divider); border-radius: 11px; background: var(--vp-c-bg); color: var(--vp-c-text-2); font-size: 13px; text-align: left; cursor: text; transition: border-color .15s, box-shadow .15s; }
.comment-input-placeholder:hover { border-color: var(--vp-c-brand-1); box-shadow: 0 0 0 3px var(--vp-c-brand-soft); }
.comment-avatar-sm { width: 30px; height: 30px; border-radius: 50%; }
.comments-login { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 16px; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: var(--vp-c-bg-soft); }
.comments-login strong { color: var(--vp-c-text-1); font-size: 13px; }
.comments-login p { margin: 2px 0 0; color: var(--vp-c-text-2); font-size: 11px; }
.login-btn { flex: 0 0 auto; padding: 7px 13px; border: 1px solid var(--vp-c-brand-1); border-radius: 8px; background: var(--vp-c-brand-1); color: white; font-size: 12px; cursor: pointer; }
.login-btn:hover { opacity: .9; }

.comments-list { display: grid; gap: 2px; }
.comments-list :deep(.comment-thread-item) { padding-bottom: 12px; border-bottom: 1px solid var(--vp-c-divider); }
.comments-list :deep(.comment-thread-item:last-child) { border-bottom: 0; }

.comments-message { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; padding: 10px 12px; border-radius: 9px; font-size: 12px; }
.error-message { background: color-mix(in srgb, var(--vp-c-danger-1) 10%, transparent); color: var(--vp-c-danger-1); }
.comments-message button { padding: 3px 8px; border: 1px solid currentColor; border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.comments-loading { display: grid; gap: 12px; }
.comments-loading span { height: 112px; border-radius: 10px; background: linear-gradient(90deg, var(--vp-c-bg-soft), var(--vp-c-bg-mute), var(--vp-c-bg-soft)); background-size: 200% 100%; animation: loading 1.3s infinite linear; }
@keyframes loading { to { background-position: -200% 0; } }
.comments-empty { display: grid; place-items: center; padding: 34px 16px; border: 1px dashed var(--vp-c-divider); border-radius: 12px; color: var(--vp-c-text-2); text-align: center; }
.comments-empty span { font-size: 24px; }
.comments-empty strong { margin-top: 6px; color: var(--vp-c-text-2); font-size: 13px; }
.comments-empty p { margin: 3px 0 0; font-size: 11px; }

@media (max-width: 640px) {
  .comments-header,
  .comments-login { align-items: stretch; flex-direction: column; }
  .discussion-link,
  .login-btn { align-self: flex-start; }
}
</style>
