export interface ReactionGroup {
  content: string
  count: number
  viewerHasReacted: boolean
}

export interface ThreadEntry {
  id: string
  body: string
  author: string
  authorAvatar: string
  createdAt: string
  lastEditedAt: string | null
  url: string
  authorAssociation: string
  reactions: ReactionGroup[]
}

export interface ThreadReply extends ThreadEntry {}

export interface ThreadComment extends ThreadEntry {
  replies: ThreadReply[]
}

export interface DiscussionMeta {
  id: string
  url: string
  number: number
  category: string
}

export interface DiscussionThreadResult {
  discussion: DiscussionMeta | null
  comments: ThreadComment[]
}

export interface ReactionDelta {
  subjectId: string
  content: string
  delta: number
}

export interface DiscussionProvider {
  findDiscussion(
    documentId: string,
    categoryName: string,
    knownDiscussionId?: string | null,
    force?: boolean,
  ): Promise<DiscussionThreadResult>
  purgeCache(
    documentId: string,
    categoryName: string,
    userOnly?: boolean,
    reactionDelta?: ReactionDelta,
    knownDiscussionId?: string | null,
  ): Promise<boolean>
  createDiscussion(documentId: string, categoryName: string, bodyText: string): Promise<DiscussionMeta>
  addComment(discussionId: string, body: string): Promise<ThreadComment>
  addReply(discussionId: string, replyToId: string, body: string): Promise<ThreadReply>
  updateComment(commentId: string, body: string): Promise<ThreadEntry>
  deleteComment(commentId: string): Promise<void>
  addReaction(subjectId: string, content: string): Promise<void>
  removeReaction(subjectId: string, content: string): Promise<void>
  getCategoryId(categoryName: string): Promise<string | null>
}

export interface AnnotationAnchor<TLanguage extends string = string> {
  paragraphId: string
  startOffset: number
  endOffset: number
  selectedText: string
  prefix: string
  suffix: string
  language?: TLanguage
}

export interface AnnotationRecord<TLanguage extends string = string> {
  schemaVersion: number
  documentId?: string
  anchor: AnnotationAnchor<TLanguage>
  segments?: AnnotationAnchor<TLanguage>[]
  note: string
}

export interface AnnotationThread<TLanguage extends string = string> {
  id: string
  anchor: AnnotationAnchor<TLanguage>
  segments?: AnnotationAnchor<TLanguage>[]
  note: string
  author: string
  authorAvatar: string
  createdAt: string
  lastEditedAt: string | null
  url: string
  authorAssociation: string
  replies: ThreadReply[]
  reactions: ReactionGroup[]
}

export interface AnnotationDocumentBlock<TLanguage extends string = string> {
  id: string
  legacyIds: string[]
  language?: TLanguage
  element: HTMLElement
  group: HTMLElement
}

export interface AnnotationDocumentAdapter<TLanguage extends string = string> {
  readonly readyEvent: string
  getDocumentId(routePath: string): string
  getRoot(): HTMLElement | null
  getBlocks(): AnnotationDocumentBlock<TLanguage>[]
  findBlock(node: Node): AnnotationDocumentBlock<TLanguage> | null
  rangeIncludesOtherLanguage(range: Range, language?: TLanguage): boolean
  notifyReady(): void
}

export interface ReaderDocumentConfig {
  base: string
  rootSelector: string
  blockSelector: string
  readyEvent: string
}

export interface ReaderLanguageConfig {
  defaultLanguage?: string
  names?: Readonly<Record<string, string>>
}

export interface ReaderGitHubConfig {
  owner: string
  repo: string
  workerUrl: string
  graphqlUrl?: string
  oauthClientId?: string
  oauthScope?: string
}

export interface ReaderDiscussionConfig {
  annotationCategory: string
  commentReadCategories: readonly string[]
  commentCreateCategory: string
  annotationBody(documentId: string): string
  commentBody(documentId: string): string
}

export interface ReaderConfig {
  projectId: string
  document: ReaderDocumentConfig
  language?: ReaderLanguageConfig
  github: ReaderGitHubConfig
  discussions: ReaderDiscussionConfig
}
