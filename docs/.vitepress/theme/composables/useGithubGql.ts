import type {
  DiscussionMeta,
  DiscussionThreadResult,
  ReactionDelta,
  ThreadComment,
  ThreadEntry,
  ThreadReply,
} from '@github-reader/core'
import { GitHubProviderError } from '@github-reader/github'
import { githubDiscussionProvider, readerDocument } from '../readerRuntime'

export { GitHubProviderError as GithubApiError }

/** Application adapter: route path → stable document ID → generic provider. */
export async function findDiscussionWithComments(
  routePath: string,
  categoryName: string,
  knownDiscussionId?: string | null,
  force = false,
): Promise<DiscussionThreadResult> {
  return githubDiscussionProvider.findDiscussion(
    readerDocument.getDocumentId(routePath),
    categoryName,
    knownDiscussionId,
    force,
  )
}

export async function purgeWorkerCache(
  routePath: string,
  categoryName: string,
  userOnly = false,
  reactionDelta?: ReactionDelta,
  knownDiscussionId?: string | null,
): Promise<boolean> {
  return githubDiscussionProvider.purgeCache(
    readerDocument.getDocumentId(routePath),
    categoryName,
    userOnly,
    reactionDelta,
    knownDiscussionId,
  )
}

export async function createDiscussion(
  routePath: string,
  categoryName: string,
  bodyText: string,
): Promise<DiscussionMeta> {
  return githubDiscussionProvider.createDiscussion(
    readerDocument.getDocumentId(routePath),
    categoryName,
    bodyText,
  )
}

export function addDiscussionComment(discussionId: string, body: string): Promise<ThreadComment> {
  return githubDiscussionProvider.addComment(discussionId, body)
}

export function addDiscussionReply(
  discussionId: string,
  replyToId: string,
  body: string,
): Promise<ThreadReply> {
  return githubDiscussionProvider.addReply(discussionId, replyToId, body)
}

export function updateDiscussionComment(commentId: string, body: string): Promise<ThreadEntry> {
  return githubDiscussionProvider.updateComment(commentId, body)
}

export function deleteDiscussionComment(commentId: string): Promise<void> {
  return githubDiscussionProvider.deleteComment(commentId)
}

export function addReaction(subjectId: string, content: string): Promise<void> {
  return githubDiscussionProvider.addReaction(subjectId, content)
}

export function removeReaction(subjectId: string, content: string): Promise<void> {
  return githubDiscussionProvider.removeReaction(subjectId, content)
}

export function getCategoryId(categoryName: string): Promise<string | null> {
  return githubDiscussionProvider.getCategoryId(categoryName)
}

export function gql(query: string, variables: Record<string, unknown>) {
  return githubDiscussionProvider.gql(query, variables)
}
