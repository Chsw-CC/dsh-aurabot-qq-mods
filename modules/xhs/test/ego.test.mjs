// ego 后端回归测试：冷启动给子进程的环境不能把「宿主自带的无头」继承下去。
//
// 背景：EGO_LINUX_HEADLESS 有三个来源 —— 系统环境变量、宿主进程（DSH 在某些装法下
// 自己带着 =1）、面板里的 headless override。桌面平台上头两个都不是用户选的，
// 继承下去等于每次冷启动都拉起无头实例：没窗口没法扫码登录，页面按后台节流渲染，
// 卡片量成 0×0，解析全空后才退到滚动兜底（xhs 的 b.scroll 就是这么炸的）。
// 这组测试锁住判定规则本身，不启动浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { egoChildEnv } from '../lib/ego.mjs'

test('桌面平台剥掉宿主继承的无头标记（win32 / darwin）', () => {
  for (const plat of ['win32', 'darwin']) {
    const env = egoChildEnv({ EGO_LINUX_HEADLESS: '1' }, plat)
    assert.equal(env.EGO_LINUX_HEADLESS, undefined, plat + ' 不该继承无头标记')
    // 其它变量原样带过去，只摘这一个键
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1', '仍要设 ELECTRON_RUN_AS_NODE')
  }
})

test('Linux 无显示环境仍尊重原变量（服务器 / CI 不被打坏）', () => {
  const env = egoChildEnv({ EGO_LINUX_HEADLESS: '1' }, 'linux')
  assert.equal(env.EGO_LINUX_HEADLESS, '1', 'linux 不该被改写')
})

test('显式要无头时保留（AURABOT_EGO_HEADLESS=1 是用户自己的意思）', () => {
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    const env = egoChildEnv({ EGO_LINUX_HEADLESS: '', AURABOT_EGO_HEADLESS: value }, 'win32')
    assert.equal(env.EGO_LINUX_HEADLESS, '1', 'value=' + value + ' 应保留无头')
  }
})

test('显式值不是真值时按无头处理掉（别被 AURABOT_EGO_HEADLESS=0 骗了）', () => {
  for (const value of ['0', 'false', 'no', 'off', '', 'abc']) {
    const env = egoChildEnv({ EGO_LINUX_HEADLESS: '1', AURABOT_EGO_HEADLESS: value }, 'darwin')
    assert.equal(env.EGO_LINUX_HEADLESS, undefined, 'value=' + value + ' 不该无头')
  }
})

test('不改动调用方传进来的对象', () => {
  const base = { EGO_LINUX_HEADLESS: '1', PATH: '/bin' }
  const env = egoChildEnv(base, 'win32')
  assert.equal(base.EGO_LINUX_HEADLESS, '1', 'base 不该被改')
  assert.notEqual(env, base, '应返回新对象')
  assert.equal(env.PATH, '/bin', '其它变量原样保留')
})

test('Linux 下同样不改原对象，且变量原样带出', () => {
  const base = { EGO_LINUX_HEADLESS: '1' }
  const env = egoChildEnv(base, 'linux')
  assert.equal(base.EGO_LINUX_HEADLESS, '1')
  assert.equal(env.EGO_LINUX_HEADLESS, '1')
})


// —— acquireEgoTarget 的「不打扰前台」回归 ——
// /json/new 会激活新标签页并把整个 ego 窗口顶到前台：定时任务每轮建页都弹一次
// 窗口、抢一次焦点，主人手动关窗口还会把模块连接一起带走（日志里成串的
// 「浏览器没连上」就是这么来的）。正确做法是后台建页。
import { acquireEgoTarget } from '../lib/ego.mjs'

function egoHarness({ versionWs = 'ws://127.0.0.1:19999/devtools/browser/x' } = {}) {
  const calls = { new: 0, activate: [], close: [] }
  const tabs = new Map()
  let seq = 0
  const tab = (id, url = 'about:blank') => ({ id, type: 'page', url, webSocketDebuggerUrl: 'ws://127.0.0.1:19999/devtools/page/' + id })
  const state = { tabs, calls, addTab: (id, url) => tabs.set(id, tab(id, url)) }
  globalThis.__egoFetch = async (url, opts = {}) => {
    const u = String(url)
    if (u.includes('/json/version')) return Response.json({ Browser: '假 ego', webSocketDebuggerUrl: versionWs })
    if (u.includes('/json/new')) {
      calls.new++
      const id = 'new-' + (++seq)
      tabs.set(id, tab(id))
      if (opts.method !== 'PUT') throw new Error('旧内核路径')
      return Response.json(tabs.get(id))
    }
    if (u.includes('/json/activate/')) { calls.activate.push(u.split('/').pop()); return Response.json({ OK: true }) }
    if (u.includes('/json/close/')) { calls.close.push(u.split('/').pop()); tabs.delete(u.split('/').pop()); return Response.json({ OK: true }) }
    if (u.includes('/json/list')) return Response.json([...tabs.values()])
    throw new Error('unexpected ' + u)
  }
  const getJson = async (url) => {
    const r = await globalThis.__egoFetch(url)
    return r.json()
  }
  return state
}

test('浏览器级 CDP 可用时后台建页：不发 /json/new、不抢焦点', async (t) => {
  const h = egoHarness()
  h.addTab('front', 'https://example.com/')
  const oldFetch = globalThis.fetch
  globalThis.fetch = globalThis.__egoFetch
  t.after(() => { globalThis.fetch = oldFetch; delete globalThis.__egoFetch })
  const browserConns = []
  const connect = (ws) => {
    const c = {
      ready: Promise.resolve(),
      sent: [],
      async send(method, params) {
        this.sent.push([method, params])
        if (method === 'Target.createTarget') {
          h.addTab('bg-1')
          return { targetId: 'bg-1' }
        }
        return {}
      },
      close() {},
    }
    browserConns.push(c)
    return c
  }
  const target = await acquireEgoTarget(19999, (u) => globalThis.__egoFetch(u).then((r) => r.json()), connect)
  assert.equal(target.id, 'bg-1')
  assert.equal(h.calls.new, 0, '后台建页不该走 /json/new')
  assert.deepEqual(h.calls.activate, [], '不该有焦点切换')
  assert.deepEqual(browserConns[0].sent, [['Target.createTarget', { url: 'about:blank', background: true }]])
})

test('浏览器级 CDP 不可用时回退 /json/new，并把焦点还给之前的标签页', async (t) => {
  const h = egoHarness({ versionWs: '' })  // 没有 webSocketDebuggerUrl → 走回退
  h.addTab('front', 'https://example.com/')
  const oldFetch = globalThis.fetch
  globalThis.fetch = globalThis.__egoFetch
  t.after(() => { globalThis.fetch = oldFetch; delete globalThis.__egoFetch })
  const target = await acquireEgoTarget(19999, (u) => globalThis.__egoFetch(u).then((r) => r.json()))
  assert.equal(h.calls.new, 1)
  assert.deepEqual(h.calls.activate, ['front'], '建页后要把焦点还给之前的标签页')
  assert.ok(target.id.startsWith('new-'))
})

test('共享实例里没有其他标签页时，回退建页不发 activate（没有要还的对象）', async (t) => {
  const h = egoHarness({ versionWs: '' })
  const oldFetch = globalThis.fetch
  globalThis.fetch = globalThis.__egoFetch
  t.after(() => { globalThis.fetch = oldFetch; delete globalThis.__egoFetch })
  await acquireEgoTarget(19999, (u) => globalThis.__egoFetch(u).then((r) => r.json()))
  assert.equal(h.calls.new, 1)
  assert.deepEqual(h.calls.activate, [])
})
