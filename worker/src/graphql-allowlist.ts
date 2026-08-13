const QUERY_DENYLIST = /\b(search|node|rateLimit|viewer|organization)\s*(?:\(|\{)/
const MUTATION_FIELDS = [
  'createDiscussion',
  'addDiscussionComment',
  'updateDiscussionComment',
  'deleteDiscussionComment',
  'addReaction',
  'removeReaction',
] as const

export function isAllowedGraphQlOperation(query: string): boolean {
  const compact = query.replace(/#[^\r\n]*/g, ' ')
  if (compact.trimStart().startsWith('query')) {
    return /\brepository\s*\(/.test(compact)
      && /\bdiscussionCategories\s*\(/.test(compact)
      && !QUERY_DENYLIST.test(compact)
  }
  return MUTATION_FIELDS.some(field => new RegExp(`\\b${field}\\s*\\(`).test(compact))
}
