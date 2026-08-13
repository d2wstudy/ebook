# 项目代码与功能审查报告

> 本文记录的是旧版书籍专用阅读器的历史审查。当前项目已改造成通用电子书模板；现行架构和验证方式请以 `README.md`、`CLAUDE.md` 和 `REUSABLE-SYSTEM.md` 为准。

审查日期：2026-08-06

## 审查范围

- VitePress 配置、内容目录与 GitHub Pages 部署
- 中英双语渲染和语言切换
- GitHub OAuth 登录与令牌生命周期
- GitHub Discussions 数据模型、GraphQL 写入和 Worker 缓存
- 章节评论、回复、Reaction、Markdown 渲染
- 中文/英文划词、跨段标注、重叠高亮和重新锚定
- 桌面端、移动端、键盘和基础无障碍交互
- TypeScript、单元测试、构建和依赖安全基线

## 总结

原项目的产品方向是成立的，文本锚点、Discussion 缓存和重叠标注已经有一定深度；但实现中同时存在状态模型错误、未完成需求、文档过时和交互闭环缺失。

本轮已经把项目从“功能演示”推进到更清晰的可维护基线。评论标注仍依赖外部 GitHub/Worker 状态，正式上线前需要部署新版 Worker 并完成真实账号回归。

## 已修复问题

### 高优先级

| 问题 | 原因 | 处理结果 |
| --- | --- | --- |
| SSR 构建时请求 Discussion | `watch(..., { immediate: true })` 在服务端直接加载 | 数据层增加浏览器边界；构建不再产生代理请求失败 |
| 跨章节可能复用上一章 Discussion | 注释和评论各自只有一个模块级 `_discussionId` | Discussion 元数据改为按标准化页面路径存储，并增加请求序列防止旧请求覆盖新页面 |
| 英文划词创建后无法显示 | 保存时没有语言字段，渲染时固定在中文块解析 | 新 schema 保存 `language`；旧数据在中英文之间兼容解析 |
| 登录后丢失匿名选区 | OAuth 跳转前清除了 Selection，没有保存锚点 | 选区在 `sessionStorage` 暂存，登录返回后自动恢复编辑器 |
| 新章节评论可能无法创建 | `Announcements` 是公告格式，普通用户只能评论、不能创建 Discussion | 继续读取旧 Announcements 线程；新线程创建到开放的 `General` 分类 |
| OAuth 登录 CSRF | 授权请求没有 `state` | 增加随机 state、回调校验和错误提示 |
| Token 长期保存在 localStorage | 令牌在浏览器重启后仍存在，扩大 XSS 暴露窗口 | 改为 sessionStorage，并迁移、删除旧 localStorage 数据 |
| Worker 已知 ID 未验证页面 | 传入 ID 后直接读取 Node，忽略 path/category | Worker 校验 Discussion 标题和分类，不匹配时重新搜索 |
| GitHub API 错误被显示成空评论 | 前端和 Worker 多处吞掉网络/GraphQL 错误 | 改为结构化错误、重试提示，失败响应不再写成空缓存 |
| GitHub API 调用上限缺少全局协调 | 页面缓存、登录查询和 mutation 分散计数，无法防止突发触发 primary/secondary limit | SQLite `RateLimitCoordinator` 按 token 保护主配额并保留 reserve；按仓库原子协调 GraphQL/REST secondary points、共享并发 lease、内容生成双滚动窗口及 mutative request 最小间隔；OAuth 独立滚动计数；GraphQL mutation 与 REST 写方法按 5 points 计费 |
| Discussion 缓存使用 Durable Object KV 单值 | 大线程存在单值尺寸风险，且缓存状态难以直接核验 | 改为 SQLite 表保存 shared discussion 和按 token hash 的 Reaction overlay |
| Reaction 乐观更新不能回滚 | 本地先修改，GraphQL 失败后不恢复 | 增加操作锁、快照和失败回滚 |
| 同页重复加载可能永久停在 loading | 去重后的同一 Promise 被后一次请求序列判定为过期，唯一负责收尾的调用无法落状态 | 评论和标注加载为每个调用保留序列，既复用网络请求，也能正确结束当前页面状态 |
| 异步 mutation 可能写回已经离开的页面 | 创建、编辑或删除完成后直接修改当前模块状态 | mutation 完成前后校验标准化页面键，旧页面结果不再污染新路由 |
| 公开 annotation JSON 直接进入锚点逻辑 | Discussion 内容可由外部用户构造，offset、段落 ID 和 segments 缺少边界 | 增加 schema、类型、长度、offset、段落 ID、片段数量与总文本量验证 |
| Reaction 缓存可被客户端增量污染 | Worker 接受浏览器传入 delta 修改共享计数，且遗漏真实存在的 `CONFUSED` | 补齐八种官方 Reaction；严格校验参数，只失效缓存并从 GitHub 重取权威数据 |

### 未完成需求补齐

| 需求 | 原状态 | 当前状态 |
| --- | --- | --- |
| 三种语言模式 | 首页声称支持三种，代码只有中/英二选一 | 支持仅中文、仅英文和中英对照；每段可独立循环切换 |
| 评论/笔记编辑与删除 | GitHub 支持，站点未使用 | 作者可以编辑、删除自己的主评论、笔记和回复 |
| GitHub 能力衔接 | 仅做存储 | 展示作者关联身份、GitHub 原始链接、全套 Reaction 和回复 |
| Discussion 页面键一致性 | 开发/生产可能产生不同标题 | 统一为带 base 和 `.html` 的生产路径 |
| 评论分页 | 固定前 100 条 | Worker 分页读取最多 1,000 条顶层评论 |
| 用户 Reaction 批量查询 | 节点数超过 100 时可能失败 | 每 100 个节点分批查询 |
| 内容目录一致性 | 侧边栏指向不存在的章节 | 英文原稿通过动态路由生成真实页面；缺少中文时自动回退英文，并明确提示 OCR 与翻译状态 |

### 划词和界面改进

- 同时支持中文、英文、单段和跨段选区。
- 统一过滤作者弹层、评论气泡等 UI 文本，避免字符偏移污染。
- 修正选区首尾空白导致 `selectedText` 和位置不一致的问题。
- 选区工具条自动限制在视口内，并根据空间显示在选区上方或下方。
- 增加移动端 Selection 监听、键盘选区触发和滚动关闭行为。
- Range 起止点为 Element 时也能解析，覆盖全选、键盘和部分移动端浏览器产生的选区。
- 双语模式的跨段选区若实际混入另一语言，会提示切换到单语模式，避免生成含义不明的锚点。
- 高亮元素支持焦点、Enter 和 Space 打开。
- 重叠标注继续使用原子区间拆分，避免 DOM 交叉嵌套损坏。
- 段落 ID 变化后，会在当前页面按 exact quote 搜索旧锚点。
- 抽屉增加加载骨架、错误重试、GitHub 链接、焦点恢复、Escape 关闭、背景滚动锁定和 Tab 焦点循环。
- 评论增加编辑器忙碌态、字数提示、错误保留草稿、菜单、链接复制和作者身份徽章；菜单与 Reaction picker 全局互斥，Escape 关闭弹层但保留编辑草稿。
- 补充回复 Reaction 的可访问名称、ghost 用户兼容和图片 no-referrer，并提升辅助文字和操作按钮的颜色对比度。

## 工程与安全改进

- 新增 `README.md` 中英双语说明和 `docs/.env.example`。
- 将评论与标注能力拆为 `@github-reader/core`、`@github-reader/github` 和 `@github-reader/vitepress` 三个内部 workspace 包；当前电子书通过集中配置和 `DocumentAdapter` 接入。
- GitHub provider 改用通用 `documentId`，不再依赖 VitePress route 或双语 DOM；`AnnotationLayer.vue` 不再直接查询 `.bilingual-*`。
- 新 annotation 使用 GitHub 中可直接阅读的 schema v3 Markdown，同时保持 schema v1/v2 JSON 兼容；编辑旧笔记时可自然升级。
- Worker 的仓库、路径前缀、Discussion 分类和 Origin 改为部署变量，并校验已知 Discussion 确实属于配置仓库；客户端不能动态选择 owner/repo。
- 所有 GitHub API 调用统一经 Worker；精确页面白名单、SQLite fresh/stale cache、并发 single-flight、主配额 reserve、secondary points、共享并发 lease、内容生成双窗口与写请求间隔均在回源前生效。
- 新增 [REUSABLE-SYSTEM.md](./REUSABLE-SYSTEM.md)，记录其他电子书的配置、适配、稳定 ID、Worker 和迁移边界。
- 更新 `CLAUDE.md`，删除已废弃且未使用的 `NoteBlock.vue`、`NoteEditor.vue`。
- 新增 `vue-tsc`、Vitest、happy-dom、`tsconfig.json` 和统一 `npm run check`。
- 新增 Playwright 与 axe E2E，使用模拟只读 Discussion API，不登录或修改真实 GitHub 数据。
- DOMPurify、Rollup、PostCSS、xmldom 等可兼容更新已经应用到锁文件。
- 用户 Markdown 链接增加 `noopener noreferrer`；图片限制为 HTTPS/站内路径并使用 no-referrer，同时拒绝 scheme-relative 和反斜杠变体。
- Worker CORS 从 `*` 改为 origin allowlist，并验证 OAuth client、redirect origin、页面路径和分类。
- GitHub 返回 401 时前端立即清除失效会话；OAuth 撤销失败会明确反馈，不再把本地退出误报为远端撤销成功。
- README 的中英文架构、目录、Worker、测试和安全说明已对齐；开发 OAuth 示例已更新到端口 `15689` 与 `/rl-book-bilingual/` base。

## 尚未完全解决的风险

### 上线前必须完成

1. **部署新版 Worker。** 新前端不再兼容旧 Worker；必须同步部署包含 Durable Object migrations、页面白名单、GitHub API 代理和配额协调的新版本。
2. **使用真实普通账号回归。** 需要验证首次创建 `General` 章节 Discussion、Notes Discussion、编辑、删除、回复、全部 Reaction 和 OAuth 撤销。
3. **确认 GitHub OAuth App 回调配置。** 生产和开发 Client ID、callback URL、Worker secrets 必须与 README 一致。
4. **为大量内容确定永久段落 ID。** `DocumentAdapter` 已支持稳定 ID 和 legacy ID，但当前书仍使用 hash + quote 重定位；在全书发布前，建议在 Markdown 中引入显式、不可变的段落 ID。

### 中期改进

1. Worker 每条评论最多读取前 100 个回复。极端长线程需要增加回复游标分页或按需加载。
2. 前端仍持有 GitHub OAuth token，但所有读取和 mutation 已经代理到 Worker；进一步收敛风险需要改为服务端会话/httpOnly cookie。
3. 当前 OAuth 请求使用较宽的 `public_repo` scope；GitHub OAuth App 没有 Discussions-only 的公开仓库写 scope。应持续在登录说明中披露，并评估 GitHub App 或服务端会话。
4. 编辑采用最后写入者覆盖，没有冲突检测。可以利用 `lastEditedAt` 做乐观并发控制提示。
5. GitHub 的最小化评论、举报、锁定 Discussion、置顶和 Q&A answer 等管理能力仍主要通过“在 GitHub 查看”完成。
6. 自动化 E2E 已覆盖模拟 Worker mutation，但仍没有带真实 GitHub 登录和真实仓库 mutation 的浏览器测试。
7. 全书原始素材包含至少数百个 NUL/OCR 异常和大量外链图片，需要独立清洗流水线、资源归档和版权检查。

### 依赖残余

`npm audit` 的兼容更新已经执行，但 VitePress 1.6.4 固定在 Vite 5.x，仍会报告 Vite/esbuild 开发服务器相关公告。该风险主要影响暴露到不可信网络的本地开发服务器：

- 完整审计当前为 3 项（2 moderate、1 high），均来自 `vitepress → vite → esbuild` 开发/构建链。
- `npm audit --omit=dev` 为 0，静态站点没有随部署产物运行的 Node 生产依赖漏洞。

- 开发服务器只绑定受信任环境，不要公开暴露。
- 关注 VitePress 后续稳定版本对新 Vite 主线的支持。
- 不建议仅靠 npm override 强行跨越 VitePress 声明的兼容范围。

## 验收基线

代码交付前应至少通过：

```bash
npm run check
npm run test:e2e
npm audit --registry=https://registry.npmjs.org
git diff --check
```

本轮浏览器基线包含 10 项 Playwright 场景，覆盖语言发现与回退、多语言划词、笔记深链接、八种 Reaction、OAuth 临时失败恢复、schema v3 Worker mutation、360px 抽屉、焦点约束、匿名抽屉与登录态编辑器的 axe 扫描；当前 serious/critical 无障碍违规为 0。

2026-08-13 GitHub API/Worker 重构后本地核验：`npm run check` 通过（32 项普通 Vitest、9 项 Workers runtime、Wrangler types、deploy dry-run 与 VitePress build），`npm run test:e2e` 10/10 通过，`git diff --check` 通过；完整 `npm audit` 仍为 3 项开发链公告（2 moderate、1 high），`npm audit --omit=dev` 为 0。未发布 npm、未部署 Worker、未 push，也未写入真实 GitHub 数据。

交互回归应覆盖：

- 三种全局语言模式及段落独立切换
- 中文/英文单段划词
- 中文/英文跨段划词
- 重叠高亮打开同一抽屉
- 匿名选区 → GitHub 登录 → 恢复草稿
- 评论/笔记的创建、回复、编辑、删除和 Reaction
- Discussion 链接与笔记深链接
- 360px 移动端抽屉、Reaction picker 和编辑器
