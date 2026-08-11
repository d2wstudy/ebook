import type {
  DiscussionMeta,
  DiscussionProvider,
  DiscussionThreadResult,
  ReactionDelta,
  ThreadComment,
  ThreadEntry,
  ThreadReply,
} from '@github-reader/core'
import { mapGitHubComment, mapGitHubEntry, mapGitHubReply } from './mapping'

export interface GitHubAuthBridge {
  getToken(): string | null
  invalidate(): void
}

export interface GitHubDiscussionProviderConfig {
  owner: string
  repo: string
  workerUrl: string
  graphqlUrl?: string
  development?: boolean
}

export interface GitHubDiscussionProvider extends DiscussionProvider {
  gql(query: string, variables: Record<string, unknown>): Promise<any>
}

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
    graphqlUrl: rawConfig.graphqlUrl || 'https://api.github.com/graphql',
  }
  const inflightDiscussions = new Map<string, Promise<DiscussionThreadResult>>()
  let repoMetaPromise: Promise<{ repoId: string; categories: Map<string, string> }> | null = null
  let repoMetaToken: string | null = null

  async function gql(query: string, variables: Record<string, unknown>) {
    const token = auth.getToken()
    if (!token) throw new GitHubProviderError('请先登录 GitHub。', 401)

    const isMutation = query.trimStart().startsWith('mutation')
    const actualQuery = config.development && !isMutation
      ? query.replace(/\{/, '{ rateLimit { cost remaining resetAt }')
      : query

    let response: Response
    try {
      response = await fetch(config.graphqlUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: actualQuery, variables }),
      })
    } catch {
      throw new GitHubProviderError('无法连接 GitHub API。')
    }

    const json = await safeJson(response)
    if (response.status === 401) {
      auth.invalidate()
      throw new GitHubProviderError('GitHub 登录已失效，请重新登录。', 401)
    }
    if (response.status === 403 || response.status === 429) {
      throw new GitHubProviderError('GitHub API 速率限制已触发，请稍后重试。', response.status)
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
    return json.data
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
  ): Promise<DiscussionThreadResult> {
    const params = new URLSearchParams({ path: documentId, category: categoryName })
    if (knownDiscussionId) params.set('id', knownDiscussionId)

    const headers: Record<string, string> = {}
    const token = auth.getToken()
    if (token) headers.Authorization = `Bearer ${token}`

    let response: Response
    try {
      response = await fetch(`${config.workerUrl}/api/discussions?${params}`, { headers })
    } catch {
      throw new GitHubProviderError('无法连接评论服务，请稍后重试。')
    }

    const data = await safeJson(response)
    if (!response.ok) {
      if (response.status === 401) auth.invalidate()
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

    return {
      discussion,
      comments: Array.isArray(data.comments) ? data.comments.map(mapGitHubComment) : [],
    }
  }

  const provider: GitHubDiscussionProvider = {
    gql,

    async getCategoryId(categoryName: string): Promise<string | null> {
      const { categories } = await getRepositoryMeta()
      return categories.get(categoryName) || null
    },

    async findDiscussion(
      documentId: string,
      categoryName: string,
      knownDiscussionId?: string | null,
      force = false,
    ): Promise<DiscussionThreadResult> {
      const token = auth.getToken()
      const authKey = token ? token.slice(-8) : 'anonymous'
      const key = `${categoryName}::${documentId}::${authKey}`
      if (!force) {
        const inflight = inflightDiscussions.get(key)
        if (inflight) return inflight
      }

      const promise = fetchViaWorker(documentId, categoryName, knownDiscussionId)
      inflightDiscussions.set(key, promise)
      const clearInflight = () => {
        if (inflightDiscussions.get(key) === promise) inflightDiscussions.delete(key)
      }
      void promise.then(clearInflight, clearInflight)
      return promise
    },

    async purgeCache(
      documentId: string,
      categoryName: string,
      userOnly = false,
      reactionDelta?: ReactionDelta,
      knownDiscussionId?: string | null,
    ): Promise<boolean> {
      const token = auth.getToken()
      if (!token) return false

      const params = new URLSearchParams({ path: documentId, category: categoryName })
      if (userOnly) params.set('user_only', '1')
      if (reactionDelta) {
        params.set('subject_id', reactionDelta.subjectId)
        params.set('reaction', reactionDelta.content)
        params.set('delta', String(reactionDelta.delta))
      }
      if (knownDiscussionId) params.set('id', knownDiscussionId)

      try {
        const response = await fetch(`${config.workerUrl}/api/cache/purge?${params}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
        return response.ok
      } catch {
        return false
      }
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

      const data = await gql(`mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
        createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) {
          discussion { id url number category { name } }
        }
      }`, { repoId, categoryId, title: documentId, body: bodyText })

      const discussion = data?.createDiscussion?.discussion
      if (!discussion?.id) throw new GitHubProviderError('创建 GitHub Discussion 失败。')
      return {
        id: discussion.id,
        url: discussion.url,
        number: discussion.number,
        category: discussion.category?.name || categoryName,
      }
    },

    async addComment(discussionId: string, body: string): Promise<ThreadComment> {
      const data = await gql(`mutation($discussionId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
          comment { ${COMMENT_MUTATION_FIELDS} }
        }
      }`, { discussionId, body })
      const comment = data?.addDiscussionComment?.comment
      if (!comment) throw new GitHubProviderError('发表评论失败。')
      return mapGitHubComment(comment)
    },

    async addReply(discussionId: string, replyToId: string, body: string): Promise<ThreadReply> {
      const data = await gql(`mutation($discussionId: ID!, $replyToId: ID!, $body: String!) {
        addDiscussionComment(input: { discussionId: $discussionId, replyToId: $replyToId, body: $body }) {
          comment { ${COMMENT_MUTATION_FIELDS} }
        }
      }`, { discussionId, replyToId, body })
      const comment = data?.addDiscussionComment?.comment
      if (!comment) throw new GitHubProviderError('发表回复失败。')
      return mapGitHubReply(comment)
    },

    async updateComment(commentId: string, body: string): Promise<ThreadEntry> {
      const data = await gql(`mutation($commentId: ID!, $body: String!) {
        updateDiscussionComment(input: { commentId: $commentId, body: $body }) {
          comment { ${COMMENT_MUTATION_FIELDS} }
        }
      }`, { commentId, body })
      const comment = data?.updateDiscussionComment?.comment
      if (!comment) throw new GitHubProviderError('更新内容失败。')
      return mapGitHubEntry(comment)
    },

    async deleteComment(commentId: string): Promise<void> {
      const data = await gql(`mutation($id: ID!) {
        deleteDiscussionComment(input: { id: $id }) { clientMutationId }
      }`, { id: commentId })
      if (!data?.deleteDiscussionComment) throw new GitHubProviderError('删除内容失败。')
    },

    async addReaction(subjectId: string, content: string): Promise<void> {
      const data = await gql(`mutation($subjectId: ID!, $content: ReactionContent!) {
        addReaction(input: { subjectId: $subjectId, content: $content }) {
          reaction { content }
        }
      }`, { subjectId, content })
      if (!data?.addReaction?.reaction) throw new GitHubProviderError('添加表情回应失败。')
    },

    async removeReaction(subjectId: string, content: string): Promise<void> {
      const data = await gql(`mutation($subjectId: ID!, $content: ReactionContent!) {
        removeReaction(input: { subjectId: $subjectId, content: $content }) {
          reaction { content }
        }
      }`, { subjectId, content })
      if (!data?.removeReaction?.reaction) throw new GitHubProviderError('移除表情回应失败。')
    },
  }

  return provider
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json()
  } catch {
    return {}
  }
}
