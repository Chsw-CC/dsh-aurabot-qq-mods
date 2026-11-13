import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据目录摆成真实结构：tmp/aurabot/modules-data/phone，chatlog 在 tmp/aurabot/chatlog
const ROOT = mkdtempSync(join(tmpdir(), 'phone-test-'))
const DATA_DIR = join(ROOT, 'aurabot', 'modules-data', 'phone')
const CHATLOG = join(ROOT, 'aurabot', 'chatlog')
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(CHATLOG, { recursive: true })

const OWNER = '3119752156'
const BOT = '3198936516'

// 只 setup 一次：重复 setup 会重复注册 route/监听，测试间状态会串
const mod = (await import('../index.mjs')).default
const hooks = (await import('../index.mjs')).hooks

const routes = {}
const listeners = {}
const hubCalls = []
let settingsState = { enabled: true, token: '' }
let memoryEvents = []

const api = {
  dataDir: () => DATA_DIR,
  config: () => ({ ownerQQ: OWNER, botQQ: BOT, ownerName: '老公', persona: { current: 'dafeiyu' } }),
  settings: () => ({ ...settingsState }),
  saveSettings: (patch) => { Object.assign(settingsState, patch) },
  log: { info() {}, warn() {}, error() {}, debug() {} },
  route: (path, handler) => { routes[path] = handler },
  on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) },
  use: (id) => {
    if (id === 'memory') return { addEvent: (e) => { memoryEvents.push(e); return { ok: true } }, list: () => [] }
    if (id === 'mood') return { state: () => 88, label: () => '挺开心的' }
    return null
  },
  think: async () => '…',
  onDispose: () => {},
  core: {
    http: {
      body: async (req) => (req && req.__body) || {},
      send: (res, code, buf, type) => { res.__sent = { code, buf, type } },
    },
    hub: { onMessage: async (ev) => { hubCalls.push(ev) } },
    onebot: { state: 'connected' },
  },
}

mod.setup(api)
const T = hooks.__test
assert.ok(T && T.ring, 'setup 应该挂上测试钩子')

// 宿主回调签名是 (req, res)；POST 带 JSON 头
function req(token, { body = null, url = '/', json = true } = {}) {
  const headers = {}
  if (token) headers['x-phone-token'] = token
  if (body) headers['content-type'] = json ? 'application/json' : 'text/plain'
  return { url, headers, __body: body || {} }
}

beforeEach(() => {
  T.ring().length = 0
  hubCalls.length = 0
  memoryEvents.length = 0
  settingsState.enabled = true
  // 宠物文件重置
  rmSync(join(DATA_DIR, 'pet.json'), { force: true })
})

test('首次 setup 自动生成密钥', () => {
  const t = T.tokenOf()
  assert.match(t, /^pk_/)
  assert.equal(api.settings().token, t)
})

test('无密钥 / 错密钥 / 关开关都进不来', () => {
  const token = T.tokenOf()
  const res = {}
  assert.equal(routes['/events'](req(), res), undefined)
  assert.equal(res.__sent.code, 401)
  const res2 = {}
  assert.equal(routes['/events'](req('wrong', { url: '/events' }), res2), undefined)
  assert.equal(res2.__sent.code, 401)
  settingsState.enabled = false
  const res3 = {}
  assert.equal(routes['/events'](req(token, { url: '/events' }), res3), undefined)
  assert.equal(res3.__sent.code, 403)
  settingsState.enabled = true
  const ok = routes['/events'](req(token, { url: '/events' }), {})
  assert.equal(ok.ok, true)
  assert.equal(ok.list.length, 0)
})

test('GET 可以用 ?token=（给 <audio> 标签用）', () => {
  const token = T.tokenOf()
  const r = routes['/events'](req(null, { url: `/events?token=${token}` }), {})
  assert.equal(r.ok, true)
  assert.equal(r.list.length, 0)
})

test('注入消息：走 hub，事件字段正确', async () => {
  const token = T.tokenOf()
  const r = await routes['/message'](req(token, { body: { text: '在干嘛' }, url: '/message' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.via, 'hub')
  assert.equal(hubCalls.length, 1)
  const ev = hubCalls[0]
  assert.equal(ev.message_type, 'private')
  assert.equal(ev.sub_type, 'friend')
  assert.equal(String(ev.user_id), OWNER)
  assert.equal(String(ev.self_id), BOT)
  assert.equal(ev.raw_message, '在干嘛')
  assert.deepEqual(ev.message, [{ type: 'text', data: { text: '在干嘛' } }])
})

test('POST 非 JSON 被拒（CSRF 防线）', async () => {
  const token = T.tokenOf()
  const res = {}
  await routes['/message'](req(token, { body: { text: 'hi' }, url: '/message', json: false }), res)
  assert.equal(res.__sent.code, 400)
})

test('注入空消息被拒', async () => {
  const token = T.tokenOf()
  const r = await routes['/message'](req(token, { body: { text: '   ' }, url: '/message' }), {})
  assert.equal(r.ok, false)
})

test('她发出去的话（私聊）进事件环，别人和群的不会', () => {
  const token = T.tokenOf()
  for (const fn of listeners['activity'] || []) {
    fn({ kind: 'out', chatId: `private:${OWNER}`, reply: '嗯' })
    fn({ kind: 'out', chatId: 'group:123', reply: '群里说的' })
    fn({ kind: 'in', chatId: `private:${OWNER}`, text: '收到的' })
  }
  const r = routes['/events'](req(token, { url: '/events' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].type, 'her')
  assert.equal(r.list[0].text, '嗯')
})

test('events 增量拉取：after 之前的不再给', () => {
  const token = T.tokenOf()
  T.pushEvent('her', { text: '一' })
  T.pushEvent('her', { text: '二' })
  const all = routes['/events'](req(token, { url: '/events' }), {})
  assert.equal(all.list.length, 2)
  const again = routes['/events'](req(token, { url: `/events?after=${all.seq}` }), {})
  assert.equal(again.list.length, 0)
})

test('投喂：数值上升、写入她的记忆、冷却与上限生效', async () => {
  const token = T.tokenOf()
  const r1 = await routes['/pet'](req(token, { body: { action: 'feed', food: 'rice' }, url: '/pet' }), {})
  assert.equal(r1.ok, true)
  assert.ok(r1.state.satiety > 62)
  assert.equal(memoryEvents.length, 1)
  assert.match(memoryEvents[0].text, /白米饭/)

  // 20 秒冷却内再喂会被拒
  const r2 = await routes['/pet'](req(token, { body: { action: 'feed', food: 'rice' }, url: '/pet' }), {})
  assert.equal(r2.refused, true)

  // 饱食度顶满拒绝
  rmSync(join(DATA_DIR, 'pet.json'), { force: true })
  writeFileSync(join(DATA_DIR, 'pet.json'), JSON.stringify({ satiety: 99, mood: 80, intimacy: 5, lastTick: Date.now(), lastFeedAt: 0, lastPetAt: 0 }), 'utf8')
  const r3 = await routes['/pet'](req(token, { body: { action: 'feed' }, url: '/pet' }), {})
  assert.equal(r3.refused, true)
  assert.match(r3.reply, /撑死/)
})

test('state 返回人格、心情和宠物数值', () => {
  const token = T.tokenOf()
  const r = routes['/state'](req(token, { url: '/state' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.persona, 'dafeiyu')
  assert.equal(r.mood, 88)
  assert.equal(r.owner, '老公')
  assert.equal(typeof r.pet.satiety, 'number')
})

test('皮肤：没自定义包时给内置默认', () => {
  const token = T.tokenOf()
  const r = routes['/skin'](req(token, { url: '/skin' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.builtin, true)
  assert.equal(r.skin.persona, 'dafeiyu')
  assert.ok(r.skin.whale)
})

test('history：只取主人私聊', () => {
  writeFileSync(join(CHATLOG, '2026-11-14.jsonl'), [
    JSON.stringify({ t: Date.now(), chatId: `private:${OWNER}`, who: 'bot', text: '定啦' }),
    JSON.stringify({ t: Date.now(), chatId: 'private:999', who: 'bot', text: '别人的' }),
    JSON.stringify({ t: Date.now(), chatId: `private:${OWNER}`, who: 'user', text: '吃饭没' }),
    JSON.stringify({ t: Date.now(), chatId: 'group:1', who: 'bot', text: '群里的' }),
  ].join('\n'), 'utf8')
  const token = T.tokenOf()
  const r = routes['/history'](req(token, { url: '/history?days=3' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.list.length, 2)
  assert.deepEqual(r.list.map((x) => x.who), ['her', 'me'])
})

test('语音：voice 模组没在跑时明确报错', async () => {
  const token = T.tokenOf()
  const r = await routes['/voice'](req(token, { url: `/voice?text=${encodeURIComponent('你好')}` }), {})
  assert.equal(r.ok, false)
  assert.match(r.message, /语音模组/)
})

test('色调：合法 key 才收，写进设置', async () => {
  const token = T.tokenOf()
  const bad = await routes['/tone'](req(token, { body: { tone: 'hacker-green' }, url: '/tone' }), {})
  assert.equal(bad.ok, false)
  const good = await routes['/tone'](req(token, { body: { tone: 'sakura' }, url: '/tone' }), {})
  assert.equal(good.ok, true)
  assert.equal(api.settings().tone, 'sakura')
  const st = routes['/state'](req(token, { url: '/state' }), {})
  assert.equal(st.tone, 'sakura')
  assert.ok(st.tones.includes('ocean'))
  settingsState.tone = ''
})

test('自带服务：/api/health 不用密钥，其他接口要', async () => {
  const token = T.tokenOf()
  assert.ok(T.handle, 'handle 应该挂上')
  const hres = mockRes()
  await T.handle(mockReq({ url: '/api/health' }), hres)
  assert.equal(hres.code, 200)
  const res401 = mockRes()
  await T.handle(mockReq({ url: '/api/state' }), res401)
  assert.equal(res401.code, 401)
  const resOk = mockRes()
  await T.handle(mockReq({ url: '/api/state', headers: { 'x-pocket-token': token } }), resOk)
  assert.equal(resOk.code, 200)
  const body = JSON.parse(resOk.chunks.join(''))
  assert.equal(body.ok, true)
  assert.equal(body.persona, 'dafeiyu')
})

test('自带服务：静态文件越界被拦', async () => {
  const res = mockRes()
  await T.handle(mockReq({ url: '/..%2f..%2f..%2fwindows%2fwin.ini' }), res)
  assert.notEqual(res.code, 200)
})

function mockRes() {
  return { code: 0, type: '', chunks: [], writeHead(c, h) { this.code = c; this.type = h && h['content-type'] }, end(b) { if (b) this.chunks.push(b) } }
}
function mockReq({ url = '/', headers = {}, method = 'GET' } = {}) {
  return { url, headers, method }
}
