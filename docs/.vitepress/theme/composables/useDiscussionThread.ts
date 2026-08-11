import {
  createOptimisticReactionToggler,
  type ReactionGroup,
  type ThreadReply,
} from '@github-reader/core'
import { mapGitHubReactions, mapGitHubReply } from '@github-reader/github'
import { useAuth } from './useAuth'
import { addReaction, removeReaction } from './useGithubGql'

export type { ReactionGroup, ThreadReply }
export const mapReactions = mapGitHubReactions
export const mapReply = mapGitHubReply

/** Vue/auth bridge around the provider-independent optimistic reaction reducer. */
export function createReactionToggler(
  findTarget: (subjectId: string) => { reactions: ReactionGroup[] } | null,
) {
  const { token } = useAuth()
  const toggle = createOptimisticReactionToggler(
    findTarget,
    async (subjectId, content, add) => {
      if (!token.value) throw new Error('请先登录 GitHub。')
      if (add) await addReaction(subjectId, content)
      else await removeReaction(subjectId, content)
    },
  )

  return async (subjectId: string, content: string) => {
    if (!token.value) return
    return toggle(subjectId, content)
  }
}

export function formatRelativeTime(iso: string): string {
  const date = new Date(iso)
  const difference = Date.now() - date.getTime()
  if (difference < 60000) return '刚刚'
  if (difference < 3600000) return `${Math.floor(difference / 60000)} 分钟前`
  if (difference < 86400000) return `${Math.floor(difference / 3600000)} 小时前`
  if (difference < 2592000000) return `${Math.floor(difference / 86400000)} 天前`
  return date.toLocaleDateString('zh-CN')
}
