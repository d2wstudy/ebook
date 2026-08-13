# 通用电子书阅读模板

这是一个基于 VitePress 的电子书模板。把 Markdown 按语言放入 `content/<language>/`，再修改根目录的 `book.config.ts`，即可生成一套新的电子书站点。

当前版本先支持页面级语言切换：语言目录自动发现，单语言书籍不显示语言控件，多语言页面显示语言选择器。阅读、划词标注、章节评论、GitHub Reaction、OAuth 和 Worker 缓存能力可以复用到每一本书。

## 快速开始

需要 Node.js 20 或更高版本：

```bash
npm ci
npm run dev
```

开发地址：`http://localhost:15689/ebook/`

常用命令：

```bash
npm run dev           # 启动开发服务器
npm run setup         # 交互式配置 Cloudflare Worker、GitHub OAuth 和 Pages 变量
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

Worker 是所有 GitHub API 调用的服务端代理：匿名读取、登录用户读取、GraphQL mutation、用户资料、OAuth token exchange 和 revoke 都不会由浏览器直连 GitHub。每本书默认部署一个 Cloudflare Worker，GitHub Client Secret 和 PAT 只保存在 Cloudflare 中。

### 自动配置（推荐）

首次配置可以直接执行：

```powershell
npm run setup
```

向导会从当前 Git remote 推导 GitHub owner 和 repository，按回车即可使用默认值。它会依次：

1. 检查 Cloudflare 登录状态，必要时打开浏览器完成授权。
2. 检查 GitHub admin 权限，并自动启用 Discussions 和 Workflow 类型 Pages。
3. 检查 `Ideas`、`Announcements`、`General` 分类；GitHub 默认会创建这些分类，缺失时才打开设置页等待管理员补充。
4. 更新 `book.config.ts` 和 `worker/wrangler.jsonc`，并生成 Worker 页面白名单。
5. 部署 Worker，并自动解析 `workers.dev` URL。
6. 通过 Wrangler 交互式保存 `GITHUB_PAT`、OAuth Client ID 和 Client Secret。
7. 写入本地 `docs/.env.development.local`，并同步 GitHub Actions Variables。
8. 验证 Worker CORS、Discussion 接口和本地构建。
9. 最后询问是否提交并推送配置。

脚本不会把 PAT 或 OAuth Client Secret 写入文件。状态文件只记录阶段是否完成，不记录 Secret 内容，并保存在被 Git 忽略的 `.setup/` 目录中。中途失败后再次执行 `npm run setup` 会从未完成阶段继续；Worker 最后验证遇到网络超时会自动重试一次，仍失败时不会重复部署或写入 Secret。确认本机可以访问 `workers.dev` 后再次执行即可。如果要修改已完成配置或轮换 Secret，执行：

```powershell
npm run setup -- --reconfigure
```

如果本机网络无法访问 `workers.dev`，前面的配置和部署仍可能已经完成。此时可以使用下面的选项只跳过最后的线上连通性验证；它不会跳过本地配置检查、构建、Secret 或 Actions Variables 配置，之后可用 `npm run setup:doctor` 重试线上检查：

```powershell
npm run setup -- --skip-verification
```

GitHub OAuth App 仍需在打开的 GitHub 页面中创建，并将向导显示的 callback URL 填入 OAuth App；GitHub 没有公开的 OAuth App 创建 API。Client ID 可以粘贴回向导，之后由脚本自动完成其余配置。GitHub Discussion 分类同样需要在缺失时由管理员在网页中创建，向导会自动重新检查。

管理员常用命令：

```powershell
npm run setup -- --plan       # 只查看变更计划，不写文件、不部署
npm run setup:doctor          # 检查配置、登录状态、Actions Variables 和 Worker CORS
npm run setup:rollback        # 恢复最近一次本地配置备份，并可重新部署
npm run setup:cleanup         # 显式删除当前状态对应的 Worker 和 Actions Variables
```

`rollback` 不会自动恢复旧 Secret；`cleanup` 不会自动撤销 PAT 或 OAuth 凭证，需要在 GitHub/Cloudflare 中单独处理。当前 Pages 工作流要求存在 `VITE_WORKER_URL`，发布到 GitHub Pages 时不要跳过 Actions Variables 同步。启用 Discussions 和 Pages 需要仓库 admin 权限。

运行向导前请确保已安装 GitHub CLI（`gh`）。Cloudflare Wrangler 会通过 `npx` 自动获取，不需要全局安装。Windows 如果启用了系统代理，向导会在未设置 `HTTP_PROXY`/`HTTPS_PROXY` 时自动读取代理地址；也可以手动设置这两个环境变量覆盖自动检测。

### 1. 准备 GitHub 仓库

自动向导会通过 GitHub API 启用 Discussions，并检查 Pages 是否为 Workflow 模式。手动配置时可在目标仓库的 `Settings > General > Features` 中启用 Discussions。以下分类由 Worker 使用：

- `Ideas`：划词标注使用；GitHub 启用 Discussions 时默认创建。
- `Announcements`：公告读取使用。
- `General`：章节评论使用。

如需让未登录用户也能读取讨论，创建一个只授权目标仓库的 fine-grained personal access token，并授予 `Discussions: Read-only`。这个 token 后续保存为 Worker 的 `GITHUB_PAT` secret，不能写入代码或提交到 Git。

### 2. 配置 Worker 部署变量

在 `worker/wrangler.jsonc` 中配置当前书籍。以本仓库为例：

```jsonc
{
  "name": "ebook-reader-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-13",
  "durable_objects": {
    "bindings": [
      { "name": "DISCUSSION_CACHE", "class_name": "DiscussionCache" },
      { "name": "GITHUB_RATE_LIMIT", "class_name": "RateLimitCoordinator" }
    ]
  },
  "vars": {
    "REPO_OWNER": "d2wstudy",
    "REPO_NAME": "ebook",
    "DOCUMENT_PATH_PREFIX": "/ebook/",
    "DISCUSSION_CATEGORIES": "Ideas,Announcements,General",
    "ALLOWED_ORIGINS": "https://d2wstudy.github.io,http://localhost:15689,http://127.0.0.1:15689",
    "CACHE_FRESH_TTL": "600",
    "CACHE_STALE_TTL": "86400",
    "RATE_LIMIT_RESERVE": "250",
    "GRAPHQL_SECONDARY_BUDGET": "1000",
    "REST_SECONDARY_BUDGET": "450",
    "OAUTH_SECONDARY_BUDGET": "50",
    "CONTENT_MINUTE_BUDGET": "60",
    "CONTENT_HOUR_BUDGET": "400",
    "GITHUB_CONCURRENCY_LIMIT": "80",
    "MUTATION_MIN_INTERVAL_MS": "1000"
  }
}
```

`DOCUMENT_PATH_PREFIX` 必须与 `book.config.ts` 的 `base` 一致。`ALLOWED_ORIGINS` 只填写 Origin，不包含 `/ebook/` 路径。构建和部署前会从 `content/` 自动生成精确页面白名单，未知路径不会调用 GitHub API。

限额保护由 Worker 统一完成，而不是依赖前端节流：主配额按 token 全局协调并保留 `RATE_LIMIT_RESERVE`；GraphQL query 每次计 1 point、mutation 每次计 5 points；REST `GET/HEAD/OPTIONS` 计 1 point，其他方法计 5 points；OAuth 使用独立滚动窗口。同一仓库的 REST/GraphQL 还共享并发 lease、内容生成分钟/小时滚动预算和 mutative request 最小间隔，所有约束都在请求到达 GitHub 前原子判定，超限直接返回 `429`。GitHub 返回的 `X-RateLimit-*`、`Retry-After` 和 secondary rate limit 也会写入 `RateLimitCoordinator`，用于后续熔断。

### 3. 部署并获得 Worker URL

需要一个 Cloudflare 账号。首次部署时 Wrangler 会打开浏览器完成登录授权：

```powershell
cd worker
npx wrangler login
npx wrangler deploy
```

部署成功后终端会输出类似地址：

```text
https://ebook-reader-worker.<your-workers-subdomain>.workers.dev
```

这就是 Worker URL。也可以进入 Cloudflare Dashboard，在 `Workers & Pages > ebook-reader-worker > Settings > Domains & Routes` 中查看。访问 Worker 根路径返回 `404 {"error":"Not found"}` 是正常的，因为 Worker 只暴露 `/api/*` 接口。

首次部署完成后，把匿名读取 Discussion 使用的 PAT 保存为 Worker secret，并再次部署：

```powershell
npx wrangler secret put GITHUB_PAT
npx wrangler deploy
```

### 4. 配置前端 Worker URL

将部署得到的地址写入 `book.config.ts`：

```ts
github: {
  owner: 'd2wstudy',
  repo: 'ebook',
  workerUrl: 'https://ebook-reader-worker.<your-workers-subdomain>.workers.dev',
},
```

Worker URL 是公开配置，不是 secret。也可以通过 `VITE_WORKER_URL` 覆盖它。本仓库的 GitHub Pages 工作流会读取仓库变量 `VITE_WORKER_URL`，因此可以在 `Settings > Secrets and variables > Actions > Variables` 中设置，而不修改文件。

本地开发可以复制环境变量示例：

```powershell
Copy-Item docs/.env.example docs/.env.development.local
```

```dotenv
VITE_GITHUB_CLIENT_ID=your_oauth_app_client_id
VITE_WORKER_URL=https://your-worker.example.workers.dev
VITE_GITHUB_REPO_OWNER=your-account
VITE_GITHUB_REPO_NAME=my-book
```

### 5. 配置 GitHub OAuth（登录和写操作）

只阅读电子书不需要 OAuth。若要支持登录、发表评论、创建标注和 Reaction，在 GitHub 的 `Settings > Developer settings > OAuth Apps` 中创建 OAuth App。本仓库填写：

```text
Homepage URL: https://d2wstudy.github.io/ebook/
Authorization callback URL: https://d2wstudy.github.io/ebook/
```

将 OAuth 凭据保存到 Worker：

```powershell
cd worker
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler deploy
```

`GITHUB_CLIENT_SECRET` 只能存在于 Worker secrets。`GITHUB_CLIENT_ID` 本身是公开值，前端构建也需要它：在 GitHub 仓库 `Settings > Secrets and variables > Actions > Variables` 中添加 `VITE_GITHUB_CLIENT_ID`。当前 Pages 工作流会在构建时自动读取该变量。本地开发则把它写入 `docs/.env.development.local`。

### 6. 验证 Worker

先验证 CORS 预检。PowerShell 中应使用 `curl.exe`，避免调用 `Invoke-WebRequest` 别名：

```powershell
curl.exe -i -X OPTIONS "https://ebook-reader-worker.<your-workers-subdomain>.workers.dev/api/discussions" `
  -H "Origin: https://d2wstudy.github.io" `
  -H "Access-Control-Request-Method: GET"
```

正常结果为 `204`，并包含：

```text
Access-Control-Allow-Origin: https://d2wstudy.github.io
```

再验证 Discussion 读取接口：

```powershell
curl.exe "https://ebook-reader-worker.<your-workers-subdomain>.workers.dev/api/discussions?path=%2Febook%2Fchapters%2F01-introduction.html&category=General"
```

Worker 的仓库、页面路径前缀、Discussion 分类和允许 Origin 由部署变量固定，不能由浏览器请求动态选择仓库。Discussion 读取使用按页面和分类分片的 SQLite Durable Object，完成持久 fresh/stale 缓存、同对象冷请求 single-flight 和登录用户 Reaction overlay；`RateLimitCoordinator` 按 token 协调主配额，并全局原子协调 REST/GraphQL secondary points、共享并发、内容生成预算与写请求间隔。mutation 成功后只把对应缓存标记为 stale，失效失败也不会把已成功的 GitHub mutation 返回成失败。修改 `worker/wrangler.jsonc` 或 Worker secrets 后需要重新执行 `npx wrangler deploy`。

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
