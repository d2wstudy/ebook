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

export interface DiscussionMutationContext {
  documentId: string
  categoryName: string
  discussionId?: string | null
  dropCache?: boolean
}

export interface DiscussionProvider {
  findDiscussion(
    documentId: string,
    categoryName: string,
    knownDiscussionId?: string | null,
    force?: boolean,
  ): Promise<DiscussionThreadResult>
  createDiscussion(documentId: string, categoryName: string, bodyText: string): Promise<DiscussionMeta>
  addComment(context: DiscussionMutationContext, body: string): Promise<ThreadComment>
  addReply(context: DiscussionMutationContext, replyToId: string, body: string): Promise<ThreadReply>
  updateComment(context: DiscussionMutationContext, commentId: string, body: string): Promise<ThreadEntry>
  deleteComment(context: DiscussionMutationContext, commentId: string): Promise<void>
  addReaction(context: DiscussionMutationContext, subjectId: string, content: string): Promise<void>
  removeReaction(context: DiscussionMutationContext, subjectId: string, content: string): Promise<void>
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
  oauthClientId?: string
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
