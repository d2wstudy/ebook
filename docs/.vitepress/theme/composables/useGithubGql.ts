import type {
  DiscussionMeta,
  DiscussionMutationContext,
  DiscussionThreadResult,
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

export function mutationContext(
  routePath: string,
  categoryName: string,
  knownDiscussionId?: string | null,
): DiscussionMutationContext {
  return mutationContextFromDocumentId(
    readerDocument.getDocumentId(routePath),
    categoryName,
    knownDiscussionId,
  )
}

export function mutationContextFromDocumentId(
  documentId: string,
  categoryName: string,
  knownDiscussionId?: string | null,
): DiscussionMutationContext {
  return {
    documentId,
    categoryName,
    discussionId: knownDiscussionId,
  }
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

export function addDiscussionComment(context: DiscussionMutationContext, body: string): Promise<ThreadComment> {
  return githubDiscussionProvider.addComment(context, body)
}

export function addDiscussionReply(
  context: DiscussionMutationContext,
  replyToId: string,
  body: string,
): Promise<ThreadReply> {
  return githubDiscussionProvider.addReply(context, replyToId, body)
}

export function updateDiscussionComment(
  context: DiscussionMutationContext,
  commentId: string,
  body: string,
): Promise<ThreadEntry> {
  return githubDiscussionProvider.updateComment(context, commentId, body)
}

export function deleteDiscussionComment(context: DiscussionMutationContext, commentId: string): Promise<void> {
  return githubDiscussionProvider.deleteComment(context, commentId)
}

export function addReaction(
  context: DiscussionMutationContext,
  subjectId: string,
  content: string,
): Promise<void> {
  return githubDiscussionProvider.addReaction(context, subjectId, content)
}

export function removeReaction(
  context: DiscussionMutationContext,
  subjectId: string,
  content: string,
): Promise<void> {
  return githubDiscussionProvider.removeReaction(context, subjectId, content)
}
