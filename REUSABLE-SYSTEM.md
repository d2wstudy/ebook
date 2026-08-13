# 可复用电子书系统边界

本仓库由“书籍输入层、阅读器应用层、通用数据层、GitHub 数据源和 Worker”组成。新书通常只需要替换 `book.config.ts`、`content/` 和部署变量。

## 架构

```text
book.config.ts + content/<language>/chapters/*.md
  -> bookContent.ts 自动发现语言、解析 frontmatter、合并页面
  -> VitePress 动态章节路由
  -> 页面级语言切换 + 通用 reader blocks
  -> Vue 评论与标注 UI
       -> @github-reader/core
       -> @github-reader/github
       -> @github-reader/vitepress
  -> Cloudflare Worker
       -> 精确页面白名单
       -> DiscussionCache SQLite Durable Object（每页面/分类）
       -> RateLimitCoordinator SQLite Durable Object
       -> GitHub App exchange / refresh / installation token / Webhook
  -> api.github.com（登录用户的浏览器直连 GraphQL）
```

语言由 `content/` 的一级目录自动发现。不同语言中 slug 相同的 Markdown 会生成同一个页面和 `documentId`，因此章节讨论不会随语言重复创建。

## 包职责

### `@github-reader/core`

- `DiscussionProvider` 通用接口。
- annotation v1/v2/v3 codec。
- TextQuote、TextPosition 和模糊锚点恢复。
- provider 无关的 Reaction 状态。
- `ReaderConfig`、`AnnotationDocumentAdapter` 和通用模型。

### `@github-reader/github`

- GitHub GraphQL mutation 由浏览器携带短期 user token 直连。
- Worker discussion 公共读取、强制刷新、签名 Webhook 与 tokenless 缓存失效提示协议。
- GitHub 数据到通用评论模型的映射。
- 通过 `GitHubAuthBridge` 获取 token，不依赖 Vue。

### `@github-reader/vitepress`

- VitePress route 到规范 `documentId` 的映射。
- 正文 DOM 到通用 annotation block 的适配。
- 自定义 block ID、language、group 和 ready event。

## 书籍输入层

推荐目录：

```text
content/
  en/chapters/01-introduction.md
  zh-CN/chapters/01-introduction.md
  ja/chapters/01-introduction.md
```

语言代码不需要登记。`book.config.ts` 只保留书名、base、可选默认语言、可选语言显示名和 GitHub/Worker 公共配置。

页面 frontmatter：

```yaml
title: Introduction
sidebar: 1. Introduction
group: Getting Started
order: 1
slug: 01-introduction
```

`slug` 可省略，此时从相对文件路径推导。不同语言若使用不同文件名，应显式设置相同 slug。

## 当前语言模型

当前阶段只支持页面级切换：

- 单语言页面不显示语言选择器。
- 多语言页面一次显示一种语言。
- 当前选择在该页不存在时，回退到标记的默认语言或首个可用语言。
- 当前语言保存在以 `projectId` 隔离的 localStorage key 中。
- 每个语言区域使用通用 `data-language`，不再假定 `zh/en`。

页面加载后，主题为可标注正文元素生成 `data-reader-block` 和 `data-reader-language`。`AnnotationDocumentAdapter` 只读取这些通用属性。

## 后续段落级多语言

升级段落级对照时，保留现有页面、`documentId`、provider 和 annotation schema，只扩展内容构建器与主题 DOM：

```html
<div data-reader-group="p-001">
  <div data-reader-block="p-001" data-reader-language="en">...</div>
  <div data-reader-block="p-001" data-reader-language="zh-CN">...</div>
</div>
```

届时需要新增显式 block ID 约定、语言块配对、全部语言显示模式和段落级缺失翻译回退。核心评论协议、GitHub provider 和 Worker 不需要重构。

## Worker 部署

每本书独立部署一个 Worker，并固定：

```jsonc
{
  "vars": {
    "REPO_OWNER": "publisher",
    "REPO_NAME": "my-book",
    "GITHUB_REPOSITORY_ID": "123456789",
    "DOCUMENT_PATH_PREFIX": "/my-book/",
    "DISCUSSION_CATEGORIES": "Ideas,General",
    "ALLOWED_ORIGINS": "https://publisher.github.io,http://localhost:15689"
  }
}
```

Secrets 包括 User Auth App client secret、Reader App private key、session secret 和 Webhook secret；`GITHUB_PAT` 仅作为迁移期只读回退。浏览器请求不能动态指定仓库、分类白名单或允许 Origin。缓存失效接口只接受白名单 Origin、生成的页面 ID 和固定分类，不接收用户 token。

Worker 的调用上限保护分为两层：

- `DiscussionCache` 按 `documentId + category` 分片，SQLite 持久保存 fresh/stale 内容，并合并同一页面的并发冷请求。
- `RateLimitCoordinator` 保护 Worker 公共读取、OAuth exchange/refresh/revoke 和 tokenless 缓存提示。浏览器直连的用户写操作由 GitHub 自身的用户/App 限额负责。

GitHub 限额或暂时故障时，仍在 stale TTL 内的共享 Discussion 可以继续返回。共享缓存从不保存用户 Reaction 状态；登录用户由浏览器直连 `nodes(ids:)` 获取 `viewerHasReacted`，overlay 失败时降级为共享结果。

## 稳定身份

1. `projectId` 在同一站点范围内唯一且长期不变。
2. `documentId` 与语言解耦，URL 调整时保留旧 resolver。
3. 页面 slug 发布后尽量保持稳定。
4. block ID 变化时通过 legacy ID 或 quote fallback 恢复旧标注。
5. 自动文本锚点适合小幅改文，大规模重排应提供显式迁移映射。

## 发布检查

- 单语言目录和多语言目录都能构建。
- 同 slug 的语言文件生成同一页面。
- 语言切换、刷新后偏好恢复和缺失语言回退正常。
- `documentId` 在开发与生产环境一致。
- 中文、英文及其他语言均可划词和恢复标注。
- GitHub Discussion 创建、回复、编辑、删除和 Reaction 正常。
- Worker 拒绝错误路径、分类和 Origin。
- 移动端、键盘和无障碍验收通过。
