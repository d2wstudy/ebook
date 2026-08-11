# 通用电子书阅读模板

这是一个基于 VitePress 的电子书模板。把 Markdown 按语言放入 `content/<language>/`，再修改根目录的 `book.config.ts`，即可生成一套新的电子书站点。

当前版本先支持页面级语言切换：语言目录自动发现，单语言书籍不显示语言控件，多语言页面显示语言选择器。阅读、划词标注、章节评论、GitHub Reaction、OAuth 和 Worker 缓存能力可以复用到每一本书。

## 快速开始

需要 Node.js 20 或更高版本：

```bash
npm ci
npm run dev
```

开发地址：`http://localhost:15689/reader-template/`

常用命令：

```bash
npm run dev           # 启动开发服务器
npm run build         # 构建静态站点
npm run preview       # 预览生产构建
npm run typecheck     # TypeScript / Vue 类型检查
npm test              # Vitest 单元测试
npm run test:e2e      # Playwright 浏览器验收
npm run check:worker  # Worker 语法检查
npm run check         # 类型检查、单测、Worker 检查和构建
```

## 添加书籍内容

语言通过目录自动发现，不需要在配置中登记语言名称：

```text
content/
  en/
    chapters/01-introduction.md
    chapters/02-content-model.md
  zh-CN/
    chapters/01-introduction.md
```

一级目录名使用语言代码，例如 `en`、`zh-CN`、`ja`。相同的相对文件路径会合并为同一个阅读页面；只有一种语言的页面仍然可以正常阅读和标注。

每个 Markdown 文件可以使用 frontmatter：

```md
---
title: Introduction
sidebar: 1. Introduction
group: Getting Started
order: 1
---

正文内容。
```

`title`、`sidebar`、`group` 和 `order` 用于页面标题、侧边栏和排序。没有 frontmatter 时，会从文件名或第一个 H1 推导基本标题。

同一页面缺少当前语言时，阅读器会显示该页可用的默认语言。默认语言和语言显示名可以在 `book.config.ts` 中指定，但语言列表本身不需要维护：

```ts
export const bookConfig = {
  id: 'my-book',
  title: '我的书',
  description: '书籍简介',
  base: '/my-book/',
  contentDir: 'content',
  defaultLanguage: 'zh-CN',
  languageNames: {
    en: 'English',
    'zh-CN': '简体中文',
  },
  github: {
    owner: 'your-account',
    repo: 'my-book',
    workerUrl: 'https://your-worker.example.workers.dev',
  },
} as const
```

`defaultLanguage` 是可选的；未指定时使用当前页面发现的第一个语言。GitHub 仓库和 Worker URL 是公开客户端配置，OAuth client secret、PAT 等敏感值只能放在 Worker secrets 中。

## 构建流程

构建器位于 `docs/.vitepress/bookContent.ts`。它会：

1. 扫描 `content/` 的语言目录。
2. 解析每个 Markdown 的 frontmatter。
3. 按 slug 合并不同语言的页面。
4. 生成动态章节路由、页面标题和侧边栏。
5. 在同一个页面中渲染各语言区域。

页面使用一个规范 `documentId`，不会因为语言切换而产生重复的章节讨论。正文段落在浏览器端会生成稳定的 `data-reader-block` ID，当前版本的划词标注按当前可见语言工作。

## 阅读器能力

- 自动发现任意数量的语言目录。
- 页面级语言切换和缺失语言回退。
- Markdown、数学公式、图片和 `::: notes` 容器。
- 稳定正文块、TextQuote/TextPosition 锚点和模糊恢复。
- 划词笔记、跨段选区、回复、编辑、删除和 Reaction。
- GitHub Discussions 章节评论。
- GitHub OAuth 登录和登录前待发布选区恢复。
- Cloudflare Worker 读取缓存和 mutation 缓存失效。

段落级多语言对照暂未启用。当前页面已经保留语言区域和稳定 block 的边界，未来可以在构建器中为相同 block ID 生成多语言分组，不需要重写核心 provider、标注协议或 Worker。

## GitHub 与 Worker

复制环境变量示例并填写 OAuth Client ID：

```powershell
Copy-Item docs/.env.example docs/.env.development.local
```

```dotenv
VITE_GITHUB_CLIENT_ID=your_oauth_app_client_id
VITE_WORKER_URL=https://your-worker.example.workers.dev
VITE_GITHUB_REPO_OWNER=your-account
VITE_GITHUB_REPO_NAME=my-book
```

Worker 的仓库、页面路径前缀、Discussion 分类和允许 Origin 必须通过部署变量固定，不能由浏览器请求动态选择仓库。修改 `worker/wrangler.toml` 后单独部署：

```bash
cd worker
npx wrangler dev
npx wrangler deploy
```

第一版仍采用“每本书一个 Worker”的单租户部署方式。这样可以保持仓库和缓存信任边界清晰，后续有多本书需求时再考虑多租户服务。

## 目录结构

```text
book.config.ts                  # 当前书籍的公开配置
content/<language>/chapters/    # 按语言组织的 Markdown 内容
docs/.vitepress/bookContent.ts  # 语言和页面扫描器
docs/.vitepress/config.ts       # VitePress 构建配置
docs/.vitepress/theme/          # 阅读器、标注、评论和语言切换主题
packages/core/                  # provider 无关的协议、锚点和 Reaction
packages/github/                # GitHub Discussions provider
packages/vitepress/             # VitePress 文档适配器
worker/                         # OAuth、缓存和 GitHub API 代理
tests/                          # 单元测试与浏览器验收
```

## 稳定身份约定

语言文件可以持续编辑，但发布后应尽量保持页面 slug 和正文 block 的稳定。已有 GitHub 标注依赖 `documentId`、block ID、选中文本及其上下文；大幅重排内容时应确认旧锚点仍能恢复。

当前模板会根据路由、语言和正文前缀生成 block ID。未来如果需要对翻译进行精确段落映射，可以在 Markdown 中增加显式 block ID，而不改变评论数据格式。

## 许可证与内容

仓库中的模板代码与书籍内容应分别确认许可证。当前示例内容是占位文本，不包含原书内容；替换为实际书籍前请确认版权和再分发权限。
