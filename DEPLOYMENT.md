# 部署与 GitHub 集成

本文档说明如何将电子书发布到 GitHub Pages，并配置 Cloudflare Worker、GitHub Apps、章节评论和划词标注。只需要本地阅读或构建静态内容时，无需完成这些配置。

## 部署组成

| 组件 | 职责 |
| --- | --- |
| GitHub Pages | 托管 VitePress 静态站点 |
| User Auth GitHub App | 为普通读者提供登录以及 Discussions 写权限 |
| Worker Reader GitHub App | 供 Worker 匿名读取目标仓库的 Discussions |
| Cloudflare Worker | 公共读取缓存、OAuth exchange/refresh/revoke、Webhook 和限额协调 |

推荐每本书使用一个单租户 Worker，并创建两个只安装到目标仓库的最小权限 GitHub App：

- **User Auth App**：`Metadata: Read-only`、`Discussions: Read and write`。普通读者只授权这个 App。
- **Worker Reader App**：`Metadata: Read-only`、`Discussions: Read-only`。仅由仓库管理员在部署时安装。

读者不会被要求授权两次：Reader App 只在管理员部署时安装，读者登录仅经过 User Auth App。

## 自动配置（推荐）

### 前置条件

- Node.js 20 或更高版本，并已执行 `npm ci`。
- 已安装并登录 GitHub CLI（`gh`）。
- 当前仓库已配置 GitHub remote，当前 GitHub 账号拥有仓库 admin 权限。
- 已准备可用于部署 Workers 的 Cloudflare 账号。

Wrangler 会通过项目依赖运行，无需全局安装。Windows 启用系统代理时，向导会在未设置 `HTTP_PROXY` / `HTTPS_PROXY` 时尝试读取系统代理，也可以通过这两个环境变量显式覆盖。

### 运行向导

```powershell
npm run setup
```

向导会从当前 Git remote 推导 owner 和 repository，并依次完成：

1. 检查 Cloudflare 登录状态，必要时打开浏览器授权。
2. 检查 GitHub admin 权限，启用 Discussions 和 GitHub Actions 类型的 Pages。
3. 检查 `Ideas`、`Announcements`、`General` Discussion 分类。
4. 更新 `book.config.ts`、`worker/wrangler.jsonc` 和 Worker 页面白名单。
5. 部署 Worker 并解析 `workers.dev` URL。
6. 引导创建 User Auth App 和 Worker Reader App。
7. 通过 Wrangler 保存 App 凭据、session secret 与 Webhook secret。
8. 写入本地开发环境变量并同步 GitHub Actions Variables。
9. 验证 Worker CORS、Discussion 接口和本地构建。
10. 询问是否提交并推送配置。

由于 GitHub API 的限制，以下步骤需要管理员在浏览器中确认：

- 创建两个 GitHub App，并按向导提供的 callback URL、Webhook URL 和权限填写配置。
- 将 User Auth App Client ID 粘贴回向导。
- 当指定 Discussion 分类缺失时，在仓库设置中创建分类。

### 中断续跑与维护

向导状态保存在被 Git 忽略的 `.setup/` 中，只记录执行阶段，不保存 Secret。执行中断后，再次运行 `npm run setup` 会从未完成阶段继续。

```powershell
npm run setup -- --plan               # 只查看计划，不写文件或修改远端
npm run setup -- --reconfigure        # 修改配置或轮换 Secret
npm run setup -- --skip-verification  # 跳过最后的 Worker 在线连通性验证
npm run setup:doctor                  # 重新检查配置、变量、CORS 和接口
npm run setup:rollback                # 恢复最近一次本地配置备份，可重新部署
npm run setup:cleanup                 # 删除当前状态对应的 Worker 和 Actions Variables
```

`rollback` 不会恢复旧 Secret。`cleanup` 不会卸载 GitHub Apps 或撤销用户授权，这些操作需要在 GitHub 和 Cloudflare 控制台中单独完成。

## 手动配置

只有无法运行向导或需要逐项控制时，才需要执行本节。

### 1. 准备 GitHub 仓库

在目标仓库中：

1. 在 `Settings > General > Features` 启用 Discussions。
2. 在 `Settings > Pages` 选择 GitHub Actions（Workflow）作为发布源。
3. 确认存在以下 Discussion 分类：
   - `Ideas`：划词标注。
   - `Announcements`：公告读取。
   - `General`：章节评论。
4. 创建 Worker Reader GitHub App，只安装到目标仓库，并授予：
   - `Metadata: Read-only`
   - `Discussions: Read-only`

迁移期间可以临时使用同样只读、单仓库的 fine-grained PAT 作为 `GITHUB_PAT`，完成 Reader App 配置后应移除。

### 2. 配置 Worker

编辑 `worker/wrangler.jsonc`：

```jsonc
{
  "name": "my-book-reader-worker",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-13",
  "durable_objects": {
    "bindings": [
      { "name": "DISCUSSION_CACHE", "class_name": "DiscussionCache" },
      { "name": "GITHUB_RATE_LIMIT", "class_name": "RateLimitCoordinator" }
    ]
  },
  "vars": {
    "REPO_OWNER": "your-account",
    "REPO_NAME": "my-book",
    "GITHUB_REPOSITORY_ID": "123456789",
    "DOCUMENT_PATH_PREFIX": "/my-book/",
    "DISCUSSION_CATEGORIES": "Ideas,Announcements,General",
    "ALLOWED_ORIGINS": "https://your-account.github.io,http://localhost:15689,http://127.0.0.1:15689",
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

注意：

- `DOCUMENT_PATH_PREFIX` 必须与 `book.config.ts` 的 `base` 一致。
- `ALLOWED_ORIGINS` 只填写 Origin，不包含 `/my-book/` 路径。
- 构建和部署前会从 `content/` 生成精确页面白名单，未知路径不会调用 GitHub API。
- 仓库、repository ID、分类和 Origin 均由部署配置固定，浏览器不能动态指定。

### 3. 部署 Worker

```powershell
cd worker
npx wrangler login
npx wrangler deploy
```

部署后记录终端输出的 URL，例如：

```text
https://my-book-reader-worker.<your-workers-subdomain>.workers.dev
```

访问 Worker 根路径得到 `404 {"error":"Not found"}` 是正常现象，Worker 只暴露 `/api/*` 接口。

保存 Worker Reader App 凭据。Private key 可以直接粘贴 GitHub 下载的 PEM：

```powershell
npx wrangler secret put GITHUB_READ_APP_ID
npx wrangler secret put GITHUB_READ_APP_INSTALLATION_ID
npx wrangler secret put GITHUB_READ_APP_PRIVATE_KEY
npx wrangler deploy
```

### 4. 配置前端公开变量

将 Worker URL 写入 `book.config.ts`：

```ts
github: {
  owner: 'your-account',
  repo: 'my-book',
  workerUrl: 'https://my-book-reader-worker.<your-workers-subdomain>.workers.dev',
},
```

Worker URL 是公开配置，也可以通过 `VITE_WORKER_URL` 覆盖。本地开发可复制示例文件：

```powershell
Copy-Item docs/.env.example docs/.env.development.local
```

```dotenv
VITE_GITHUB_CLIENT_ID=your_github_app_client_id
VITE_WORKER_URL=https://my-book-reader-worker.<your-workers-subdomain>.workers.dev
VITE_GITHUB_REPO_OWNER=your-account
VITE_GITHUB_REPO_NAME=my-book
```

不要把 Client Secret、private key、session secret、Webhook secret 或 PAT 放入 Vite 环境变量或 `book.config.ts`。

### 5. 创建 User Auth GitHub App

只阅读电子书不需要登录。要启用评论、标注和 Reaction，请在 GitHub 的 `Settings > Developer settings > GitHub Apps` 中创建 User Auth App。

以 GitHub Pages 项目站点为例：

```text
Homepage URL: https://your-account.github.io/my-book/
Authorization callback URL: https://your-account.github.io/my-book/
Webhook URL: https://my-book-reader-worker.<your-workers-subdomain>.workers.dev/api/github/webhook
```

仅开启以下仓库权限：

- `Discussions: Read and write`
- `Metadata: Read-only`（GitHub 自动要求）

安装范围只选择目标仓库，保持 `User-to-server token expiration` 启用，并订阅 `Discussion` 和 `Discussion comment` Webhook 事件。

将敏感凭据保存到 Worker：

```powershell
cd worker
npx wrangler secret put GITHUB_AUTH_APP_CLIENT_ID
npx wrangler secret put GITHUB_AUTH_APP_CLIENT_SECRET
npx wrangler secret put AUTH_SESSION_SECRET
npx wrangler secret put GITHUB_WEBHOOK_SECRET
npx wrangler deploy
```

`AUTH_SESSION_SECRET` 应是至少 32 字节的密码学随机值。Client ID 本身是公开值，前端构建也需要它。

### 6. 配置 GitHub Pages 变量

在仓库 `Settings > Secrets and variables > Actions > Variables` 中添加：

| Variable | 值 |
| --- | --- |
| `VITE_WORKER_URL` | 已部署的 HTTPS Worker URL，必填 |
| `VITE_GITHUB_CLIENT_ID` | User Auth App Client ID，启用登录时填写 |

仓库自带的 `.github/workflows/deploy.yml` 会在推送到 `main` 后构建并发布 Pages。未设置有效的 `VITE_WORKER_URL` 时，工作流会主动失败并提示配置变量。

### 7. 验证 Worker

PowerShell 中使用 `curl.exe`，避免调用 `Invoke-WebRequest` 别名。

验证 CORS 预检：

```powershell
curl.exe -i -X OPTIONS "https://my-book-reader-worker.<your-workers-subdomain>.workers.dev/api/discussions" `
  -H "Origin: https://your-account.github.io" `
  -H "Access-Control-Request-Method: GET"
```

正常结果为 `204`，并包含：

```text
Access-Control-Allow-Origin: https://your-account.github.io
```

验证 Discussion 公共读取：

```powershell
curl.exe "https://my-book-reader-worker.<your-workers-subdomain>.workers.dev/api/discussions?path=%2Fmy-book%2Fchapters%2F01-introduction.html&category=General"
```

也可以运行项目诊断：

```powershell
npm run setup:doctor
npm run check
```

## 认证与可信边界

- 只从正式站点进入 GitHub 登录，并确认授权页域名为 `github.com`、App 名称和所有者正确。
- GitHub App user token 的有效能力是“用户自身权限”和“App 在目标仓库获批权限”的交集，并进一步限制到目标仓库。
- 默认启用 expiring user token。Access token 通常约 8 小时，refresh token 通常约 6 个月；活跃会话会静默轮换。
- 明文 access token 仅保存在当前页面内存。浏览器 `localStorage` 保存由 Worker 使用 AES-GCM 加密的 opaque session。
- Worker 在 exchange、恢复、refresh 和 revoke 时会短暂接触明文 token，但实现不会将其写入 Durable Objects、公共缓存或日志。
- 登录用户的 GitHub API 写请求从浏览器直连 `api.github.com`；成功后只向 Worker 发送不含 token 的缓存失效提示。
- 签名 GitHub Webhook 是更可靠的缓存更新来源。失效提示失败不会把已经成功的 GitHub mutation 判定为失败。
- 不希望使用本站登录链路时，可以直接打开对应 GitHub Discussion 阅读或评论。
- 用户可在 [GitHub Authorized GitHub Apps](https://github.com/settings/apps/authorizations) 查看或撤销授权。

公开读取使用按页面和分类分片的 SQLite Durable Object 缓存，并支持 fresh/stale TTL 与冷请求 single-flight。共享缓存不会保存用户的 `viewerHasReacted` 状态；登录后由浏览器直连 GitHub 查询并覆盖。

## 常见问题

### Worker URL 可访问，但根路径返回 404

这是预期行为。请验证 `/api/discussions` 或运行 `npm run setup:doctor`。

### 向导在 Worker 验证阶段超时

确认本机可以访问 `workers.dev` 后重新运行 `npm run setup`。网络暂时受限时可以执行：

```powershell
npm run setup -- --skip-verification
```

之后使用 `npm run setup:doctor` 补做在线检查。

### 修改配置或 Secret 后没有生效

修改 `worker/wrangler.jsonc` 或 Worker secrets 后必须重新部署：

```powershell
cd worker
npx wrangler deploy
```

### 撤销部署

`npm run setup:cleanup` 可以处理当前状态对应的 Worker 和 Actions Variables，但 GitHub Apps、安装和用户授权仍需在 GitHub 中手动卸载或撤销。
