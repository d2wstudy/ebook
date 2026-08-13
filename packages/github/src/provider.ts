import type {
  DiscussionMeta,
  DiscussionMutationContext,
  DiscussionProvider,
  DiscussionThreadResult,
  ThreadComment,
  ThreadEntry,
  ThreadReply,
} from '@github-reader/core'
import { mapGitHubComment, mapGitHubEntry, mapGitHubReply } from './mapping'

export interface GitHubAuthBridge {
  getToken(): string | null
  refresh(): Promise<string | null>
}

export interface GitHubDiscussionProviderConfig {
  owner: string
  repo: string
  workerUrl: string
}

export interface GitHubDiscussionProvider extends DiscussionProvider {}

export class GitHubProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message)
    this.name = 'GitHubProviderError'
  }
}

const COMMENT_MUTATION_FIELDS = `
  id body createdAt lastEditedAt url authorAssociation
  author { login avatarUrl }
  reactionGroups { content viewerHasReacted reactors { totalCount } }
`

export function createGitHubDiscussionProvider(
  rawConfig: GitHubDiscussionProviderConfig,
  auth: GitHubAuthBridge,
): GitHubDiscussionProvider {
  const config = {
    ...rawConfig,
    workerUrl: rawConfig.workerUrl.replace(/\/+$/, ''),
  }
  const inflightDiscussions = new Map<string, Promise<DiscussionThreadResult>>()
  let repoMetaPromise: Promise<{ repoId: string; categories: Map<string, string> }> | null = null
  let repoMetaToken: string | null = null

  async function gql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    let token = auth.getToken()
    if (!token) throw new GitHubProviderError('请先登录 GitHub。', 401)

    let response = await githubGraphQlRequest(token, query, variables)
    if (response.status === 401) {
      const latest = auth.getToken()
      const refreshed = latest && latest !== token ? latest : await auth.refresh()
      if (refreshed) {
        token = refreshed
        response = await githubGraphQlRequest(token, query, variables)
      }
    }

    const json = await safeJson(response)
    if (response.status === 401) {
      throw new GitHubProviderError('GitHub 登录已失效，请重新登录。', 401)
    }
    if (response.status === 403 || response.status === 429) {
      throw new GitHubProviderError('GitHub API 速率限制或权限校验未通过，请稍后重试。', response.status)
    }
    if (!response.ok) {
      throw new GitHubProviderError(`GitHub API 请求失败（${response.status}）。`, response.status)
    }
    if (Array.isArray(json.errors) && json.errors.length) {
      const message = json.errors
        .map((item: { message?: string }) => item.message)
        .filter(Boolean)
        .join('；')
      throw new GitHubProviderError(message || 'GitHub GraphQL 请求失败。')
    }
    return json.data || {}
  }

  async function githubGraphQlRequest(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Response> {
    try {
      return await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      })
    } catch {
      throw new GitHubProviderError('无法连接 GitHub API。')
    }
  }

  async function fetchRepositoryMeta(): Promise<{ repoId: string; categories: Map<string, string> }> {
    const data = await gql(`query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        id
        discussionCategories(first: 50) { nodes { id name } }
      }
    }`, { owner: config.owner, name: config.repo })

    const repoId = data?.repository?.id as string | undefined
    if (!repoId) throw new GitHubProviderError('无法读取 GitHub 仓库信息。')

    const categories = new Map<string, string>()
    for (const category of data.repository.discussionCategories?.nodes || []) {
      categories.set(category.name, category.id)
    }
    return { repoId, categories }
  }

  function getRepositoryMeta() {
    const token = auth.getToken()
    if (!token) return Promise.reject(new GitHubProviderError('请先登录 GitHub。', 401))
    if (!repoMetaPromise || repoMetaToken !== token) {
      repoMetaToken = token
      repoMetaPromise = fetchRepositoryMeta().catch(error => {
        repoMetaPromise = null
        repoMetaToken = null
        throw error
      })
    }
    return repoMetaPromise
  }

  async function fetchViaWorker(
    documentId: string,
    categoryName: string,
    knownDiscussionId?: string | null,
    force = false,
  ): Promise<DiscussionThreadResult> {
    const params = new URLSearchParams({ path: documentId, category: categoryName })
    if (knownDiscussionId) params.set('id', knownDiscussionId)
    if (force) {
      await sendCacheInvalidation({ documentId, categoryName })
    }

    let response: Response
    try {
      response = await fetch(`${config.workerUrl}/api/discussions?${params}`)
    } catch {
      throw new GitHubProviderError('无法连接评论服务，请稍后重试。')
    }

    const data = await safeJson(response)
    if (!response.ok) {
      throw new GitHubProviderError(
        typeof data?.error === 'string' ? data.error : `评论服务请求失败（${response.status}）。`,
        response.status,
      )
    }

    const discussion = data.discussion || (data.discussionId
      ? {
          id: data.discussionId,
          url: data.discussionUrl || '',
          number: data.discussionNumber || 0,
          category: data.category || categoryName,
        }
      : null)
    const comments = Array.isArray(data.comments) ? data.comments : []
    try {
      await overlayViewerReactions(comments)
    } catch {
      // Shared discussion data remains readable if the viewer overlay is rate-limited.
    }

    return {
      discussion,
      comments: comments.map(mapGitHubComment),
    }
  }

  async function overlayViewerReactions(comments: any[]): Promise<void> {
    if (!auth.getToken()) return
    const ids = collectCommentIds(comments)
    if (!ids.length) return

    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100)
      const data = await gql(`query($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on DiscussionComment {
            id
            reactionGroups { content viewerHasReacted }
          }
        }
      }`, { ids: batch })
      const overlay = new Map<string, Map<string, boolean>>()
      for (const node of data.nodes || []) {
        if (!node?.id) continue
        overlay.set(node.id, new Map(
          (node.reactionGroups || []).map((group: any) => [group.content, group.viewerHasReacted === true]),
        ))
      }
      forEachComment(comments, comment => {
        const reactions = overlay.get(comment.id)
        if (!reactions) return
        for (const group of comment.reactionGroups || []) {
          group.viewerHasReacted = reactions.get(group.content) === true
        }
      })
    }
  }

  function notifyCache(context: DiscussionMutationContext): void {
    void sendCacheInvalidation(context)
  }

  async function sendCacheInvalidation(context: DiscussionMutationContext): Promise<void> {
    const body = {
      documentId: context.documentId,
      categoryName: context.categoryName,
      dropCache: context.dropCache === true,
    }
    try {
      await fetch(`${config.workerUrl}/api/cache/invalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
      })
    } catch {
      // GitHub is authoritative; this request only accelerates shared-cache refresh.
    }
  }

  async function mutation<T>(
    context: DiscussionMutationContext,
    query: string,
    variables: Record<string, unknown>,
    select: (data: Record<string, any>) => T | null | undefined,
    failureMessage: string,
  ): Promise<T> {
    const data = await gql(query, variables)
    const result = select(data)
    if (result === null || result === undefined) throw new GitHubProviderError(failureMessage)
    notifyCache(context)
    return result
  }

  const provider: GitHubDiscussionProvider = {
    async findDiscussion(
      documentId: string,
      categoryName: string,
      knownDiscussionId?: string | null,
      force = false,
    ): Promise<DiscussionThreadResult> {
      const authKey = auth.getToken() ? 'authenticated' : 'anonymous'
      const key = `${categoryName}::${documentId}::${authKey}::${force ? 'force' : 'normal'}`
      const inflight = inflightDiscussions.get(key)
      if (inflight) return inflight

      const promise = fetchViaWorker(documentId, categoryName, knownDiscussionId, force)
      inflightDiscussions.set(key, promise)
      const clearInflight = () => {
        if (inflightDiscussions.get(key) === promise) inflightDiscussions.delete(key)
      }
      void promise.then(clearInflight, clearInflight)
      return promise
    },

    async createDiscussion(
      documentId: string,
      categoryName: string,
      bodyText: string,
    ): Promise<DiscussionMeta> {
      const { repoId, categories } = await getRepositoryMeta()
      const categoryId = categories.get(categoryName)
      if (!categoryId) {
        throw new GitHubProviderError(`GitHub Discussions 中不存在“${categoryName}”分类。`)
      }
      const context = { documentId, categoryName, dropCache: true }
      return mutation(context, `mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) {
          discussion { id url number category { name } }
        }
      }`, { repoId, categoryId, title: documentId, body: bodyText }, data => {
        const discussion = data?.createDiscussion?.discussion
        return discussion?.id ? {
          id: discussion.id,
          url: discussion.url,
          number: discussion.number,
          category: discussion.category?.name || categoryName,
        } : null
      }, '创建 GitHub Discussion 失败。')
    },

    async addComment(context: DiscussionMutationContext, body: string): Promise<ThreadComment> {
      const discussionId = requiredDiscussionId(context)
      const comment = await mutation(context, `mutation($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment { ${COMMENT_MUTATION_FIELDS} }
        }
      }`, { discussionId, body }, data => data?.addDiscussionComment?.comment, '发表评论失败。')
      return mapGitHubComment(comment)
    },

    async addReply(context: DiscussionMutationContext, replyToId: string, body: string): Promise<ThreadReply> {
      const discussionId = requiredDiscussionId(context)
      const comment = await mutation(context, `mutation($discussionId: ID!, $replyToId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, replyToId: $replyToId, body: $body }) {
          comment { ${COMMENT_MUTATION_FIELDS} }
        }
      }`, { discussionId, replyToId, body }, data => data?.addDiscussionComment?.comment, '发表回复失败。')
      return mapGitHubReply(comment)
    },

    async updateComment(context: DiscussionMutationContext, commentId: string, body: string): Promise<ThreadEntry> {
      const comment = await mutation(context, `mutation($commentId: ID!, $body: String!) {
        updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
          comment { ${COMMENT_MUTATION_FIELDS} }
        }
      }`, { commentId, body }, data => data?.updateDiscussionComment?.comment, '更新内容失败。')
      return mapGitHubEntry(comment)
    },

    async deleteComment(context: DiscussionMutationContext, commentId: string): Promise<void> {
      await mutation(context, `mutation($id: ID!) {
        deleteDiscussionComment(input: { id: $id }) { clientMutationId }
      }`, { id: commentId }, data => data?.deleteDiscussionComment, '删除内容失败。')
    },

    async addReaction(context: DiscussionMutationContext, subjectId: string, content: string): Promise<void> {
      await mutation(context, `mutation($subjectId: ID!, $content: ReactionContent!) {
        addReaction(input: { subjectId: $subjectId, content: $content }) {
          reaction { content }
        }
      }`, { subjectId, content }, data => data?.addReaction?.reaction, '添加表情回应失败。')
    },

    async removeReaction(context: DiscussionMutationContext, subjectId: string, content: string): Promise<void> {
      await mutation(context, `mutation($subjectId: ID!, $content: ReactionContent!) {
        removeReaction(input: { subjectId: $subjectId, content: $content }) {
          reaction { content }
        }
      }`, { subjectId, content }, data => data?.removeReaction?.reaction, '移除表情回应失败。')
    },
  }

  return provider
}

function requiredDiscussionId(context: DiscussionMutationContext): string {
  if (!context.discussionId) throw new GitHubProviderError('缺少 GitHub Discussion ID。')
  return context.discussionId
}

function collectCommentIds(comments: any[]): string[] {
  const ids: string[] = []
  forEachComment(comments, comment => {
    if (typeof comment.id === 'string') ids.push(comment.id)
  })
  return ids
}

function forEachComment(comments: any[], callback: (comment: any) => void): void {
  for (const comment of comments) {
    callback(comment)
    for (const reply of comment.replies?.nodes || []) callback(reply)
  }
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json()
  } catch {
    return {}
  }
}
