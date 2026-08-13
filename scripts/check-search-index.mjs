import { gzipSync } from 'node:zlib'
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const distDir = resolve('docs/.vitepress/dist')
const chunksDir = resolve(distDir, 'assets/chunks')
const indexPattern = /^@localSearchIndex.*\.js$/

const files = (await readdir(chunksDir))
  .filter(file => indexPattern.test(file))
  .sort()

if (!files.length) {
  fail('未找到 VitePress 本地搜索索引文件。')
}

let documentCount = 0
let rawBytes = 0
let gzipBytes = 0
const indexedChapterPaths = new Set()

for (const file of files) {
  const absolute = resolve(chunksDir, file)
  const source = await readFile(absolute)
  const moduleUrl = `${pathToFileURL(absolute).href}?check=${Date.now()}`
  const loaded = await import(moduleUrl)
  const index = JSON.parse(loaded.default)

  documentCount += Number(index.documentCount || 0)
  for (const documentId of Object.values(index.documentIds || {})) {
    const pagePath = String(documentId).split(/[?#]/, 1)[0].replaceAll('\\', '/')
    if (pagePath.includes('/chapters/')) indexedChapterPaths.add(pagePath)
  }
  rawBytes += (await stat(absolute)).size
  gzipBytes += gzipSync(source).byteLength
}

const hashMap = JSON.parse(await readFile(resolve(distDir, 'hashmap.json'), 'utf8'))
const chapterCount = Object.keys(hashMap)
  .filter(key => key.startsWith('chapters_'))
  .length

if (documentCount === 0) {
  fail('搜索索引为空（documentCount = 0）。动态章节可能没有进入索引。')
}

if (chapterCount > 0 && indexedChapterPaths.size < chapterCount) {
  fail(
    `搜索索引只覆盖 ${indexedChapterPaths.size} 个唯一章节路径，`
    + `少于构建出的 ${chapterCount} 个章节。`,
  )
}

const warnLimit = positiveNumber(process.env.SEARCH_INDEX_WARN_GZIP_KB, 5 * 1024) * 1024
const maxLimit = positiveNumber(process.env.SEARCH_INDEX_MAX_GZIP_KB, Number.POSITIVE_INFINITY) * 1024

console.log(
  `搜索索引校验通过：覆盖 ${indexedChapterPaths.size}/${chapterCount} 个章节，`
  + `${documentCount} 条记录，`
  + `原始 ${formatBytes(rawBytes)}，gzip ${formatBytes(gzipBytes)}。`,
)

if (gzipBytes > warnLimit) {
  warn(`搜索索引 gzip 体积为 ${formatBytes(gzipBytes)}，已超过 ${formatBytes(warnLimit)}。`)
}

if (gzipBytes > maxLimit) {
  fail(
    `搜索索引 gzip 体积超过 SEARCH_INDEX_MAX_GZIP_KB 限制：`
    + `${formatBytes(gzipBytes)} > ${formatBytes(maxLimit)}。`,
  )
}

function positiveNumber(value, fallback) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '无限制'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(2)} MB`
}

function warn(message) {
  if (process.env.GITHUB_ACTIONS) console.warn(`::warning::${message}`)
  else console.warn(`警告：${message}`)
}

function fail(message) {
  if (process.env.GITHUB_ACTIONS) console.error(`::error::${message}`)
  else console.error(`错误：${message}`)
  process.exit(1)
}
