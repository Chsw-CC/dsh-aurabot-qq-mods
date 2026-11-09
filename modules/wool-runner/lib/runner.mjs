import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { cronMatches, extractCron, parseCron } from './cron.mjs'

const MAX_LOG = 1024 * 1024
const taskId = (subscriptionId, file) => createHash('sha1').update(`${subscriptionId}:${file}`).digest('hex').slice(0, 16)
const safeRegex = (source) => { try { return source ? new RegExp(source, 'i') : null } catch { return null } }
const slash = (s) => s.split(sep).join('/')

function execute(command, args, { cwd, timeout = 120_000, env } = {}) {
  return new Promise((resolvePromise) => {
    let output = ''
    let child
    try { child = spawn(command, args, { cwd, env: env || process.env, shell: false, windowsHide: true }) }
    catch (error) { return resolvePromise({ code: -1, output: error.message }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} }, timeout)
    child.stdout?.on('data', (b) => { if (output.length < MAX_LOG) output += String(b) })
    child.stderr?.on('data', (b) => { if (output.length < MAX_LOG) output += String(b) })
    child.on('error', (error) => { clearTimeout(timer); resolvePromise({ code: -1, output: output + error.message }) })
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, output }) })
  })
}

function walk(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (['.git', 'node_modules', '.aurabot-cache'].includes(entry.name)) continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else if (entry.isFile()) out.push(slash(relative(root, full)))
  }
  return out
}

function redact(text, secrets = []) {
  let out = String(text || '')
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[已隐藏]')
  return out.replace(/(pt_key|token|cookie|authorization|password|secret|access_token)[^\s;&]{0,24}[=:][^\s;&]{1,}/gi, '$1=[已隐藏]')
}

export function createRunner({ store, log, settings }) {
  const runtime = new Map()
  const syncing = new Map()
  const repoDir = (id) => join(store.root, 'repos', id)
  const inside = (root, target) => target === root || target.startsWith(root + sep)
  const subscription = (id) => {
    const item = store.state().subscriptions.find((s) => s.id === id)
    if (!item) throw new Error('订阅不存在')
    return item
  }
  const task = (id) => {
    const item = store.state().tasks.find((t) => t.id === id)
    if (!item) throw new Error('任务不存在')
    return item
  }
  const scriptPath = (item) => {
    const root = resolve(repoDir(item.subscriptionId))
    const file = resolve(root, item.file)
    if (!inside(root, file)) throw new Error('脚本路径越界')
    return file
  }

  async function sync(id) {
    if (syncing.has(id)) return syncing.get(id)
    const job = (async () => {
      const item = subscription(id)
      const dir = repoDir(id)
      mkdirSync(dirname(dir), { recursive: true })
      let result
      const signature = `${item.url}#${item.branch}`
      const signatureFile = join(store.root, 'repos', `${id}.source`)
      let previous = ''
      try { previous = readFileSync(signatureFile, 'utf8') } catch {}
      if (existsSync(join(dir, '.git')) && previous === signature) {
        result = await execute('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 180_000 })
      } else {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
        result = await execute('git', ['clone', '--depth', '1', '--branch', item.branch, '--', item.url, dir], { timeout: 240_000 })
      }
      if (result.code !== 0) {
        store.updateSubscription(id, { lastSyncAt: new Date().toISOString(), lastSyncStatus: 'error', lastSyncMessage: result.output.slice(-1500) })
        throw new Error('拉取失败：' + result.output.slice(-600))
      }
      const { writeFileSync } = await import('node:fs')
      writeFileSync(signatureFile, signature, 'utf8')
      const commit = await execute('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])
      const discovered = discover(id)
      let added = 0
      if (item.autoAddCron) {
        for (const script of discovered.filter((x) => x.cron)) {
          const tid = taskId(id, script.file)
          if (!store.state().tasks.some((t) => t.id === tid)) {
            store.upsertTask({ id: tid, subscriptionId: id, file: script.file, name: script.file, cron: script.cron, enabled: false })
            added++
          }
        }
      }
      if (item.autoDelCron) {
        const existing = new Set(discovered.map((x) => x.file))
        for (const t of [...store.state().tasks]) if (t.subscriptionId === id && !existing.has(t.file)) store.removeTask(t.id)
      }
      store.updateSubscription(id, {
        lastSyncAt: new Date().toISOString(), lastSyncStatus: 'ok', lastSyncMessage: `发现 ${discovered.length} 个脚本，新增 ${added} 个任务（默认停用）`,
        commit: commit.code === 0 ? commit.output.trim() : '',
      })
      return { ok: true, message: `同步完成：${discovered.length} 个脚本，新增 ${added} 个任务`, scripts: discovered.length, added }
    })().finally(() => syncing.delete(id))
    syncing.set(id, job)
    return job
  }

  function discover(id) {
    const item = subscription(id)
    const dir = repoDir(id)
    if (!existsSync(dir)) return []
    const white = safeRegex(item.whitelist)
    const black = safeRegex(item.blacklist)
    const extensions = new Set(String(item.extensions || 'js py sh').split(/\s+/).map((x) => x.replace(/^\./, '').toLowerCase()))
    return walk(dir).filter((file) => {
      const ext = file.split('.').pop().toLowerCase()
      return extensions.has(ext) && (!white || white.test(file)) && (!black || !black.test(file))
    }).map((file) => {
      let cron = ''
      try { cron = extractCron(readFileSync(join(dir, file), 'utf8')) } catch {}
      return { id: taskId(id, file), file, name: file.split('/').pop(), cron, subscribed: store.state().tasks.some((t) => t.id === taskId(id, file)) }
    }).sort((a, b) => a.file.localeCompare(b.file, 'zh-CN'))
  }

  async function run(id, trigger = 'manual') {
    if (runtime.get(id)?.status === 'running') throw new Error('这个任务正在运行')
    const item = task(id)
    const sub = subscription(item.subscriptionId)
    const file = scriptPath(item)
    if (!existsSync(file)) throw new Error('脚本文件不存在，请先同步订阅')
    const ext = file.split('.').pop().toLowerCase()
    const cfg = settings()
    let command = process.execPath
    let args = [file]
    const env = { ...process.env, ...store.envValues(), ELECTRON_RUN_AS_NODE: '1', QL_DIR: repoDir(sub.id), QL_SCRIPTS_DIR: repoDir(sub.id) }
    if (ext === 'py') { command = cfg.pythonPath || 'python'; args = [file] }
    else if (ext === 'sh') { command = cfg.bashPath || 'bash'; args = [file] }
    else if (!['js', 'mjs', 'cjs'].includes(ext)) throw new Error('不支持这个脚本类型')
    if (cfg.nodePath && ['js', 'mjs', 'cjs'].includes(ext)) command = cfg.nodePath
    const runId = randomUUID()
    const at = new Date()
    const logDir = join(store.root, 'logs', id)
    mkdirSync(logDir, { recursive: true })
    const logPath = join(logDir, `${at.toISOString().replace(/[:.]/g, '-')}.log`)
    const runRecord = { id: runId, taskId: id, taskName: item.name, trigger, startedAt: at.toISOString(), status: 'running', logPath }
    store.addRun(runRecord)
    store.upsertTask({ ...item, lastRunAt: at.toISOString(), lastStatus: 'running' })
    const child = spawn(command, args, { cwd: dirname(file), env, shell: false, windowsHide: true })
    const current = { status: 'running', pid: child.pid, child, runId, logPath }
    runtime.set(id, current)
    const stream = createWriteStream(logPath, { encoding: 'utf8', mode: 0o600 })
    stream.write(`## 开始执行 ${at.toLocaleString()}\n## ${item.name}\n\n`)
    let size = 0
    const write = (chunk) => {
      const text = redact(String(chunk), store.envSecrets())
      if (size < MAX_LOG) { stream.write(text); size += text.length }
    }
    child.stdout?.on('data', write); child.stderr?.on('data', write)
    const timeout = setTimeout(() => stop(id, '任务超时'), Math.max(60_000, Number(cfg.timeoutMinutes || 30) * 60_000))
    child.on('error', (error) => write(`\n启动失败：${error.message}\n`))
    child.on('close', (code, signal) => {
      clearTimeout(timeout)
      const status = current.status === 'stopping' ? 'stopped' : code === 0 ? 'success' : 'error'
      stream.end(`\n## 执行结束 ${new Date().toLocaleString()}，退出码 ${code ?? ''} ${signal || ''}\n`)
      runtime.delete(id)
      store.updateRun(runId, { status, code, signal: signal || '', finishedAt: new Date().toISOString() })
      const latest = store.state().tasks.find((t) => t.id === id)
      if (latest) store.upsertTask({ ...latest, lastStatus: status, lastExitCode: code, lastFinishedAt: new Date().toISOString() })
      log?.[status === 'success' ? 'info' : 'warn'](`薅羊毛任务「${item.name}」：${status}`)
    })
    return { ok: true, message: '任务已开始', runId, pid: child.pid }
  }

  async function stop(id, reason = '手动停止') {
    const current = runtime.get(id)
    if (!current) return { ok: true, message: '任务没有在运行' }
    current.status = 'stopping'
    try {
      if (process.platform === 'win32') await execute('taskkill', ['/pid', String(current.pid), '/T', '/F'], { timeout: 10_000 })
      else current.child.kill('SIGTERM')
    } catch {}
    store.updateRun(current.runId, { stopReason: reason })
    return { ok: true, message: '已发送停止指令' }
  }

  function tick(now = new Date()) {
    for (const item of store.state().tasks) {
      if (!item.enabled || runtime.has(item.id)) continue
      try {
        const key = `${Math.floor(now.getTime() / 1000)}`
        if (item.lastScheduleKey === key) continue
        const cron = parseCron(item.cron)
        if (cronMatches(cron, now)) {
          store.upsertTask({ ...item, lastScheduleKey: key })
          run(item.id, 'schedule').catch((error) => log?.warn(`定时任务 ${item.name}：${error.message}`))
        }
      } catch (error) { log?.warn(`任务「${item.name}」cron 无效：${error.message}`) }
    }
  }

  async function readLog(runId) {
    const item = store.runs().find((r) => r.id === runId)
    if (!item) throw new Error('运行记录不存在')
    let content = ''
    try { content = readFileSync(item.logPath, 'utf8') } catch { content = '日志文件不存在或已清理' }
    return { ...item, content: redact(content.slice(-MAX_LOG), store.envSecrets()) }
  }

  function dispose() { for (const id of [...runtime.keys()]) stop(id, '模块停止') }
  return { runtime, sync, discover, run, stop, tick, readLog, dispose, repoDir }
}
