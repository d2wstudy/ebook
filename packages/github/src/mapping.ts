import {
  sortReactions,
  type ReactionGroup,
  type ThreadComment,
  type ThreadEntry,
  type ThreadReply,
} from '@github-reader/core'

export function mapGitHubReactions(groups: any[] | null | undefined): ReactionGroup[] {
  if (!Array.isArray(groups)) return []
  return sortReactions(
    groups
      .map(group => ({
        content: String(group?.content || ''),
        count: Number(group?.reactors?.totalCount ?? group?.users?.totalCount ?? 0),
        viewerHasReacted: !!group?.viewerHasReacted,
      }))
      .filter(group => group.content && (group.count > 0 || group.viewerHasReacted)),
  )
}

export function mapGitHubEntry(raw: any): ThreadEntry {
  return {
    id: String(raw?.id || ''),
    body: typeof raw?.body === 'string' ? raw.body : '',
    author: typeof raw?.author === 'string' ? raw.author : raw?.author?.login || 'ghost',
    authorAvatar: raw?.authorAvatar || raw?.author?.avatarUrl || '',
    createdAt: raw?.createdAt || '',
    lastEditedAt: raw?.lastEditedAt || null,
    url: raw?.url || '',
    authorAssociation: raw?.authorAssociation || 'NONE',
    reactions: Array.isArray(raw?.reactions)
      ? raw.reactions.map((reaction: ReactionGroup) => ({ ...reaction }))
      : mapGitHubReactions(raw?.reactionGroups),
  }
}

export function mapGitHubReply(raw: any): ThreadReply {
  return mapGitHubEntry(raw)
}

export function mapGitHubComment(raw: any): ThreadComment {
  return {
    ...mapGitHubEntry(raw),
    replies: Array.isArray(raw?.replies)
      ? raw.replies.map(mapGitHubReply)
      : Array.isArray(raw?.replies?.nodes)
        ? raw.replies.nodes.map(mapGitHubReply)
        : [],
  }
}
