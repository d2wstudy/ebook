import { describe, expect, it } from 'vitest'
// The Worker is intentionally plain JavaScript because Cloudflare executes it directly.
// @ts-expect-error no separate declaration file is needed for these test-only exports
import { getWorkerConfig, validateDiscussionParams, validateReactionMutation } from '../worker/index.js'

function workerUrl(params: Record<string, string>) {
  const url = new URL('https://worker.example/api/cache/purge')
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value))
  return url
}

describe('Worker request validation', () => {
  it('accepts canonical project pages and rejects unrelated paths', () => {
    expect(validateDiscussionParams(workerUrl({
      path: '/reader-template/chapters/01-introduction.html',
      category: 'Notes',
    })).error).toBeUndefined()

    expect(validateDiscussionParams(workerUrl({
      path: '/another-project/page.html',
      category: 'Notes',
    })).error).toBe('Invalid path')
  })

  it('supports a deployment-defined repository namespace and category set', () => {
    const env = {
      REPO_OWNER: 'publisher',
      REPO_NAME: 'another-book',
      DOCUMENT_PATH_PREFIX: '/another-book',
      DISCUSSION_CATEGORIES: 'Annotations,General',
    }

    expect(getWorkerConfig(env)).toMatchObject({
      repoOwner: 'publisher',
      repoName: 'another-book',
      documentPathPrefix: '/another-book/',
    })
    expect(validateDiscussionParams(workerUrl({
      path: '/another-book/chapter.html',
      category: 'Annotations',
    }), env).error).toBeUndefined()
    expect(validateDiscussionParams(workerUrl({
      path: '/another-book/chapter.html',
      category: 'Notes',
    }), env).error).toBe('Invalid category')
  })

  it('accepts every GitHub reaction but rejects forged deltas', () => {
    expect(validateReactionMutation(workerUrl({
      subject_id: 'DC_kwDOROV32M4A8MOm',
      reaction: 'CONFUSED',
      delta: '1',
    })).active).toBe(true)

    expect(validateReactionMutation(workerUrl({
      subject_id: 'DC_kwDOROV32M4A8MOm',
      reaction: 'CONFUSED',
      delta: '999',
    })).error).toBe('Invalid reaction delta')
  })
})
