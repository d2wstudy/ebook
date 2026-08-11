import type { ReactionGroup } from './types'

export const GITHUB_REACTION_ORDER = [
  'THUMBS_UP',
  'THUMBS_DOWN',
  'LAUGH',
  'HOORAY',
  'CONFUSED',
  'HEART',
  'ROCKET',
  'EYES',
] as const

const REACTION_INDEX = new Map<string, number>(
  GITHUB_REACTION_ORDER.map((content, index) => [content, index]),
)

export function sortReactions<T extends ReactionGroup>(reactions: T[]): T[] {
  return reactions.sort((left, right) =>
    (REACTION_INDEX.get(left.content) ?? 99) - (REACTION_INDEX.get(right.content) ?? 99))
}

export function createOptimisticReactionToggler(
  findTarget: (subjectId: string) => { reactions: ReactionGroup[] } | null,
  mutate: (subjectId: string, content: string, add: boolean) => Promise<void>,
) {
  const inflight = new Set<string>()

  return async function toggleReaction(
    subjectId: string,
    content: string,
  ): Promise<{ delta: number } | undefined> {
    const operationKey = `${subjectId}:${content}`
    if (inflight.has(operationKey)) return

    const target = findTarget(subjectId)
    if (!target) return

    inflight.add(operationKey)
    const snapshot = target.reactions.map(reaction => ({ ...reaction }))

    try {
      const existing = target.reactions.find(reaction => reaction.content === content)
      if (existing?.viewerHasReacted) {
        existing.count--
        existing.viewerHasReacted = false
        if (existing.count <= 0) target.reactions.splice(target.reactions.indexOf(existing), 1)
        await mutate(subjectId, content, false)
        return { delta: -1 }
      }

      if (existing) {
        existing.count++
        existing.viewerHasReacted = true
      } else {
        target.reactions.push({ content, count: 1, viewerHasReacted: true })
        sortReactions(target.reactions)
      }
      await mutate(subjectId, content, true)
      return { delta: 1 }
    } catch (error) {
      target.reactions.splice(0, target.reactions.length, ...snapshot)
      throw error
    } finally {
      inflight.delete(operationKey)
    }
  }
}
