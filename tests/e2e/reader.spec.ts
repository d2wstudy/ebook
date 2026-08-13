import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { decodeAnnotationBody } from '@github-reader/core'

const notesDiscussion = {
  discussion: {
    id: 'discussion-notes',
    url: 'https://github.com/example/reader-template/discussions/2',
    number: 2,
    category: 'Ideas',
  },
  comments: [
    {
      id: 'note-1',
      body: JSON.stringify({
        type: 'annotation',
        paragraphId: 'legacy-placeholder',
        startOffset: 0,
        endOffset: 9,
        selectedText: '这是通用电子书模板',
        note: '这是一条用于界面验收的划词笔记。',
      }),
      author: { login: 'reader-one', avatarUrl: '' },
      createdAt: '2026-01-01T00:00:00Z',
      lastEditedAt: null,
      url: 'https://github.com/example/reader-template/discussions/2#discussioncomment-1',
      authorAssociation: 'CONTRIBUTOR',
      replies: { nodes: [] },
      reactionGroups: [
        { content: 'CONFUSED', viewerHasReacted: false, reactors: { totalCount: 1 } },
      ],
    },
  ],
}

const chapterDiscussion = {
  discussion: {
    id: 'discussion-comments',
    url: 'https://github.com/example/reader-template/discussions/1',
    number: 1,
    category: 'Announcements',
  },
  comments: [
    commentFixture('comment-1', '第一条章节评论'),
    commentFixture('comment-2', '第二条章节评论'),
  ],
}

function commentFixture(id: string, body: string) {
  return {
    id,
    body,
    author: { login: 'reader-one', avatarUrl: '' },
    createdAt: '2026-01-01T00:00:00Z',
    lastEditedAt: null,
    url: `https://github.test/discussions/1#${id}`,
    authorAssociation: 'NONE',
    replies: { nodes: [] },
    reactionGroups: [
      { content: 'CONFUSED', viewerHasReacted: false, reactors: { totalCount: 1 } },
    ],
  }
}

async function preparePage(page: Page, authenticated = false) {
  await page.addInitScript(({ authenticated }) => {
    localStorage.clear()
    sessionStorage.clear()
    if (authenticated) {
      localStorage.setItem('github-reader::ebook::auth::session', 'test-session')
      localStorage.setItem('github-reader::ebook::auth::user', JSON.stringify({
        login: 'reader-one',
        avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        html_url: 'https://github.com/reader-one',
      }))
    }
  }, { authenticated })

  await page.route('**/api/discussions?*', async route => {
    const url = new URL(route.request().url())
    const category = url.searchParams.get('category')
    if (category === 'Ideas') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(notesDiscussion) })
      return
    }
    if (category === 'Announcements') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(chapterDiscussion) })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ discussion: null, comments: [] }),
    })
  })

  await page.route('**/api/auth/session', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      access_token: 'test-token',
      expires_at: Date.now() + 8 * 60 * 60 * 1000,
      session: 'test-session',
    }),
  }))

  await page.route('https://api.github.com/user', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      login: 'reader-one',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
      html_url: 'https://github.com/reader-one',
    }),
  }))

  await page.route('https://api.github.com/graphql', async route => {
    const payload = route.request().postDataJSON() as { query?: string }
    if (payload.query?.includes('nodes(ids:')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { nodes: [] } }) })
      return
    }
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
  })

  await page.route('**/api/cache/invalidate', route => route.fulfill({
    status: 202,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }))
}

async function waitForDrawerSettled(page: Page) {
  await page.waitForFunction(() => {
    const layer = document.querySelector('.annotation-drawer-layer')
    const sidebar = document.querySelector('.annotation-sidebar')
    return !!layer
      && !!sidebar
      && getComputedStyle(layer).opacity === '1'
      && getComputedStyle(sidebar).transform === 'none'
  })
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const serious = results.violations.filter(item => ['serious', 'critical'].includes(item.impact || ''))
  expect(serious, JSON.stringify(serious, null, 2)).toEqual([])
}

async function selectText(page: Page, blockSelector: string, text: string) {
  await page.locator(blockSelector).first().waitFor({ state: 'visible' })
  await page.evaluate(({ blockSelector, text }) => {
    const block = document.querySelector(blockSelector)
    if (!block) throw new Error(`Missing block: ${blockSelector}`)
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    let node: Text | null = null
    let start = -1
    while ((node = walker.nextNode() as Text | null)) {
      start = (node.textContent || '').indexOf(text)
      if (start >= 0) break
    }
    if (!node || start < 0) throw new Error(`Missing text: ${text}`)

    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + text.length)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }))
    block.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  }, { blockSelector, text })
}

const languageBlock = (language: string) =>
  `.reader-language[data-language="${language}"] [data-reader-block]`

test('自动发现语言、页面级切换和多语言划词可用', async ({ page }) => {
  await preparePage(page)
  await page.goto('chapters/01-introduction')

  const english = page.locator('.reader-language[data-language="en"]')
  const chinese = page.locator('.reader-language[data-language="zh-CN"]')
  await expect(english).toBeHidden()
  await expect(chinese).toBeVisible()

  await page.locator('.lang-switch').click()
  await page.getByRole('menuitemradio', { name: /English/ }).click()
  await expect(english).toBeVisible()
  await expect(chinese).toBeHidden()

  await selectText(page, languageBlock('en'), 'This is a placeholder page')
  await expect(page.getByRole('toolbar', { name: '划词操作' })).toContainText('登录并添加笔记')

  await page.locator('.lang-switch').click()
  await page.getByRole('menuitemradio', { name: /简体中文/ }).click()
  await selectText(page, languageBlock('zh-CN'), '这是通用电子书模板')
  await expect(page.getByRole('toolbar', { name: '划词操作' })).toContainText('登录并添加笔记')

  await page.goto('chapters/01-introduction?note=note-1')
  await expect(page.getByRole('dialog', { name: '划词笔记' })).toBeVisible()
  await expect(page.getByText('这是一条用于界面验收的划词笔记。')).toBeVisible()
  await expect(page.locator('.reader-anno[data-anno-ids~="note-1"]')).toBeVisible()
})

test('页面缺少当前语言时回退到默认可用语言', async ({ page }) => {
  await preparePage(page)
  const response = await page.goto('chapters/02-content-model')

  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Content Model' })).toBeVisible()
  await expect(page.locator('.reader-language[data-language="en"]')).toBeVisible()
  await expect(page.locator('.reader-language[data-language="zh-CN"]')).toHaveCount(0)
  await expect(page.locator('.lang-switch')).toHaveCount(0)

  await page.goto('chapters/01-introduction')
  await expect(page.locator('.reader-language[data-language="zh-CN"]')).toBeVisible()
})

test('评论弹层互斥、支持全部八种 GitHub Reaction', async ({ page }) => {
  await preparePage(page, true)
  await page.goto('chapters/01-introduction')
  await expect(page.locator('.comments-list .comment-thread-item')).toHaveCount(2)

  const commentItems = page.locator('.comments-list .comment-thread-item')
  await commentItems.nth(0).locator('.reaction-add-btn').click()
  await expect(page.locator('.comments-list .reaction-picker')).toHaveCount(1)
  await commentItems.nth(1).locator('.reaction-add-btn').click()
  await expect(page.locator('.comments-list .reaction-picker')).toHaveCount(1)
  await expect(page.locator('.comments-list .reaction-picker .picker-emoji')).toHaveCount(8)
  await expect(page.locator('.comments-list .reaction-picker .picker-emoji[aria-label="CONFUSED"]')).toBeVisible()
})

test('360px 移动端抽屉不溢出并保持键盘焦点在对话框内', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await preparePage(page, true)
  await page.goto('chapters/01-introduction?note=note-1')

  const dialog = page.getByRole('dialog', { name: '划词笔记' })
  await expect(dialog).toBeVisible()
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.x ?? -1)).toBe(0)
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(360)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.keyboard.press('Shift+Tab')
  expect(await page.evaluate(() => {
    const dialogElement = document.querySelector('.annotation-sidebar')
    return !!dialogElement?.contains(document.activeElement)
  })).toBe(true)
})

test('360px 移动端登录控件不挤出导航栏', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 })
  await preparePage(page)
  await page.goto('chapters/01-introduction')

  await expect(page.locator('.VPNavBar .sign-in-btn')).toBeVisible()
  await expect(page.locator('.VPNavBarHamburger')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('刷新时立即显示缓存头像，不等待会话恢复', async ({ page }) => {
  await preparePage(page, true)
  await page.unroute('**/api/auth/session')

  let releaseSession!: () => void
  const sessionGate = new Promise<void>(resolve => { releaseSession = resolve })
  await page.route('**/api/auth/session', async route => {
    await sessionGate
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'test-token',
        expires_at: Date.now() + 8 * 60 * 60 * 1000,
        session: 'test-session',
      }),
    })
  })
  await page.route('https://avatars.githubusercontent.com/**', route => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="#0969da"/></svg>',
  }))

  const sessionRequest = page.waitForRequest('**/api/auth/session')
  const navigation = page.goto('chapters/01-introduction')
  await sessionRequest

  try {
    const avatar = page.locator('.avatar-btn')
    await expect(avatar).toBeVisible({ timeout: 750 })
    await expect(page.locator('.avatar-placeholder')).toHaveCount(0)
    await expect(avatar.locator('img')).toHaveAttribute('loading', 'eager')
    await expect(avatar.locator('img')).toHaveAttribute('fetchpriority', 'high')
  } finally {
    releaseSession()
    await navigation
  }
})

test('GitHub 用户菜单支持点击、Escape 和键盘焦点恢复', async ({ page }) => {
  await preparePage(page, true)
  await page.goto('chapters/01-introduction')

  const avatar = page.locator('.avatar-btn')
  await avatar.click()
  await expect(page.locator('.login-menu-portal')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('.login-menu-portal')).toHaveCount(0)
  await expect(avatar).toHaveAttribute('aria-expanded', 'false')
  await expect(avatar).toBeFocused()
  await expectNoSeriousA11yViolations(page)
})

test('OAuth 用户信息暂时失败时保留会话并提供重试', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('github-reader::ebook::auth::oauth-state', 'state-ok')
    sessionStorage.setItem('github-reader::ebook::auth::oauth-verifier', 'v'.repeat(43))
  })
  await page.route('http://127.0.0.1:15692/mock-worker/**', async route => {
    if (route.request().url().includes('/api/auth/exchange')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          access_token: 'new-token',
          expires_at: Date.now() + 8 * 60 * 60 * 1000,
          session: 'new-session',
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ discussion: null, comments: [] }),
    })
  })
  await page.route('https://api.github.com/user', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: '{}',
  }))

  await page.goto('chapters/01-introduction?code=code-ok&state=state-ok')
  await expect(page.locator('.auth-retry-btn')).toBeVisible()
  await expect(page.getByText('GitHub 会话需要验证')).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    localStorage.getItem('github-reader::ebook::auth::session'))).toBe('new-session')
})

test('匿名阅读页和笔记抽屉没有严重无障碍违规', async ({ page }) => {
  await preparePage(page)
  await page.goto('chapters/01-introduction?note=note-1')
  await expect(page.getByRole('dialog', { name: '划词笔记' })).toBeVisible()
  await waitForDrawerSettled(page)
  await expectNoSeriousA11yViolations(page)
})

test('登录后的评论与笔记编辑器没有严重无障碍违规', async ({ page }) => {
  await preparePage(page, true)
  await page.goto('chapters/01-introduction')

  await page.locator('.comment-input-placeholder').click()
  await expect(page.locator('.comments-composer .md-editor')).toBeVisible()
  await expectNoSeriousA11yViolations(page)
  await page.locator('.comments-composer .btn-cancel').click()

  await page.locator(languageBlock('zh-CN')).first().scrollIntoViewIfNeeded()
  await selectText(page, languageBlock('zh-CN'), '这是通用电子书模板')
  await page.getByRole('toolbar', { name: '划词操作' })
    .getByRole('button', { name: '添加笔记' })
    .click()
  const dialog = page.getByRole('dialog', { name: '划词笔记' })
  await expect(dialog).toBeVisible()
  await waitForDrawerSettled(page)
  await expect(dialog.locator('.md-editor')).toBeVisible()
  await expectNoSeriousA11yViolations(page)
})

test('新划词笔记以可读 schema v3 正文提交但不写入真实 GitHub', async ({ page }) => {
  await preparePage(page, true)
  let submittedBody = ''

  await page.unroute('https://api.github.com/graphql')
  await page.route('https://api.github.com/graphql', async route => {
    const payload = route.request().postDataJSON() as {
      variables?: { body?: string }
      query?: string
    }
    submittedBody = payload.variables?.body || ''
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          addDiscussionComment: {
            comment: {
              id: 'note-v3',
              body: submittedBody,
              author: { login: 'reader-one', avatarUrl: '' },
              createdAt: '2026-01-01T00:00:00Z',
              lastEditedAt: null,
              url: 'https://github.test/discussions/2#note-v3',
              authorAssociation: 'NONE',
              reactionGroups: [],
            },
          },
        },
      }),
    })
  })
  await page.goto('chapters/01-introduction')
  await expect(page.locator('.avatar-btn')).toBeVisible()
  await expect(page.locator('.reader-anno[data-anno-ids~="note-1"]')).toBeVisible()
  await selectText(page, languageBlock('zh-CN'), '这是通用电子书模板')
  await page.getByRole('toolbar', { name: '划词操作' })
    .getByRole('button', { name: '添加笔记' })
    .click()
  const dialog = page.getByRole('dialog', { name: '划词笔记' })
  await dialog.getByRole('textbox', { name: 'Markdown 编辑器' }).fill('一条 **v3** 笔记')
  await dialog.getByRole('button', { name: /发布笔记/ }).click()

  await expect.poll(() => submittedBody).toMatch(/^<!-- github-reader-annotation:v3:/)
  expect(submittedBody).toContain('> 这是通用电子书模板')
  expect(decodeAnnotationBody(submittedBody)).toMatchObject({
    schemaVersion: 3,
    documentId: '/ebook/chapters/01-introduction.html',
    note: '一条 **v3** 笔记',
    anchor: {
      selectedText: '这是通用电子书模板',
      language: 'zh-CN',
    },
  })
})
