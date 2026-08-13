# CLAUDE.md

Implementation guide for agents working in this repository. See `README.md` for local setup and content authoring, `DEPLOYMENT.md` for GitHub/Worker deployment, and `REUSABLE-SYSTEM.md` for architecture boundaries.

## Project status

This is a reusable VitePress/Vue ebook template.

- `book.config.ts` contains book and public deployment settings.
- `content/<language>/chapters/*.md` contains localized Markdown.
- `docs/.vitepress/bookContent.ts` discovers languages and pages at build time.
- The current UI switches complete pages by language; paragraph-level comparison is a future extension.
- Placeholder content intentionally replaces the previous Reinforcement Learning source material.

## Reusable packages

- `@github-reader/core`: provider/document contracts, annotation codecs, text anchors, and optimistic reactions.
- `@github-reader/github`: shared Worker reads plus browser-direct GitHub GraphQL mutations.
- `@github-reader/vitepress`: VitePress route/DOM `DocumentAdapter`.

Keep generic packages independent of Vue, book content, product copy, and specific language codes.

## Commands

```bash
npm ci
npm run dev
npm run typecheck
npm test
npm run test:e2e
npm run check:worker
npm run build
npm run check
```

## Content model

Language directories are discovered automatically. Names should use language identifiers such as `en`, `zh-CN`, or `ja`. Files with the same inferred or explicit slug are combined into one reader page.

Supported frontmatter fields:

```yaml
title: Introduction
sidebar: 1. Introduction
group: Getting Started
order: 1
slug: 01-introduction
```

The default language controls page titles and sidebar metadata when available. A page containing only one language remains valid and hides the language selector.

The generated language containers use `.reader-language` and `data-language`. After navigation, `decorateReaderBlocks()` adds `data-reader-block` and `data-reader-language` to annotatable elements and emits the document-ready event.

Do not reintroduce `.bilingual-en`, `.bilingual-zh`, or fixed language unions into the application path.

## Annotation model

Reader annotations live in comments under the GitHub Discussion category `Notes`. New bodies use schema-v3 Markdown with readable content and bounded metadata; schema-v1/v2 JSON remains readable.

Metadata contains `documentId`, one or more block targets, optional language, TextQuote context, and TextPosition offsets. `AnnotationLayer.vue` accesses book content through `readerDocument` and falls back to quote search when block IDs change.

Do not change document or block identity without a compatibility path.

## Discussions

Each canonical page/category pair maps to one GitHub Discussion. Languages on the same page share one `documentId` and discussion.

- `Notes`: text annotations.
- `Announcements`: readable legacy or publisher-created chapter threads.
- `General`: newly created chapter threads.

Public reads use the Worker. Authenticated GraphQL queries and mutations go directly from the browser to GitHub. Successful mutations send a tokenless, origin-checked invalidation hint; signed GitHub webhooks are the authoritative cache invalidation path. Module-level state must remain keyed by canonical document ID.

## Authentication and Worker

`useAuth.ts` implements GitHub App Web Flow with state validation, PKCE, in-memory access tokens and an encrypted opaque session in local storage. The Worker handles exchange/refresh/revoke but must not persist or log plaintext user tokens. Never place client secrets, private keys, session secrets or PAT values in `book.config.ts` or Vite environment variables.

Worker trust boundaries are deployment variables:

```text
REPO_OWNER
REPO_NAME
GITHUB_REPOSITORY_ID
DOCUMENT_PATH_PREFIX
DISCUSSION_CATEGORIES
ALLOWED_ORIGINS
CACHE_FRESH_TTL
CACHE_STALE_TTL
RATE_LIMIT_RESERVE
GRAPHQL_SECONDARY_BUDGET
REST_SECONDARY_BUDGET
OAUTH_SECONDARY_BUDGET
CACHE_INVALIDATE_BUDGET
CONTENT_MINUTE_BUDGET
CONTENT_HOUR_BUDGET
GITHUB_CONCURRENCY_LIMIT
MUTATION_MIN_INTERVAL_MS
```

Deploy one single-tenant Worker per book unless a separate multi-tenant authorization design is introduced.

## Security

User Markdown is rendered with `marked` and sanitized by DOMPurify. Do not bypass `useMarkdown.ts` with unsanitized `v-html`. Keep origin, route, category, known Discussion and webhook signature validation in the Worker. Never reintroduce a general-purpose user-token GraphQL proxy.

## Tests

- Vitest covers core protocols, anchoring, state races, provider mapping and Worker validation; the Cloudflare Vitest pool covers SQLite Durable Objects, caching and rate coordination in the Workers runtime.
- Playwright uses mocked Discussion data and never mutates a real GitHub repository.
- Browser coverage includes language discovery/switching, missing-language fallback, multilingual selection, annotation deep links, comments, reactions, mobile layout and accessibility.
- `npm run check` does not include Playwright; run `npm run test:e2e` separately.

## Conventions

- Keep user-facing interface text in Simplified Chinese unless localization is explicitly added.
- Preserve `DiscussionProvider` and `DocumentAdapter` boundaries.
- Add tests for changes to language discovery, canonical IDs, anchoring or state.
- Run `npm run check` and `npm run test:e2e` before handoff.
