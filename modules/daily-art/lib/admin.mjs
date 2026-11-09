import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isOwner } from './permissions.mjs'
import { probeKonachan } from './konachan.mjs'
import { validateKonachanProxy } from './transport.mjs'

const keys = ['konachanApiKey', 'konachanProxyUrl']
const id = 'daily-art'
const maxBody = 4096

export function openVault(api) {
  const file = api.dataDir('credentials.json')
  let values
  try { values = JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('每日推图凭据文件无法读取')
    values = {}
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('每日推图凭据文件格式错误')
  function save(patch) {
    const next = { ...values, ...patch }
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
    writeFileSync(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    renameSync(temp, file)
    values = next
  }
  function migrate(cfg) {
    const current = cfg.ext?.[id] || {}
    if (!keys.some(key => Object.hasOwn(current, key))) return cfg
    const patch = Object.fromEntries(keys.filter(key => !Object.hasOwn(values, key) && typeof current[key] === 'string' && current[key]).map(key => [key, current[key]]))
    if (Object.keys(patch).length) save(patch)
    const clean = { ...current }
    for (const key of keys) { delete clean[key]; delete clean[`${key}Set`] }
    return { ...cfg, ext: { ...cfg.ext, [id]: clean } }
  }
  return { save, migrate, settings: () => ({ ...api.settings(), ...Object.fromEntries(keys.map(key => [key, values[key] ?? ''])) }),
    status: () => Object.fromEntries(keys.map(key => [`${key}Set`, Boolean(values[key])])) }
}

function sameOrigin(req) {
  const { origin, host } = req.headers || {}
  const site = req.headers?.['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  try { return !origin || new URL(origin).host === host } catch { return false }
}

async function readBody(req) {
  if (Number(req.headers?.['content-length']) > maxBody) throw new Error('请求体过大')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > maxBody) throw new Error('请求体过大')
    chunks.push(bytes)
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求体格式错误')
  return input
}

export function registerAdmin(api, vault, { probe = probeKonachan } = {}) {
  const shutdown = new AbortController()
  let pair, session, busy = false, lastPair = -Infinity
  let owner = String(api.config().ownerQQ)
  const failure = message => ({ ok: false, message })
  const valid = (entry, token) => !shutdown.signal.aborted && entry && typeof token === 'string' &&
    entry.token === token && entry.expires > Date.now() && entry.owner === String(api.config().ownerQQ)
  api.onDispose(() => { shutdown.abort(); pair = session = undefined })
  api.on('config', () => {
    const next = String(api.config().ownerQQ)
    if (owner === next) return
    owner = next
    pair = session = undefined
    lastPair = -Infinity
  })
  api.on('message', async msg => {
    if (msg.text?.trim() !== '每日推图配对' || msg.kind !== 'private' || !isOwner(api.config(), msg)) return false
    if (api.config().dryRun || Date.now() - lastPair < 5000) return true
    lastPair = Date.now()
    const issued = { token: randomBytes(24).toString('hex'), expires: Date.now() + 120_000, owner: String(msg.userId) }
    pair = issued
    try {
      const receipt = await api.sendSegments(msg.chatId, [{ type: 'text', data: { text: `每日推图配对码（2 分钟内有效）：${issued.token}` } }], '每日推图主人配对')
      if (receipt?.message_id == null && pair === issued) pair = undefined
    } catch { if (pair === issued) pair = undefined }
    return true
  })

  const route = (path, run) => api.route(path, async req => {
    if (shutdown.signal.aborted || req.method !== 'POST' || !sameOrigin(req) || !/^application\/json\b/i.test(req.headers?.['content-type'] || '')) return failure('请求不允许')
    let input
    try { input = await readBody(req) } catch { return failure('请提交不超过 4 KiB 的 JSON 对象') }
    return run(input)
  })
  route('/pair', input => {
    if (!valid(pair, input.code)) return failure('配对码无效或已过期')
    session = { token: randomBytes(32).toString('hex'), expires: Date.now() + 900_000, owner: pair.owner }
    pair = undefined
    return { ok: true, token: session.token }
  })
  route('/credentials', input => {
    if (!valid(session, input.token)) return failure('请先进行主人配对')
    const patch = {}
    for (const key of keys) {
      const value = input[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || value.length > 1024) return failure('凭据格式无效')
      patch[key] = value.trim()
    }
    if (Object.hasOwn(patch, 'konachanProxyUrl')) {
      try { validateKonachanProxy(patch.konachanProxyUrl) } catch (error) { return failure(error.message) }
    }
    try { vault.save(patch) } catch { return failure('无法保存凭据') }
    return { ok: true, ...vault.status() }
  })
  route('/connection-test', async input => {
    if (!valid(session, input.token)) return failure('请先进行主人配对')
    if (!['konachan', 'yandere'].includes(input.source)) return failure('未知图源')
    if (busy) return failure('正在检测，请稍后再试')
    const { konachanProxyUrl: proxyUrl, konachanApiKey: apiKey, konachanUsername: username } = vault.settings()
    try { validateKonachanProxy(proxyUrl) } catch (error) { return failure(error.message) }
    busy = true
    try {
      const results = await probe(input.source === 'konachan' ? { apiKey, username } : {}, {
        source: input.source, proxyUrl, signal: shutdown.signal, checkImage: true, log: api.log, operation: 'connection-test', trace: true,
      })
      return valid(session, input.token) ? { ok: true, proxyConfigured: Boolean(proxyUrl), results } : failure('管理会话已过期')
    } catch { return failure('连接检测失败') }
    finally { busy = false }
  })
}
