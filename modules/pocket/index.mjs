// 口袋（pocket）：把她原有的对话流开放给自己的手机 app。
//
// app 消息 → 模拟主人私聊 → 她的原生对话流（记忆、心情、表情包、语音、模组全在）
// → 她的回复经 activity 事件捕获 → HTTP 推回 app。
// 记忆与 QQ 端共用同一套（同一条 chatlog 流水、同一份长期记忆）。
//
// 为什么自带一个 HTTP 服务：DSH 面板那个端口要登录态，手机连不上。
// 所以模组自己开一个局域网端口（默认 7788），同时托管 app 的界面和接口。
// 安全边界：接口全要配对密钥；消息只能注入主人私聊，不能发给别人、不能操作群。

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname, normalize, sep } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:http'

const RING_MAX = 500
const DEFAULT_PORT = 7788

// 测试钩子
export const hooks = {}

// ---------- 手机宠物数值（app 端独立一份，不影响她的心情） ----------

const FOODS = {
  rice: { name: '白米饭', satiety: 22, mood: 7, intimacy: 2, line: '白米饭！冒尖的那种！' },
  fish: { name: '小鱼干', satiety: 14, mood: 4, intimacy: 1, line: '小鱼干也不错啦 勉强吃' },
  hotpot: { name: '火锅', satiety: 26, mood: 6, intimacy: 2, line: '火锅！辣的那种！' },
  milktea: { name: '奶茶', satiety: 9, mood: 5, intimacy: 1, line: '奶茶到了没 我要少冰' },
  cake: { name: '小蛋糕', satiety: 11, mood: 6, intimacy: 1, line: '甜的 我今天就想吃甜的' },
  ice: { name: '冰淇淋', satiety: 8, mood: 4, intimacy: 1, line: '大晚上吃这个 明天嗓子疼也认了' },
}

const PET_DEFAULT = { satiety: 62, mood: 78, intimacy: 8, fedTimes: 0, lastTick: 0, lastFeedAt: 0, lastPetAt: 0 }

// 基础色调：图标人物和界面一起换（app 端有同名配色，这里只存 key）
const TONES = ['ocean', 'sakura', 'mint', 'grape', 'sunset', 'moon', 'abyss', 'rose']

function readPet(dir) {
  try {
    const p = join(dir, 'pet.json')
    if (!existsSync(p)) return { ...PET_DEFAULT }
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return { ...PET_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) }
  } catch {
    return { ...PET_DEFAULT }
  }
}

function writePet(dir, pet) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pet.json'), JSON.stringify(pet, null, 2), 'utf8')
  } catch {}
}

/** 时间流逝：每小时掉饱食度，饿久了心情跟着掉。 */
function tickPet(dir, now = Date.now()) {
  const p = readPet(dir)
  const hours = Math.max(0, (now - (p.lastTick || now)) / 3_600_000)
  if (hours >= 0.05) {
    const satiety = Math.max(0, Math.min(100, p.satiety - hours * 3.2))
    const moodDrop = satiety < 20 ? hours * 2.2 : hours * 0.25
    const idleDays = Math.max(0, (now - (p.lastFeedAt || now)) / 86_400_000)
    p.satiety = Math.round(satiety * 10) / 10
    p.mood = Math.round(Math.max(0, Math.min(100, p.mood - moodDrop)))
    p.intimacy = Math.round(Math.max(0, p.intimacy - Math.max(0, idleDays - 2) * 0.4) * 10) / 10
    p.lastTick = now
    writePet(dir, p)
  }
  return p
}

function petState(dir) {
  const p = tickPet(dir)
  const d = new Date()
  return {
    satiety: Math.round(p.satiety),
    mood: Math.round(p.mood),
    intimacy: Math.round(p.intimacy),
    fedTimes: p.fedTimes || 0,
    hungry: p.satiety < 30,
    sleepy: d.getHours() >= 23 || d.getHours() < 6,
    foods: Object.entries(FOODS).map(([id, f]) => ({ id, name: f.name })),
  }
}

function petInteract(dir, action, foodId) {
  const p = tickPet(dir)
  const now = Date.now()
  if (action === 'feed') {
    if (p.satiety >= 96) return { ok: false, refused: true, reply: '吃不下了 真的 再喂要撑死了' }
    if (now - (p.lastFeedAt || 0) < 20_000) return { ok: false, refused: true, reply: '刚吃过 你养小猪呢' }
    const food = FOODS[foodId] || FOODS.rice
    p.satiety = Math.min(100, p.satiety + food.satiety)
    p.mood = Math.min(100, p.mood + food.mood)
    p.intimacy = Math.min(100, (p.intimacy || 0) + food.intimacy)
    p.fedTimes = (p.fedTimes || 0) + 1
    p.lastFeedAt = now
    p.lastTick = now
    writePet(dir, p)
    return { ok: true, reply: food.line, event: `主人喂了我${food.name}` }
  }
  if (action === 'pet') {
    if (now - (p.lastPetAt || 0) < 8_000) return { ok: false, refused: true, reply: '摸够了没啊' }
    p.mood = Math.min(100, p.mood + 3)
    p.intimacy = Math.min(100, (p.intimacy || 0) + 0.4)
    p.lastPetAt = now
    p.lastTick = now
    writePet(dir, p)
    return { ok: true, reply: p.mood > 70 ? '嗯…再摸一下' : '别摸头 头发乱了', event: '主人摸了摸我的头' }
  }
  if (action === 'play') {
    p.mood = Math.min(100, p.mood + 5)
    p.satiety = Math.max(0, p.satiety - 4)
    p.intimacy = Math.min(100, (p.intimacy || 0) + 0.8)
    p.lastTick = now
    writePet(dir, p)
    return { ok: true, reply: '玩一会儿嘛 我尾巴都甩起来了', event: '主人陪我玩了一会儿' }
  }
  return { ok: false, reply: '？' }
}

// ---------- 私网地址收集（配对用） ----------

function lanAddresses() {
  const out = []
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family !== 'IPv4' || ni.internal) continue
        if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) out.push(ni.address)
      }
    }
  } catch {}
  return [...new Set(out)]
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// ---------- 主逻辑 ----------

export default {
  id: 'pocket',
  name: '口袋',
  version: '1.1.0',
  api: 1,
  description: '把她的对话流接进手机 app：app 消息走她原生流程（记忆、心情、表情包、语音、模组全在），回复与主动搭话实时推回手机；记忆与 QQ 端共用一套。',
  category: 'platform',
  tags: ['手机', '同步', '接口'],
  author: 'Ariz0324',
  license: 'MIT',
  minPluginVersion: '1.2.0',
  requires: [],
  capabilities: ['filesystem', 'plugin-config', 'plugin-internals', 'network'],
  defaults: { enabled: true, token: '', port: DEFAULT_PORT, tone: 'ocean' },
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用手机接口', type: 'switch', hint: '关掉后 app 连不上（QQ 端不受影响）' },
    { key: 'port', label: '服务端口', type: 'number', hint: `手机连的端口，默认 ${DEFAULT_PORT}；改了要重启插件` },
    { key: 'token', label: '配对密钥', type: 'string', hint: '留空自动生成；换掉之后所有设备要重新配对' },
    { key: 'tone', label: '图标色调', type: 'string', hint: '手机端配色：ocean/sakura/mint/grape/sunset/moon/abyss/rose' },
  ],

  setup(api) {
    const dir = api.dataDir()
    // 界面放在 assets/app（市场规范只允许 lib/test/assets/docs 四个子目录）
    const base = api.dir || dir
    const appDir = existsSync(join(base, 'assets', 'app', 'index.html')) ? join(base, 'assets', 'app') : join(base, 'app')
    const cfg = () => api.config()
    const s = () => api.settings()
    const on = () => s().enabled !== false
    const port = () => Number(s().port) || DEFAULT_PORT
    const tone = () => {
      const t = String(s().tone || '')
      return TONES.includes(t) ? t : 'ocean'
    }

    // ---- 密钥 ----
    const tokenOf = () => {
      const t = String(s().token || '').trim()
      if (t) return t
      const gen = 'pk_' + randomBytes(12).toString('base64url')
      try {
        api.saveSettings({ token: gen })
      } catch {}
      return gen
    }

    // ---- 事件环（app 轮询拿消息） ----
    let seq = 0
    const ring = []
    const pushEvent = (type, data) => {
      ring.push({ seq: ++seq, at: Date.now(), type, ...data })
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX)
      return seq
    }

    const ownerQQ = () => String(cfg().ownerQQ || '')
    const ownerChat = () => `private:${ownerQQ()}`

    // 她发出去的话（含主动搭话）→ 推给 app
    api.on('activity', (a) => {
      if (a?.kind !== 'out') return
      if (String(a.chatId || '') !== ownerChat()) return
      pushEvent('her', { text: String(a.reply || '') })
    })
    api.on('onebot/state', (st) => pushEvent('qq-state', { state: String(st || '') }))

    // ---- 注入一条主人私聊消息 ----
    function inject(text) {
      const clean = String(text || '').trim().slice(0, 4000)
      if (!clean) return { ok: false, message: '要说点什么' }
      const hub = api.core?.hub
      const ev = {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(cfg().botQQ) || 0,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        user_id: Number(ownerQQ()) || 0,
        message_id: 'pocket-' + Date.now() + '-' + randomBytes(2).toString('hex'),
        raw_message: clean,
        message: [{ type: 'text', data: { text: clean } }],
        sender: { user_id: Number(ownerQQ()) || 0, nickname: String(cfg().ownerName || '主人') },
      }
      const my = pushEvent('me', { text: clean })
      if (hub && typeof hub.onMessage === 'function') {
        Promise.resolve(hub.onMessage(ev)).catch((e) => api.log.warn('注入消息出错：', e?.message || e))
        return { ok: true, via: 'hub', seq: my }
      }
      // 兜底：hub 拿不到时直接让她想（带人格和记忆），回复走 activity 照样推给 app
      api.think(`${clean}\n（这句话来自主人的手机 app，回给他，但不要在 QQ 上发）`).catch((e) => api.log.warn('think 出错：', e?.message || e))
      return { ok: true, via: 'think', seq: my }
    }

    // ---- 聊天历史（她自己的 chatlog） ----
    function chatlogDir() {
      // modules-data/pocket → plugins-data/aurabot/chatlog
      return join(dir, '..', '..', 'chatlog')
    }
    function readHistory(days = 3, limit = 300) {
      const d = chatlogDir()
      const out = []
      try {
        const files = readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort()
        for (const f of files.slice(-Math.max(1, Math.min(15, days)))) {
          try {
            for (const line of readFileSync(join(d, f), 'utf8').split('\n')) {
              if (!line.trim()) continue
              try {
                const o = JSON.parse(line)
                if (String(o.chatId || '') !== ownerChat()) continue
                out.push({ at: o.t, who: o.who === 'bot' ? 'her' : 'me', text: String(o.text || '') })
              } catch {}
            }
          } catch {}
        }
      } catch {}
      return out.slice(-Math.max(10, Math.min(1000, limit)))
    }

    // ---- 统一的操作层：面板接口和手机服务都调这里 ----
    const ops = {
      health: () => ({
        ok: true,
        app: 'pocket',
        version: '1.1.0',
        persona: String(cfg().persona?.current || ''),
        owner: String(cfg().ownerName || '主人'),
        tone: tone(),
      }),
      state: () => {
        const m = api.use('mood')
        const raw = m?.state?.() || null
        const ms = raw && typeof raw === 'object' ? raw : null
        const mv = typeof raw === 'number' ? raw : null
        return {
          ok: true,
          persona: String(cfg().persona?.current || ''),
          owner: String(cfg().ownerName || '主人'),
          qqOnline: api.core?.onebot?.state === 'connected',
          tone: tone(),
          tones: TONES,
          // mood.state() = { value, label, at, reason, history }
          mood: mv != null ? mv : ms ? Number(ms.value ?? ms.mood ?? 0) : null,
          moodLabel: String((ms?.label) || (m?.label ? m.label() : '')),
          memoryCount: api.use('memory')?.list?.()?.length ?? null,
          pet: petState(dir),
        }
      },
      events: (after) => ({ ok: true, seq, list: ring.filter((e) => e.seq > Number(after || 0)).slice(0, 200) }),
      history: (days) => ({ ok: true, list: readHistory(days) }),
      message: (text) => inject(text),
      pet: (action, food) => {
        const r = petInteract(dir, String(action || ''), String(food || 'rice'))
        if (r.ok && r.event) {
          try {
            api.use('memory')?.addEvent?.({ text: r.event, source: 'event' })
          } catch {}
        }
        return { ...r, state: petState(dir) }
      },
      moments: async () => {
        let list = []
        try {
          const h = await api.use('diary')?.history?.()
          if (Array.isArray(h)) list = h.map((x) => ({ at: x.at, text: String(x.text || ''), visibility: x.visibility || '' }))
        } catch {}
        // 心情曲线也一起给（近 24 次变化）
        let mood = []
        try {
          const ms = api.use('mood')?.state?.()
          if (ms && Array.isArray(ms.history)) {
            mood = ms.history
              .slice(0, 24)
              .map((x) => ({ at: x.at, value: Number(x.to ?? x.value ?? x.mood) }))
              .filter((x) => Number.isFinite(x.value))
              .reverse()
          }
          if (mood.length === 0 && ms && Number.isFinite(Number(ms.value))) mood = [{ at: ms.at || Date.now(), value: Number(ms.value) }]
        } catch {}
        list.sort((a, b) => b.at - a.at)
        return { ok: true, list: list.slice(0, 50), mood }
      },
      skin: () => {
        const persona = String(cfg().persona?.current || 'default')
        const custom = join(dir, 'skins', persona + '.json')
        if (existsSync(custom)) {
          try {
            return { ok: true, skin: JSON.parse(readFileSync(custom, 'utf8')), builtin: false, tone: tone() }
          } catch {}
        }
        return { ok: true, skin: defaultSkin(persona), builtin: true, tone: tone() }
      },
      setTone: (t) => {
        const clean = String(t || '').trim()
        if (!TONES.includes(clean)) return { ok: false, message: '没有这个色调' }
        try {
          api.saveSettings({ tone: clean })
        } catch {}
        return { ok: true, tone: clean }
      },
      /** 语音：走她 voice 模组的 speak()，返回文件路径 */
      voice: async (text) => {
        const clean = String(text || '').trim().slice(0, 300)
        if (!clean) return { ok: false, message: '缺文字' }
        const voice = api.use('voice')
        if (!voice?.speak) return { ok: false, message: '语音模组没在跑' }
        try {
          const r = await voice.speak(clean)
          const file = r?.file
          if (file && existsSync(file)) return { ok: true, file }
          return { ok: false, message: '语音没生成出来' }
        } catch (e) {
          return { ok: false, message: '语音出错：' + (e?.message || e) }
        }
      },
    }

    // ---- 面板侧接口（走 DSH 面板端口，自己在面板里用） ----
    const urlOf = (req) => {
      try {
        return new URL(req.url || '/', 'http://local')
      } catch {
        return new URL('/', 'http://local')
      }
    }
    function deny(res, code, message) {
      try {
        api.core.http.send(res, code, JSON.stringify({ ok: false, message }), 'application/json')
      } catch {}
      return undefined
    }
    function guard(req, res) {
      if (!on()) {
        deny(res, 403, '手机接口关着')
        return false
      }
      const want = tokenOf()
      const given = String(req.headers?.['x-phone-token'] || urlOf(req).searchParams.get('token') || '')
      if (!want || given !== want) {
        deny(res, 401, '密钥不对')
        return false
      }
      return true
    }
    async function bodyOf(req) {
      const ct = String(req.headers?.['content-type'] || '')
      if (!/application\/json/i.test(ct)) throw new Error('content-type 必须是 application/json')
      try {
        const b = await api.core.http.body(req)
        return b && typeof b === 'object' ? b : {}
      } catch {
        return {}
      }
    }

    api.route('/net-info', () => ({ ok: true, addresses: lanAddresses(), enabled: on(), port: port(), tone: tone() }))
    api.route('/state', (req, res) => (guard(req, res) ? ops.state() : undefined))
    api.route('/events', (req, res) => (guard(req, res) ? ops.events(urlOf(req).searchParams.get('after')) : undefined))
    api.route('/history', (req, res) => (guard(req, res) ? ops.history(Number(urlOf(req).searchParams.get('days') || 3) || 3) : undefined))
    api.route('/moments', async (req, res) => (guard(req, res) ? ops.moments() : undefined))
    api.route('/skin', (req, res) => (guard(req, res) ? ops.skin() : undefined))
    api.route('/message', async (req, res) => {
      if (!guard(req, res)) return
      try {
        return ops.message((await bodyOf(req)).text)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })
    api.route('/pet', async (req, res) => {
      if (!guard(req, res)) return
      try {
        const b = await bodyOf(req)
        return ops.pet(b.action, b.food)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })
    api.route('/voice', async (req, res) => {
      if (!guard(req, res)) return
      const text = String(urlOf(req).searchParams.get('text') || '').trim()
      const r = await ops.voice(text)
      if (!r.ok) return { ok: false, message: r.message }
      api.core.http.send(res, 200, readFileSync(r.file), 'audio/wav')
      return undefined
    })
    api.route('/tone', async (req, res) => {
      if (!guard(req, res)) return
      try {
        return ops.setTone((await bodyOf(req)).tone)
      } catch (e) {
        return deny(res, 400, e.message)
      }
    })

    // ---- 手机侧自带服务 ----
    let server = null
    let listening = 0
    let listenErr = ''

    function send(res, code, body, type, extra) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''))
      res.writeHead(code, {
        'content-type': type || 'application/json; charset=utf-8',
        'content-length': buf.length,
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-pocket-token, x-phone-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        ...(extra || {}),
      })
      res.end(buf)
    }
    const json = (res, code, o) => send(res, code, JSON.stringify(o), 'application/json; charset=utf-8')

    async function readBody(req) {
      const chunks = []
      let size = 0
      for await (const c of req) {
        size += c.length
        if (size > 6 * 1024 * 1024) throw new Error('太大了')
        chunks.push(c)
      }
      if (!chunks.length) return {}
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        return JSON.parse(raw)
      } catch {
        return {}
      }
    }

    function authed(req, url) {
      const want = tokenOf()
      const given = String(req.headers['x-pocket-token'] || req.headers['x-phone-token'] || url.searchParams.get('token') || '')
      return !!want && given === want
    }

    /** 静态文件：只认 app 目录里的东西，别想跳出去 */
    function serveStatic(res, pathname) {
      const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
      const full = normalize(join(appDir, rel))
      if (!full.startsWith(normalize(appDir + sep)) && full !== normalize(appDir)) return send(res, 403, 'nope', 'text/plain')
      if (!existsSync(full) || !statSync(full).isFile()) {
        // 单页应用：找不到文件就回首页
        const idx = join(appDir, 'index.html')
        if (existsSync(idx)) return send(res, 200, readFileSync(idx), MIME['.html'])
        return send(res, 404, 'app 没装好（缺 app/index.html）', 'text/plain; charset=utf-8')
      }
      const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
      return send(res, 200, readFileSync(full), type)
    }

    async function handle(req, res) {
      let url
      try {
        url = new URL(req.url || '/', 'http://x')
      } catch {
        return json(res, 400, { ok: false, message: 'bad url' })
      }
      if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain')

      const p = url.pathname
      if (!p.startsWith('/api/')) return serveStatic(res, p)

      // 只有健康检查不用密钥（配对时先探活）
      if (p === '/api/health') {
        if (!on()) return json(res, 503, { ok: false, message: '手机接口关着' })
        return json(res, 200, { ...ops.health(), port: listening || port() })
      }
      if (!on()) return json(res, 403, { ok: false, message: '手机接口关着' })
      if (!authed(req, url)) return json(res, 401, { ok: false, message: '密钥不对' })

      const route = p.slice(5)
      try {
        if (route === 'state') return json(res, 200, ops.state())
        if (route === 'events') return json(res, 200, ops.events(url.searchParams.get('after')))
        if (route === 'history') return json(res, 200, ops.history(Number(url.searchParams.get('days') || 3) || 3))
        if (route === 'moments') return json(res, 200, await ops.moments())
        if (route === 'skin') return json(res, 200, ops.skin())
        if (route === 'tone') {
          if (req.method === 'POST') {
            const b = await readBody(req)
            return json(res, 200, ops.setTone(b.tone))
          }
          return json(res, 200, { ok: true, tone: tone(), tones: TONES })
        }
        if (route === 'message') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '要 POST' })
          const b = await readBody(req)
          return json(res, 200, ops.message(b.text))
        }
        if (route === 'pet') {
          if (req.method !== 'POST') return json(res, 405, { ok: false, message: '要 POST' })
          const b = await readBody(req)
          return json(res, 200, ops.pet(b.action, b.food))
        }
        if (route === 'voice') {
          const text = String(url.searchParams.get('text') || '').trim() || String((await readBody(req)).text || '')
          const r = await ops.voice(text)
          if (!r.ok) return json(res, 200, r)
          return send(res, 200, readFileSync(r.file), 'audio/wav', { 'cache-control': 'no-store' })
        }
        return json(res, 404, { ok: false, message: '没有这个接口：' + route })
      } catch (e) {
        return json(res, 500, { ok: false, message: String(e?.message || e) })
      }
    }

    function start() {
      if (server) return
      const base = port()
      const tryListen = (p, left) => {
        const srv = createServer((req, res) => {
          Promise.resolve(handle(req, res)).catch((e) => {
            try {
              json(res, 500, { ok: false, message: String(e?.message || e) })
            } catch {}
          })
        })
        srv.on('error', (e) => {
          listenErr = String(e?.message || e)
          try {
            srv.close()
          } catch {}
          if (e?.code === 'EADDRINUSE' && left > 0) return tryListen(p + 1, left - 1)
          api.log.warn(`口袋服务起不来（端口 ${p}）：${listenErr}`)
        })
        srv.listen(p, '0.0.0.0', () => {
          server = srv
          listening = p
          listenErr = ''
          const addrs = lanAddresses()
          api.log.info(`口袋已开：http://${addrs[0] || '127.0.0.1'}:${p}（密钥 ${tokenOf()}）`)
        })
      }
      try {
        tryListen(base, 6)
      } catch (e) {
        listenErr = String(e?.message || e)
        api.log.warn('口袋服务创建失败：', listenErr)
      }
    }

    // app 界面在才开服务（仓库 CI 里没带 app 目录，不占端口）
    if (on() && existsSync(join(appDir, 'index.html'))) start()
    api.onDispose(() => {
      try {
        server?.close()
      } catch {}
      server = null
    })

    // 面板要的信息
    hooks.__panel = () => ({
      enabled: on(),
      port: listening || port(),
      addresses: lanAddresses(),
      token: tokenOf(),
      tone: tone(),
      tones: TONES,
      error: listenErr,
    })

    hooks.__test = { inject, guard, petInteract, petState, pushEvent, ring: () => ring, readHistory, tokenOf, lanAddresses, urlOf, ops, handle }
  },
}

/** 默认皮肤（app 端按这份参数画形象）。 */
function defaultSkin(persona) {
  return {
    persona,
    name: '鲸汐汐',
    tones: TONES_SKIN,
    whale: { body: '#7db9ec', belly: '#eaf4fd', fin: '#5f97d6', cheek: '#f7b8c4' },
  }
}

const TONES_SKIN = TONES
