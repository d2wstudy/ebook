# VitePress 多语言电子书模板

用 Markdown 编写内容，即可生成支持多语言切换、划词标注和章节讨论的电子书站点。

[在线示例](https://d2wstudy.github.io/ebook/) · [部署指南](./DEPLOYMENT.md) · [架构说明](./REUSABLE-SYSTEM.md)

## 功能

- **内容驱动**：自动扫描 `content/<language>/`，无需手工维护章节或语言列表。
- **多语言阅读**：相同 slug 的译文合并为同一页面，缺少译文时自动回退。
- **电子书体验**：侧边栏、全文搜索、数学公式、图片懒加载和作者注释。
- **标注与讨论**：支持跨段划词、笔记回复、编辑、删除、Reaction 和章节评论。
- **GitHub 集成**：以 GitHub Discussions 保存公开内容，通过 GitHub App 登录。
- **可部署**：静态站点发布到 GitHub Pages，Cloudflare Worker 提供公共读取缓存和认证会话。

当前采用**页面级语言切换**；段落级双语对照尚未启用。

## 快速开始

需要 Node.js 20 或更高版本。

```powershell
git clone https://github.com/d2wstudy/ebook.git
cd ebook
npm ci
npm run dev
```

打开 <http://localhost:15689/ebook/>。仅浏览本地内容不需要配置 GitHub App 或 Cloudflare Worker。

生产构建：

```powershell
npm run build
npm run preview
```

## 创建自己的电子书

### 1. 修改书籍配置

编辑 `book.config.ts`：

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

`defaultLanguage` 和 `languageNames` 可选。`workerUrl` 是公开配置；Client Secret、private key、session secret 等敏感信息只能保存为 Worker secrets。

### 2. 添加 Markdown 内容

语言由 `content/` 下的一级目录自动发现：

```text
content/
  en/
    chapters/01-introduction.md
    chapters/02-content-model.md
  zh-CN/
    chapters/01-introduction.md
```

目录名使用语言代码，例如 `en`、`zh-CN`、`ja`。相同相对路径默认属于同一页面；如果不同语言使用了不同文件名，请通过相同的 `slug` 显式关联。

每个文件可使用以下 frontmatter：

```md
---
title: Introduction
sidebar: 1. Introduction
group: Getting Started
order: 1
slug: 01-introduction
---

# Introduction

正文内容。
```

| 字段 | 用途 | 必填 |
| --- | --- | --- |
| `title` | 页面标题 | 否，会从第一个 H1 或文件名推导 |
| `sidebar` | 侧边栏标题 | 否，默认使用 `title` |
| `group` | 侧边栏分组 | 否，默认是“内容” |
| `order` | 分组内排序 | 否，默认是 `0` |
| `slug` | 页面稳定标识 | 否，默认从相对文件路径推导 |

页面发布后应尽量保持 slug 稳定。评论与标注使用与语言无关的 `documentId`，正文大幅重排时也应检查旧标注能否恢复。

### 3. 检查项目

```powershell
npm run check
```

该命令会执行类型检查、单元测试、Worker 检查和站点构建。

## 启用登录、标注和评论

静态阅读功能开箱即用；GitHub 登录、标注、章节评论和 Reaction 需要配置 GitHub Apps、Cloudflare Worker 与 GitHub Pages 变量。

推荐使用交互式向导：

```powershell
npm run setup
```

向导支持中断续跑、配置诊断、回滚和清理。完整前置条件、权限说明、手动配置与验证命令见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动本地开发服务器 |
| `npm run build` | 构建静态站点 |
| `npm run preview` | 预览生产构建 |
| `npm run setup` | 配置 GitHub、Worker 和 Pages 变量 |
| `npm run setup:doctor` | 诊断部署配置与 Worker 连通性 |
| `npm run typecheck` | 执行 TypeScript / Vue 类型检查 |
| `npm test` | 执行 Vitest 单元测试 |
| `npm run test:worker` | 在 Workers runtime 中执行测试 |
| `npm run test:e2e` | 执行 Playwright 浏览器测试 |
| `npm run check` | 执行完整项目检查 |

## 工作方式

```text
book.config.ts + content/<language>/*.md
  -> VitePress 构建器生成统一章节页面
  -> 阅读器主题提供语言切换、标注与评论 UI
  -> Cloudflare Worker 处理公共读取缓存、OAuth 会话和 Webhook
  -> 登录用户从浏览器直连 GitHub API 完成写操作
```

公共 Discussion 读取经过 Worker 缓存；登录用户的评论、标注和 Reaction 写操作直接发送到 GitHub。Worker 不代理日常用户写请求，也不会持久化明文用户 token。更完整的模块边界见 [REUSABLE-SYSTEM.md](./REUSABLE-SYSTEM.md)。

## 目录结构

```text
book.config.ts                  # 书名、路径、语言和公开 GitHub 配置
content/<language>/             # 按语言组织的 Markdown 原稿
docs/.vitepress/                # VitePress 配置、内容构建器和阅读器主题
packages/core/                  # 通用标注、锚点和 Reaction 协议
packages/github/                # GitHub Discussions provider
packages/vitepress/             # VitePress 文档适配器
worker/                         # Cloudflare Worker、缓存、认证和 Webhook
scripts/                        # 配置向导与构建辅助脚本
tests/                          # 单元、Worker runtime 与 E2E 测试
```

## 相关文档

- [DEPLOYMENT.md](./DEPLOYMENT.md)：部署、GitHub Apps、Worker、权限与故障恢复。
- [REUSABLE-SYSTEM.md](./REUSABLE-SYSTEM.md)：模块职责、数据边界和扩展约定。
- [AUDIT.md](./AUDIT.md)：当前实现审查、已修复问题和上线检查项。
- [CLAUDE.md](./CLAUDE.md)：供仓库内编码代理使用的实现约定。

## 许可证与内容

仓库目前未附带统一的 `LICENSE` 文件。模板代码与书籍内容在复制、修改或再分发前应分别确认授权；示例章节仅为占位内容。
