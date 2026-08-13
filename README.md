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
npm run setup         # 交互式配置 Cloudflare Worker、GitHub Apps 和 Pages 变量
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

`defaultLanguage` 是可选的；未指定时使用当前页面发现的第一个语言。GitHub 仓库、Worker URL 和 GitHub App Client ID 是公开客户端配置；Client Secret、App private key、session secret 和 Webhook secret 只能放在 Worker secrets 中。

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
- GitHub App Web Flow 登录、PKCE、静默续期和登录前待发布选区恢复。
- Cloudflare Worker 读取缓存和 mutation 缓存失效。

段落级多语言对照暂未启用。当前页面已经保留语言区域和稳定 block 的边界，未来可以在构建器中为相同 block ID 生成多语言分组，不需要重写核心 provider、标注协议或 Worker。

## GitHub 与 Worker

本项目采用混合架构：公共 Discussion 读取经过 Worker 的共享缓存；登录用户的评论、标注、回复、编辑、删除和 Reaction 由浏览器携带 GitHub App user access token 直连 `api.github.com`。Worker 只在首次 token exchange、页面恢复、静默 refresh 和撤销授权时处理用户 token，不再代理日常用户写操作。

默认建议为每本书配置两个最小权限 GitHub App：

- `User Auth App`：安装到目标仓库，`Metadata: Read-only`、`Discussions: Read and write`。普通读者只授权这个 App。
- `Worker Reader App`：仅由仓库管理员安装到目标仓库，`Metadata: Read-only`、`Discussions: Read-only`。Worker 每次签发 installation token 时还会用 `repository_ids` 和 `permissions.discussions=read` 再次降权。

这两个 App 不会导致读者授权两次：Reader App 是管理员部署时一次性安装；普通读者只经过 User Auth App 的一次授权流程。

### 授权、token 与可信源

- 只从本项目正式站点点击“登录 GitHub”，并确认浏览器地址是 `github.com`，授权页显示的 GitHub App 名称和所有者与项目 README 公布的信息一致。
- GitHub App user token 没有传统 OAuth `scope`；有效权限是“用户自身权限”和“App 在目标仓库获批权限”的交集，并通过 `repository_id` 进一步限制到当前仓库。
- 默认启用 expiring user token：access token 通常约 8 小时，refresh token 通常约 6 个月。活跃用户会静默轮换，通常只需授权一次。撤销 App、App 权限变化、清除本站存储或 refresh token 因长期未使用而过期时，才需要重新授权。
- 明文 access token 只保存在当前页面内存；浏览器 `localStorage` 保存 Worker 使用 AES-GCM 加密的 opaque session。opaque session 泄漏的影响等同登录会话泄漏，应像其他网站登录 cookie 一样保护。
- Worker 在交换、恢复、续期和撤销时技术上能够接触明文 access/refresh token；实现不会把明文 token 写入 Durable Objects、日志或公共缓存，但 Worker 控制者、前端发布者及依赖供应链仍属于信任边界。公开源码和可自建能力不等同于密码学上的零信任。
- 评论、标注和 Reaction 的 GitHub API 请求从浏览器直连 GitHub，不经过 Worker；写成功后只向 Worker 发送不含 token 的缓存失效提示。
- 不信任本站授权链路时，可以直接打开对应 GitHub Discussion 阅读和评论，完全不向本站授权。
- 可随时在 [GitHub Authorized GitHub Apps](https://github.com/settings/apps/authorizations) 查看或撤销授权。

### 选择配置方式

| 方式 | 适用场景 | 配置入口 |
| --- | --- | --- |
| 自动配置（推荐） | 首次部署、迁移到新仓库或希望由向导完成检查和同步 | `npm run setup` |
| 手动配置 | 无法运行向导，或需要逐项控制 GitHub、Cloudflare 和本地配置 | 按“手动配置”中的 6 个步骤操作 |

两种方式最终会生成相同的配置。自动配置完成后，不需要再重复执行手动配置；如果向导中途失败，重新运行即可从未完成的阶段继续。

### 自动配置（推荐）

#### 前置条件

- 已安装 Node.js 20 或更高版本，并执行过 `npm ci`。
- 已安装 GitHub CLI（`gh`）。
- 当前仓库已配置 GitHub remote，并且当前 GitHub 账号拥有仓库 admin 权限。
- 已准备可用于部署 Worker 的 Cloudflare 账号。

Cloudflare Wrangler 会通过 `npx` 自动获取，不需要全局安装。Windows 如果启用了系统代理，向导会在未设置 `HTTP_PROXY`/`HTTPS_PROXY` 时自动读取代理地址；也可以手动设置这两个环境变量覆盖自动检测。

#### 运行向导

首次配置直接执行：

```powershell
npm run setup
```

向导会从当前 Git remote 推导 GitHub owner 和 repository，按回车即可采用默认值。随后会依次：

1. 检查 Cloudflare 登录状态，必要时打开浏览器完成授权。
2. 检查 GitHub admin 权限，并自动启用 Discussions 和 Workflow 类型 Pages。
3. 检查 `Ideas`、`Announcements`、`General` 分类；GitHub 默认会创建这些分类，缺失时才打开设置页等待管理员补充。
4. 更新 `book.config.ts` 和 `worker/wrangler.jsonc`，并生成 Worker 页面白名单。
5. 部署 Worker，并自动解析 `workers.dev` URL。
6. 创建最小权限的 User Auth App 和 Worker Reader App，并通过 Wrangler 保存 App 凭据、session secret 与 Webhook secret。
7. 写入本地 `docs/.env.development.local`，并同步 GitHub Actions Variables。
8. 验证 Worker CORS、Discussion 接口和本地构建。
9. 最后询问是否提交并推送配置。

#### 向导中的人工确认

以下操作受 GitHub API 限制，向导会打开对应页面并等待确认：

- 创建两个 GitHub App，并填写向导显示的 callback URL、Webhook URL 和最小权限。创建后将 User Auth App Client ID 粘贴回向导。
- 当 `Ideas`、`Announcements` 或 `General` Discussion 分类缺失时，由仓库管理员在设置页中创建；向导随后会自动重新检查。

#### 重新配置与故障恢复

脚本不会把 Client Secret、private key、session secret 或 Webhook secret 写入文件。状态文件只记录阶段是否完成，不记录 Secret 内容，并保存在被 Git 忽略的 `.setup/` 目录中。

中途失败后，再次执行 `npm run setup` 会从未完成的阶段继续。Worker 最后验证遇到网络超时时会自动重试一次；仍然失败时，不会重复部署或写入 Secret。确认本机可以访问 `workers.dev` 后重新运行即可。

如果要修改已完成的配置或轮换 Secret，执行：

```powershell
npm run setup -- --reconfigure
```

如果本机网络无法访问 `workers.dev`，可以只跳过最后的线上连通性验证。该选项不会跳过本地配置检查、构建、Secret 或 Actions Variables 配置；之后可用 `npm run setup:doctor` 重试线上检查：

```powershell
npm run setup -- --skip-verification
```

其他维护命令：

```powershell
npm run setup -- --plan       # 只查看变更计划，不写文件、不部署
npm run setup:doctor          # 检查配置、登录状态、Actions Variables 和 Worker CORS
npm run setup:rollback        # 恢复最近一次本地配置备份，并可重新部署
npm run setup:cleanup         # 显式删除当前状态对应的 Worker 和 Actions Variables
```

`rollback` 不会自动恢复旧 Secret；`cleanup` 不会自动卸载 GitHub Apps 或撤销用户授权，需要在 GitHub/Cloudflare 中单独处理。当前 Pages 工作流要求存在 `VITE_WORKER_URL`，发布到 GitHub Pages 时不要跳过 Actions Variables 同步。启用 Discussions、Pages 和安装 App 需要仓库 admin 权限。

### 手动配置

仅在不使用自动向导时执行下面的步骤。请按顺序完成 GitHub 仓库、Worker、前端和 OAuth 配置。

#### 1. 准备 GitHub 仓库

在目标仓库的 `Settings > General > Features` 中启用 Discussions，并确认 GitHub Pages 使用 GitHub Actions（Workflow）部署。以下分类由 Worker 使用：

- `Ideas`：划词标注使用；GitHub 启用 Discussions 时默认创建。
- `Announcements`：公告读取使用。
- `General`：章节评论使用。

为匿名读取创建 `Worker Reader App`，只安装到目标仓库并授予 `Discussions: Read-only`、`Metadata: Read-only`。迁移期间可以临时用同样只读、单仓库的 fine-grained PAT 作为 `GITHUB_PAT` 回退，但推荐完成 App 配置后移除 PAT。

#### 2. 配置 Worker 部署变量

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
    "GITHUB_REPOSITORY_ID": "1330540843",
    "DOCUMENT_PATH_PREFIX": "/ebook/",
    "DISCUSSION_CATEGORIES": "Ideas,Announcements,General",
    "ALLOWED_ORIGINS": "https://d2wstudy.github.io,http://localhost:15689,http://127.0.0.1:15689",
    "CACHE_FRESH_TTL": "600",
    "CACHE_STALE_TTL": "86400",
    "RATE_LIMIT_RESERVE": "250",
    "GRAPHQL_SECONDARY_BUDGET": "1000",
    "REST_SECONDARY_BUDGET": "450",
    "OAUTH_SECONDARY_BUDGET": "50",
    "CACHE_INVALIDATE_BUDGET": "120",
    "CONTENT_MINUTE_BUDGET": "60",
    "CONTENT_HOUR_BUDGET": "400",
    "GITHUB_CONCURRENCY_LIMIT": "80",
    "MUTATION_MIN_INTERVAL_MS": "1000"
  }
}
```

`DOCUMENT_PATH_PREFIX` 必须与 `book.config.ts` 的 `base` 一致。`ALLOWED_ORIGINS` 只填写 Origin，不包含 `/ebook/` 路径。构建和部署前会从 `content/` 自动生成精确页面白名单，未知路径不会调用 GitHub API。

Worker 只为公共读取、App token 获取、OAuth exchange/refresh/revoke 和缓存提示做限额保护。浏览器直连 GitHub 的用户写操作受 GitHub 自身的用户/App rate limit 约束，不再把普通用户 token 交给 Worker 的统一写请求限流器。

#### 3. 部署并获得 Worker URL

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

首次部署完成后，保存 Worker Reader App 凭据；private key 可以粘贴 GitHub 下载的 PEM（Wrangler 会作为 secret 保存）：

```powershell
npx wrangler secret put GITHUB_READ_APP_ID
npx wrangler secret put GITHUB_READ_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_READ_APP_PRIVATE_KEY
npx wrangler deploy
```

#### 4. 配置前端 Worker URL

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
VITE_GITHUB_CLIENT_ID=your_github_app_client_id
VITE_WORKER_URL=https://your-worker.example.workers.dev
VITE_GITHUB_REPO_OWNER=your-account
VITE_GITHUB_REPO_NAME=my-book
```

#### 5. 配置 User Auth GitHub App（登录和写操作）

只阅读电子书不需要授权。若要支持登录、发表评论、创建标注和 Reaction，在 GitHub 的 `Settings > Developer settings > GitHub Apps` 中创建 User Auth App。本仓库填写：

```text
Homepage URL: https://d2wstudy.github.io/ebook/
Authorization callback URL: https://d2wstudy.github.io/ebook/
Webhook URL: https://ebook-reader-worker.<your-workers-subdomain>.workers.dev/api/github/webhook
```

权限只开启：

- Repository permissions → `Discussions: Read and write`
- `Metadata: Read-only`（GitHub 自动要求）
- 安装范围只选择目标仓库
- 保持 `User-to-server token expiration` 启用
- Webhook 订阅 `Discussion` 和 `Discussion comment`

将凭据保存到 Worker：

```powershell
cd worker
npx wrangler secret put GITHUB_AUTH_APP_CLIENT_ID
npx wrangler secret put GITHUB_AUTH_APP_CLIENT_SECRET
npx wrangler secret put AUTH_SESSION_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler deploy
```

`AUTH_SESSION_SECRET` 应使用密码学随机值且至少 32 字节。Client Secret、session secret 和 Webhook secret 只能存在于 Worker secrets。Client ID 本身是公开值，前端构建也需要它：在 GitHub 仓库 `Settings > Secrets and variables > Actions > Variables` 中添加 `VITE_GITHUB_CLIENT_ID`。当前 Pages 工作流会在构建时自动读取该变量。本地开发则把它写入 `docs/.env.development.local`。

#### 6. 验证 Worker

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

Worker 的仓库、repository ID、页面路径前缀、Discussion 分类和允许 Origin 由部署变量固定，浏览器不能动态选择仓库。Discussion 读取使用按页面和分类分片的 SQLite Durable Object，完成持久 fresh/stale 缓存和冷请求 single-flight；共享缓存中的 `viewerHasReacted` 始终为 `false`，登录用户由浏览器直连 GitHub 查询并覆盖。mutation 成功后浏览器异步发送不含 token 的失效提示，GitHub 签名 Webhook 是更可靠的缓存更新来源；失效失败不会把已成功的 GitHub mutation变成失败。修改 `worker/wrangler.jsonc` 或 Worker secrets 后需要重新执行 `npx wrangler deploy`。

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
worker/                         # GitHub App 会话、公共读取缓存和 Webhook
tests/                          # 单元测试与浏览器验收
```

## 稳定身份约定

语言文件可以持续编辑，但发布后应尽量保持页面 slug 和正文 block 的稳定。已有 GitHub 标注依赖 `documentId`、block ID、选中文本及其上下文；大幅重排内容时应确认旧锚点仍能恢复。

当前模板会根据路由、语言和正文前缀生成 block ID。未来如果需要对翻译进行精确段落映射，可以在 Markdown 中增加显式 block ID，而不改变评论数据格式。

## 许可证与内容

仓库中的模板代码与书籍内容应分别确认许可证。当前示例内容是占位文本，不包含原书内容；替换为实际书籍前请确认版权和再分发权限。
