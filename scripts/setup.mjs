#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = resolve(rootDir, 'worker')
const bookConfigPath = resolve(rootDir, 'book.config.ts')
const wranglerConfigPath = resolve(workerDir, 'wrangler.toml')
const localEnvPath = resolve(rootDir, 'docs', '.env.development.local')
const setupDir = resolve(rootDir, '.setup')
const statePath = join(setupDir, 'state.json')
const backupDir = join(setupDir, 'backups')
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const args = new Set(process.argv.slice(2))
const rl = createInterface({ input: process.stdin, output: process.stdout })

const COMPLETION_KEYS = [
  'cloudflareAuth',
  'githubAuth',
  'githubRepository',
  'githubDiscussions',
  'githubPages',
  'discussionCategories',
  'workerConfig',
  'workerDeployment',
  'pat',
  'oauth',
  'secretsDeployment',
  'bookConfig',
  'actionsVariables',
  'verification',
]

function now() {
  return new Date().toISOString()
}

function emptyCompletion() {
  return Object.fromEntries(COMPLETION_KEYS.map((key) => [key, false]))
}

function readState() {
  if (!existsSync(statePath)) return null
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 ${statePath}：${error.message}`)
  }
}

function atomicWrite(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, content)
  try {
    renameSync(temporaryPath, filePath)
  } catch (error) {
    if (existsSync(filePath)) unlinkSync(filePath)
    renameSync(temporaryPath, filePath)
  }
}

function writeState(state) {
  state.updatedAt = now()
  atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

function createState(target, options, previous = {}) {
  return {
    version: 1,
    runId: `${Date.now()}-${process.pid}`,
    startedAt: now(),
    updatedAt: now(),
    target,
    options,
    previous,
    workerUrl: '',
    backupPath: '',
    completed: emptyCompletion(),
    lastError: null,
  }
}

function commandResult(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd || rootDir,
    encoding: 'utf8',
    stdio: options.capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    // Windows exposes npx as a .cmd shim, which must be launched through the shell.
    shell: options.shell ?? (process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')),
  })

  if (result.error) {
    if (options.allowFailure) return { status: 1, output: '' }
    throw new Error(`无法执行 ${command}：${result.error.message}`)
  }

  const output = options.capture
    ? `${result.stdout || ''}${result.stderr || ''}`
    : ''
  if (options.capture && output && options.printOutput !== false) process.stdout.write(output)

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${commandArgs.join(' ')} 执行失败（退出码 ${result.status}）。`)
  }
  return { status: result.status ?? 1, output }
}

function runWrangler(commandArgs, options = {}) {
  return commandResult(npxCommand, ['--yes', 'wrangler', ...commandArgs], {
    ...options,
    cwd: workerDir,
  })
}

async function ask(label, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  return (await rl.question(`${label}${suffix}: `)).trim() || defaultValue
}

async function confirm(label, defaultValue = true) {
  const hint = defaultValue ? 'Y/n' : 'y/N'
  const answer = (await rl.question(`${label} (${hint}) `)).trim().toLowerCase()
  if (!answer) return defaultValue
  return answer === 'y' || answer === 'yes'
}

function requireInteractive() {
  if (!process.stdin.isTTY) throw new Error('此命令需要在交互式终端中执行。')
}

function readQuotedProperty(source, property, fallback = '') {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`\\b${escaped}\\s*:\\s*'([^']*)'`))
  return match?.[1] || fallback
}

function readTomlProperty(source, property, fallback = '') {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`^${escaped}\\s*=\\s*"([^"]*)"`, 'm'))
  return match?.[1] || fallback
}

function escapeSingleQuoted(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")
}

function replaceQuotedProperty(source, property, value) {
  const pattern = new RegExp(`(\\b${property}\\s*:\\s*)'[^']*'`)
  if (!pattern.test(source)) throw new Error(`无法在 book.config.ts 中找到 ${property} 配置。`)
  return source.replace(pattern, (_, prefix) => `${prefix}'${escapeSingleQuoted(value)}'`)
}

function replaceTomlProperty(source, property, value) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^(${escaped}\\s*=\\s*)"[^"]*"`, 'm')
  if (!pattern.test(source)) throw new Error(`无法在 worker/wrangler.toml 中找到 ${property} 配置。`)
  return source.replace(pattern, (_, prefix) => `${prefix}"${String(value).replaceAll('"', '\\"')}"`)
}

function normalizeBase(value) {
  const clean = `/${String(value || '').trim().replace(/^\/+|\/+$/g, '')}/`
  return clean === '//' ? '/' : clean
}

function normalizeOrigin(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

function inferRepository() {
  const result = commandResult('git', ['config', '--get', 'remote.origin.url'], {
    capture: true,
    printOutput: false,
    allowFailure: true,
  })
  const remote = result.output.trim().split(/\r?\n/).filter(Boolean).at(-1) || ''
  const match = remote.match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/i)
  const bookConfig = readFileSync(bookConfigPath, 'utf8')
  return {
    owner: match?.[1] || readQuotedProperty(bookConfig, 'owner', ''),
    repo: match?.[2] || readQuotedProperty(bookConfig, 'repo', ''),
  }
}

function readProjectConfig() {
  const bookConfig = readFileSync(bookConfigPath, 'utf8')
  const wranglerConfig = readFileSync(wranglerConfigPath, 'utf8')
  const origins = readTomlProperty(wranglerConfig, 'ALLOWED_ORIGINS', '')
  return {
    owner: readQuotedProperty(bookConfig, 'owner'),
    repo: readQuotedProperty(bookConfig, 'repo'),
    base: normalizeBase(readQuotedProperty(bookConfig, 'base', '/')),
    workerUrl: readQuotedProperty(bookConfig, 'workerUrl'),
    workerName: readTomlProperty(wranglerConfig, 'name'),
    workerOwner: readTomlProperty(wranglerConfig, 'REPO_OWNER'),
    workerRepo: readTomlProperty(wranglerConfig, 'REPO_NAME'),
    workerBase: normalizeBase(readTomlProperty(wranglerConfig, 'DOCUMENT_PATH_PREFIX', '/')),
    pagesOrigin: normalizeOrigin(origins.split(',').find((item) => item.trim().startsWith('https://')) || ''),
  }
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? 'explorer.exe'
    : process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawnSync(command, [url], { stdio: 'ignore', shell: false })
}

function ensureCloudflareLogin(state) {
  if (state.completed.cloudflareAuth) return
  const status = runWrangler(['whoami'], { capture: true, allowFailure: true })
  if (status.status !== 0) {
    console.log('\n即将打开 Cloudflare 授权页面。授权完成后回到这里继续。')
    runWrangler(['login'])
    const verified = runWrangler(['whoami'], { capture: true, allowFailure: true })
    if (verified.status !== 0) throw new Error('Cloudflare 授权未完成。')
  }
  state.completed.cloudflareAuth = true
  writeState(state)
}

function ensureGitHubLogin(state) {
  if (state.completed.githubAuth) return
  const status = commandResult('gh', ['auth', 'status', '--hostname', 'github.com'], {
    capture: true,
    allowFailure: true,
  })
  if (status.status !== 0) {
    console.log('\n即将打开 GitHub 授权页面。授权完成后回到这里继续。')
    commandResult('gh', ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'])
    const verified = commandResult('gh', ['auth', 'status', '--hostname', 'github.com'], {
      capture: true,
      allowFailure: true,
    })
    if (verified.status !== 0) throw new Error('GitHub 授权未完成。')
  }
  state.completed.githubAuth = true
  writeState(state)
}

function githubApiJson(owner, repo, endpoint, extraArgs = []) {
  const result = commandResult('gh', [
    'api',
    endpoint || `repos/${owner}/${repo}`,
    ...extraArgs,
  ], { capture: true })
  try {
    return JSON.parse(result.output.trim())
  } catch (error) {
    throw new Error(`GitHub API 返回了无法解析的结果：${error.message}`)
  }
}

function githubGraphqlJson(query, variables = {}, jq = '.') {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [name, value] of Object.entries(variables)) {
    args.push('-F', `${name}=${value}`)
  }
  args.push('--jq', jq)
  const result = commandResult('gh', args, { capture: true })
  try {
    return JSON.parse(result.output.trim())
  } catch (error) {
    throw new Error(`GitHub GraphQL 返回了无法解析的结果：${error.message}`)
  }
}

function requiredDiscussionCategories() {
  const config = readFileSync(wranglerConfigPath, 'utf8')
  return readTomlProperty(config, 'DISCUSSION_CATEGORIES', 'Notes,Announcements,General')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
}

function readDiscussionCategories(owner, repo) {
  // GitHub 没有可用的 REST 分类列表接口，使用 Repository GraphQL 字段读取。
  const query = 'query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { discussionCategories(first: 100) { nodes { name } } } }'
  return githubGraphqlJson(query, { owner, repo }, '[.data.repository.discussionCategories.nodes[].name]')
}

async function ensureGitHubRepository(state) {
  const { owner, repo } = state.target
  const endpoint = `repos/${owner}/${repo}`
  const repository = githubApiJson(owner, repo, endpoint, [
    '--jq',
    '{has_discussions,has_pages,permissions}',
  ])
  if (!repository.permissions?.admin) {
    throw new Error(`GitHub 账号没有 ${owner}/${repo} 的 admin 权限，无法自动配置仓库设置。`)
  }
  if (!state.completed.githubRepository) saveCompletion(state, 'githubRepository')

  if (!state.completed.githubDiscussions) {
    if (!repository.has_discussions) {
      if (!await confirm('GitHub Discussions 当前关闭，是否自动启用？', true)) {
        throw new Error('Discussions 未启用，无法继续配置 Discussion 分类。')
      }
      commandResult('gh', ['api', '--method', 'PATCH', endpoint, '-F', 'has_discussions=true'])
    }
    saveCompletion(state, 'githubDiscussions')
  }

  if (!state.completed.githubPages) {
    const pagesResult = commandResult('gh', [
      'api',
      `repos/${owner}/${repo}/pages`,
      '--jq',
      '{build_type,html_url}',
    ], { capture: true, printOutput: false, allowFailure: true })
    if (pagesResult.status !== 0) {
      if (!await confirm('GitHub Pages 尚未启用，是否自动创建 Workflow 类型 Pages？', true)) {
        throw new Error('GitHub Pages 未启用，无法继续。')
      }
      commandResult('gh', ['api', '--method', 'POST', `repos/${owner}/${repo}/pages`, '-f', 'build_type=workflow'])
    } else {
      const pages = JSON.parse(pagesResult.output.trim())
      if (pages.build_type !== 'workflow') {
        if (!await confirm('GitHub Pages 当前不是 Workflow 模式，是否切换？', true)) {
          throw new Error('GitHub Pages 不是 Workflow 模式，无法继续。')
        }
        commandResult('gh', ['api', '--method', 'PUT', `repos/${owner}/${repo}/pages`, '-f', 'build_type=workflow'])
      }
    }
    saveCompletion(state, 'githubPages')
  }

  if (!state.completed.discussionCategories) {
    const required = requiredDiscussionCategories()
    let existing = readDiscussionCategories(owner, repo)
    let missing = required.filter((name) => !existing.includes(name))
    while (missing.length) {
      console.log(`\n缺少 Discussion 分类：${missing.join('、')}`)
      console.log('GitHub 当前没有公开的分类创建 API，请在打开的仓库设置页中创建它们。')
      openBrowser(`https://github.com/${owner}/${repo}/settings`)
      if (!await confirm('分类创建完成后重新检查？', true)) {
        throw new Error(`Discussion 分类尚未完整配置：${missing.join('、')}`)
      }
      existing = readDiscussionCategories(owner, repo)
      missing = required.filter((name) => !existing.includes(name))
    }
    saveCompletion(state, 'discussionCategories')
  }
}

function deployWorker() {
  const result = runWrangler(['deploy'], { capture: true })
  const match = result.output.match(/https:\/\/[^\s'"`]+\.workers\.dev(?:\/[^\s'"`]*)?/i)
  if (!match) throw new Error('部署成功但没有从 Wrangler 输出中找到 workers.dev URL。')
  return match[0].replace(/[),.;]+$/, '')
}

function updateBookConfig({ owner, repo, base, workerUrl }) {
  let source = readFileSync(bookConfigPath, 'utf8')
  source = replaceQuotedProperty(source, 'id', repo)
  source = replaceQuotedProperty(source, 'base', base)
  source = replaceQuotedProperty(source, 'owner', owner)
  source = replaceQuotedProperty(source, 'repo', repo)
  source = replaceQuotedProperty(source, 'workerUrl', workerUrl)
  atomicWrite(bookConfigPath, source)
}

function updateWorkerConfig({ owner, repo, base, pagesOrigin, workerName }) {
  let source = readFileSync(wranglerConfigPath, 'utf8')
  source = replaceTomlProperty(source, 'name', workerName)
  source = replaceTomlProperty(source, 'REPO_OWNER', owner)
  source = replaceTomlProperty(source, 'REPO_NAME', repo)
  source = replaceTomlProperty(source, 'DOCUMENT_PATH_PREFIX', base)
  source = replaceTomlProperty(source, 'ALLOWED_ORIGINS', `${pagesOrigin},http://localhost:15689,http://127.0.0.1:15689`)
  atomicWrite(wranglerConfigPath, source)
}

function updateLocalEnv({ owner, repo, workerUrl, clientId }) {
  const current = existsSync(localEnvPath) ? readFileSync(localEnvPath, 'utf8') : ''
  const values = {
    VITE_WORKER_URL: workerUrl,
    VITE_GITHUB_REPO_OWNER: owner,
    VITE_GITHUB_REPO_NAME: repo,
  }
  if (clientId) values.VITE_GITHUB_CLIENT_ID = clientId
  const lines = current.split(/\r?\n/).filter((line) => line && !Object.hasOwn(values, line.split('=', 1)[0]))
  atomicWrite(localEnvPath, `${[...lines, ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join('\n')}\n`)
}

function syncActionsVariables({ owner, repo, workerUrl, clientId }) {
  const repository = `${owner}/${repo}`
  commandResult('gh', ['variable', 'set', 'VITE_WORKER_URL', '--repo', repository, '--body', workerUrl])
  if (clientId) commandResult('gh', ['variable', 'set', 'VITE_GITHUB_CLIENT_ID', '--repo', repository, '--body', clientId])
}

function gitStatus() {
  return commandResult('git', ['status', '--short'], { capture: true, printOutput: false }).output.trim()
}

function gitFilesChanged(files) {
  return commandResult('git', ['diff', 'HEAD', '--quiet', '--', ...files], { allowFailure: true }).status !== 0
}

async function confirmDirtyWorktree() {
  const status = gitStatus()
  if (!status) return
  console.log('\n检测到未提交的 Git 修改：')
  console.log(status)
  if (!await confirm('继续并在修改前创建配置备份？', false)) {
    throw new Error('工作区存在未提交修改，已停止。')
  }
}

function createBackup(previous, target) {
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, `${Date.now()}`)
  mkdirSync(backupPath, { recursive: true })
  const files = [
    ['book.config.ts', bookConfigPath],
    ['worker.wrangler.toml', wranglerConfigPath],
  ]
  for (const [name, filePath] of files) copyFileSync(filePath, join(backupPath, name))
  const localEnvExists = existsSync(localEnvPath)
  if (localEnvExists) copyFileSync(localEnvPath, join(backupPath, 'docs.env.development.local'))
  atomicWrite(join(backupPath, 'metadata.json'), `${JSON.stringify({
    version: 1,
    createdAt: now(),
    previous,
    target,
    localEnvExists,
  }, null, 2)}\n`)
  return backupPath
}

function saveCompletion(state, key) {
  state.completed[key] = true
  state.lastError = null
  writeState(state)
}

function markSkipped(state, key) {
  state.completed[key] = true
  writeState(state)
}

function saveFailure(state, error) {
  state.lastError = error instanceof Error ? error.message : String(error)
  writeState(state)
}

function showPlan(current, target, options) {
  const changes = [
    ['book.id', current.repo, target.repo],
    ['book.base', current.base, target.base],
    ['book.github.owner', current.owner, target.owner],
    ['book.github.repo', current.repo, target.repo],
    ['worker.name', current.workerName, target.workerName],
    ['worker.REPO_OWNER', current.workerOwner, target.owner],
    ['worker.REPO_NAME', current.workerRepo, target.repo],
    ['worker.DOCUMENT_PATH_PREFIX', current.workerBase, target.base],
    ['worker.ALLOWED_ORIGINS', current.pagesOrigin, target.pagesOrigin],
  ].filter(([, before, after]) => before !== after)

  console.log('\n配置变更计划：')
  if (!changes.length) console.log('- 公开配置没有变化（Worker URL 会在部署后确认）。')
  for (const [key, before, after] of changes) console.log(`- ${key}: ${before || '(空)'} -> ${after || '(空)'}`)
  console.log(`- GITHUB_PAT: ${options.configurePat ? '配置或保留' : '跳过'}`)
  console.log(`- GitHub OAuth: ${options.configureOAuth ? '配置或保留' : '跳过'}`)
  console.log(`- GitHub Actions Variables: ${options.syncActions ? '同步' : '跳过'}`)
  console.log('- 远程 Worker 不会在 plan 模式中修改。')
}

async function collectTarget(state, reconfigure) {
  const current = readProjectConfig()
  const inferred = inferRepository()
  const defaults = reconfigure ? current : (state?.target || current)
  const owner = await ask('GitHub owner', defaults.owner || inferred.owner || 'your-account')
  const repo = await ask('GitHub repository', defaults.repo || inferred.repo || 'my-book')
  const base = normalizeBase(await ask('GitHub Pages base', defaults.base || `/${repo}/`))
  const pagesOrigin = normalizeOrigin(await ask('GitHub Pages origin', defaults.pagesOrigin || `https://${owner}.github.io`))
  const workerName = await ask('Cloudflare Worker name', defaults.workerName || `${repo}-reader-worker`)
  return { owner, repo, base, pagesOrigin, workerName }
}

async function collectOptions(state, reconfigure) {
  if (state?.options && !reconfigure) return state.options
  const previous = state?.options || {}
  return {
    configurePat: await confirm('配置或轮换 GITHUB_PAT？', previous.configurePat ?? true),
    configureOAuth: await confirm('配置或轮换 GitHub OAuth？', previous.configureOAuth ?? true),
    syncActions: await confirm('同步 GitHub Actions Variables？', previous.syncActions ?? true),
    pushChanges: await confirm('完成后提交并推送配置？', false),
  }
}

async function verifyWorker(state) {
  const workerUrl = state.workerUrl.replace(/\/+$/, '')
  const origin = state.target.pagesOrigin
  const options = {
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
    },
    signal: AbortSignal.timeout(15_000),
  }
  const preflight = await fetch(`${workerUrl}/api/discussions`, { method: 'OPTIONS', ...options })
  if (preflight.status !== 204 || preflight.headers.get('Access-Control-Allow-Origin') !== origin) {
    throw new Error(`Worker CORS 验证失败（${preflight.status}）。`)
  }
  const params = new URLSearchParams({
    path: `${state.target.base}index.html`,
    category: 'General',
  })
  const response = await fetch(`${workerUrl}/api/discussions?${params}`, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`Worker Discussion 接口验证失败（${response.status}）。`)
}

function verifyLocalConfig(state) {
  const config = readProjectConfig()
  const mismatches = [
    ['owner', config.owner, state.target.owner],
    ['repo', config.repo, state.target.repo],
    ['base', config.base, state.target.base],
    ['worker URL', config.workerUrl, state.workerUrl],
    ['Worker owner', config.workerOwner, state.target.owner],
    ['Worker repo', config.workerRepo, state.target.repo],
    ['Worker base', config.workerBase, state.target.base],
  ].filter(([, actual, expected]) => actual !== expected)
  if (mismatches.length) throw new Error(`本地配置不一致：${mismatches.map(([key]) => key).join(', ')}`)
}

async function applySetup(state, options) {
  ensureCloudflareLogin(state)
  ensureGitHubLogin(state)
  await ensureGitHubRepository(state)

  if (!state.completed.workerConfig) {
    updateWorkerConfig(state.target)
    saveCompletion(state, 'workerConfig')
  }

  if (!state.completed.workerDeployment) {
    state.workerUrl = deployWorker()
    saveCompletion(state, 'workerDeployment')
    console.log(`Worker URL: ${state.workerUrl}`)
  }

  if (options.configurePat && !state.completed.pat) {
    console.log('请在 Wrangler 提示中粘贴 GITHUB_PAT；输入内容不会写入项目文件。')
    runWrangler(['secret', 'put', 'GITHUB_PAT'])
    saveCompletion(state, 'pat')
  } else if (!options.configurePat) markSkipped(state, 'pat')

  if (options.configureOAuth && !state.completed.oauth) {
    const callbackUrl = `${state.target.pagesOrigin}${state.target.base}`
    console.log(`\n请在 GitHub OAuth App 中设置 callback URL：${callbackUrl}`)
    openBrowser('https://github.com/settings/developers')
    const clientId = await ask('OAuth App Client ID')
    if (!clientId) throw new Error('OAuth Client ID 不能为空。')
    state.options.clientId = clientId
    console.log('请在 Wrangler 提示中输入 OAuth Client ID。')
    runWrangler(['secret', 'put', 'GITHUB_CLIENT_ID'])
    console.log('请在 Wrangler 提示中粘贴 OAuth Client Secret。')
    runWrangler(['secret', 'put', 'GITHUB_CLIENT_SECRET'])
    saveCompletion(state, 'oauth')
  } else if (!options.configureOAuth) markSkipped(state, 'oauth')

  if ((options.configurePat || options.configureOAuth) && !state.completed.secretsDeployment) {
    runWrangler(['deploy'])
    saveCompletion(state, 'secretsDeployment')
  } else if (!options.configurePat && !options.configureOAuth) markSkipped(state, 'secretsDeployment')

  if (!state.completed.bookConfig) {
    updateBookConfig({ ...state.target, workerUrl: state.workerUrl })
    updateLocalEnv({
      owner: state.target.owner,
      repo: state.target.repo,
      workerUrl: state.workerUrl,
      clientId: state.options.clientId || '',
    })
    saveCompletion(state, 'bookConfig')
  }

  if (options.syncActions && !state.completed.actionsVariables) {
    syncActionsVariables({
      owner: state.target.owner,
      repo: state.target.repo,
      workerUrl: state.workerUrl,
      clientId: state.options.clientId || '',
    })
    saveCompletion(state, 'actionsVariables')
  } else if (!options.syncActions) markSkipped(state, 'actionsVariables')

  if (!state.completed.verification) {
    verifyLocalConfig(state)
    await verifyWorker(state)
    commandResult('npm', ['run', 'build'])
    saveCompletion(state, 'verification')
  }
}

function latestBackup() {
  if (!existsSync(backupDir)) return null
  const names = readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return names.length ? join(backupDir, names.at(-1)) : null
}

function restoreFile(sourcePath, targetPath, existed = true) {
  if (existed && existsSync(sourcePath)) atomicWrite(targetPath, readFileSync(sourcePath, 'utf8'))
  else if (!existed && existsSync(targetPath)) unlinkSync(targetPath)
}

async function rollback() {
  requireInteractive()
  const backupPath = latestBackup()
  if (!backupPath) throw new Error('没有可用的配置备份。')
  const metadata = JSON.parse(readFileSync(join(backupPath, 'metadata.json'), 'utf8'))
  const previous = metadata.previous
  console.log(`\n将恢复备份：${backupPath}`)
  console.log(`目标：${previous.owner}/${previous.repo}${previous.base}`)
  if (!await confirm('恢复本地配置并重新部署旧 Worker 配置？', false)) return

  restoreFile(join(backupPath, 'book.config.ts'), bookConfigPath)
  restoreFile(join(backupPath, 'worker.wrangler.toml'), wranglerConfigPath)
  restoreFile(join(backupPath, 'docs.env.development.local'), localEnvPath, metadata.localEnvExists)

  const state = createState(previous, metadata.options || {}, previous)
  state.workerUrl = previous.workerUrl || ''
  state.backupPath = backupPath
  writeState(state)
  ensureCloudflareLogin(state)
  updateWorkerConfig(previous)
  saveCompletion(state, 'workerConfig')
  state.workerUrl = deployWorker()
  saveCompletion(state, 'workerDeployment')
  if (state.workerUrl && !state.workerUrl.includes('.invalid')) await verifyWorker(state)
  if (metadata.options?.syncActions && previous.workerUrl) {
    ensureGitHubLogin(state)
    syncActionsVariables({
      owner: previous.owner,
      repo: previous.repo,
      workerUrl: previous.workerUrl,
      clientId: '',
    })
    saveCompletion(state, 'actionsVariables')
  }
  console.log('本地配置和公开部署配置已恢复。Secret 不会自动回滚，请根据需要重新设置或撤销。')
}

async function doctor() {
  const issues = []
  const config = readProjectConfig()
  const state = readState()
  console.log('电子书部署诊断\n')
  console.log(`本地仓库：${config.owner}/${config.repo}`)
  console.log(`Pages base：${config.base}`)
  console.log(`Worker：${config.workerName || '(未配置)'}`)
  console.log(`Worker URL：${config.workerUrl || '(未配置)'}`)
  console.log(`状态文件：${state ? `${state.completed.verification ? '已完成' : '未完成'} (${statePath})` : '不存在'}`)

  if (config.base !== config.workerBase) issues.push('book.config.ts 与 wrangler.toml 的 base 不一致')
  if (!config.workerUrl || config.workerUrl.includes('.invalid')) issues.push('Worker URL 尚未配置')
  const cloudflare = runWrangler(['whoami'], { capture: true, allowFailure: true })
  if (cloudflare.status !== 0) issues.push('Cloudflare CLI 未登录')
  const github = commandResult('gh', ['auth', 'status', '--hostname', 'github.com'], { capture: true, allowFailure: true })
  if (github.status !== 0) issues.push('GitHub CLI 未登录')

  if (config.workerUrl && !config.workerUrl.includes('.invalid')) {
    try {
      const origin = config.pagesOrigin || `https://${config.owner}.github.io`
      const response = await fetch(`${config.workerUrl.replace(/\/+$/, '')}/api/discussions`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status !== 204) issues.push(`Worker CORS 预检返回 ${response.status}`)
      else console.log('Worker CORS：正常')
    } catch (error) {
      issues.push(`Worker 不可访问：${error.message}`)
    }
  }

  if (github.status === 0) {
    try {
      const repository = githubApiJson(config.owner, config.repo, `repos/${config.owner}/${config.repo}`, [
        '--jq',
        '{has_discussions,has_pages,permissions}',
      ])
      if (!repository.permissions?.admin) issues.push('当前 GitHub 账号没有仓库 admin 权限')
      if (!repository.has_discussions) {
        issues.push('GitHub Discussions 尚未启用')
      } else {
        const categories = readDiscussionCategories(config.owner, config.repo)
        const missing = requiredDiscussionCategories().filter((name) => !categories.includes(name))
        if (missing.length) issues.push(`缺少 Discussion 分类：${missing.join('、')}`)
      }
      const pages = commandResult('gh', [
        'api',
        `repos/${config.owner}/${config.repo}/pages`,
        '--jq',
        '{build_type,html_url}',
      ], { capture: true, printOutput: false, allowFailure: true })
      if (pages.status !== 0) issues.push('GitHub Pages 尚未启用')
      else if (JSON.parse(pages.output.trim()).build_type !== 'workflow') issues.push('GitHub Pages 不是 Workflow 模式')
    } catch (error) {
      issues.push(`GitHub 仓库设置检查失败：${error.message}`)
    }

    const variables = commandResult('gh', ['variable', 'list', '--repo', `${config.owner}/${config.repo}`], {
      capture: true,
      allowFailure: true,
    })
    if (variables.status !== 0) issues.push('无法读取 GitHub Actions Variables')
    else if (!variables.output.includes('VITE_WORKER_URL')) issues.push('缺少 GitHub Actions Variable: VITE_WORKER_URL')
  }
  if (issues.length) {
    console.log('\n发现问题：')
    for (const issue of issues) console.log(`- ${issue}`)
    process.exitCode = 1
  } else {
    console.log('\n未发现明显问题。')
  }
}

async function cleanup() {
  requireInteractive()
  const state = readState()
  if (!state?.target) throw new Error('没有状态文件，无法确定清理目标。')
  console.log(`\n清理目标：${state.target.owner}/${state.target.repo}`)
  console.log(`Worker：${state.target.workerName}`)
  if (!await confirm('确认删除 Cloudflare Worker？此操作不可由脚本自动恢复。', false)) return
  ensureCloudflareLogin(state)
  runWrangler(['delete'])

  if (await confirm('同时删除 GitHub Actions Variables？', false)) {
    ensureGitHubLogin(state)
    const repository = `${state.target.owner}/${state.target.repo}`
    commandResult('gh', ['variable', 'delete', 'VITE_WORKER_URL', '--repo', repository, '--confirm'], { allowFailure: true })
    commandResult('gh', ['variable', 'delete', 'VITE_GITHUB_CLIENT_ID', '--repo', repository, '--confirm'], { allowFailure: true })
  }
  console.log('Cloudflare Worker 和所选 Actions Variables 已处理。PAT/OAuth 凭证仍需在各自平台手动撤销。')
}

async function setup() {
  requireInteractive()
  if (!existsSync(bookConfigPath) || !existsSync(wranglerConfigPath)) throw new Error('当前目录不是电子书模板根目录。')
  const reconfigure = args.has('--reconfigure')
  let state = readState()
  if (state?.completed?.verification && !reconfigure) {
    console.log('当前配置已经完成。需要修改配置时执行 npm run setup -- --reconfigure。')
    return
  }

  const target = await collectTarget(state, reconfigure)
  const options = await collectOptions(state, reconfigure)
  if (state && !reconfigure && JSON.stringify(state.target) !== JSON.stringify(target)) {
    console.log('\n检测到目标配置发生变化，将创建新的备份并重新协调远端。')
    if (!await confirm('继续？', true)) return
    state = null
  }

  if (!state || reconfigure) {
    await confirmDirtyWorktree()
    const previous = readProjectConfig()
    state = createState(target, options, previous)
    state.backupPath = createBackup(previous, target)
    writeState(state)
  } else {
    state.target = target
    state.options = { ...state.options, ...options }
    writeState(state)
  }

  try {
    await applySetup(state, state.options)
    console.log('\n配置、远端同步和验证全部完成。')
    if (state.options.pushChanges && gitFilesChanged(['book.config.ts', 'worker/wrangler.toml'])) {
      commandResult('git', ['add', '--', 'book.config.ts', 'worker/wrangler.toml'])
      commandResult('git', ['commit', '-m', 'configure ebook deployment'])
      const branch = commandResult('git', ['branch', '--show-current'], { capture: true, printOutput: false }).output.trim()
      commandResult('git', ['push', 'origin', branch || 'main'])
      console.log('配置已提交并推送。')
    } else if (state.options.pushChanges) {
      console.log('配置没有新的 Git 变更，跳过提交。')
    }
  } catch (error) {
    saveFailure(state, error)
    console.error(`\n配置在中途停止：${error.message}`)
    console.error('状态已保存。修复原因后重新执行 npm run setup 即可继续。')
    process.exitCode = 1
  }
}

async function plan() {
  requireInteractive()
  const state = readState()
  const target = await collectTarget(state, args.has('--reconfigure'))
  const options = await collectOptions(state, args.has('--reconfigure'))
  showPlan(readProjectConfig(), target, options)
}

function showHelp() {
  console.log(`用法：
  npm run setup                         首次配置或继续未完成配置
  npm run setup -- --plan               只查看变更计划，不修改远端或本地文件
  npm run setup -- --reconfigure        重新输入并覆盖配置，可用于纠错或轮换 Secret
  npm run setup:doctor                  检查本地配置、登录状态和 Worker CORS
  npm run setup:rollback                恢复最近一次本地配置备份并可重新部署
  npm run setup:cleanup                 显式删除当前状态对应的 Worker 和变量
`)
}

async function main() {
  if (args.has('--help') || args.has('-h')) return showHelp()
  if (args.has('--doctor')) return doctor()
  if (args.has('--rollback')) return rollback()
  if (args.has('--cleanup')) return cleanup()
  if (args.has('--plan')) return plan()
  return setup()
}

try {
  await main()
} catch (error) {
  console.error(`\n配置工具失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  rl.close()
}
