
// 真实端到端：模块 → 网页链接 → 真浏览器加密 → 贴回 → 登录
import mod from '../index.mjs'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const run = promisify(execFile)

const dir = await mkdtemp(path.join(os.tmpdir(), 'login-test-'))
const settings = { active: true, users: '200002', groupMode: 'status', groupPhoto: true, allowGroupName: false, unlockDays: 7, maxBindings: 5, requestTimeoutMs: 2000, selectedTtlMinutes: 10, defaultInterface: 'cloud', ownerInterface: '', ownerLocalAllowed: true, tutkBridgePath: '', tutkLibPath: '', tutkTimeoutMs: 8000 }
const routes = new Map(); const replies = []; const handlers = []
const manager = { targetKey: (t) => [t.mode, t.host, t.serial].join('|'), closeAll () {}, async status () { return { ok: true, stale: false, receivedAt: Date.now(), report: { print: { gcode_state: 'RUNNING', mc_percent: '42', mc_remaining_time: '98', layer_num: '5', total_layer_num: '10' } } } }, async command () { return { ok: true } } }
const api = {
  id: 'bambu-print', settings: () => settings, saveSettings: (p) => Object.assign(settings, p),
  dataDir: (...p) => path.join(dir, ...p),
  config: () => ({ ownerQQ: '100001', allow: { private: ['200002'], groups: [] } }),
  isOwner: (qq) => String(qq) === '100001',
  log: { info () {}, warn () {}, error () {}, debug () {} },
  reply: async (m, t) => replies.push(String(t)),
  sendImage: async () => {}, onebot: async () => ({}), command: () => {},
  route: (p, fn) => routes.set(p, fn), tool: () => {}, rule: () => {}, context: () => {},
  on: (e, fn) => handlers.push({ e, fn }), onDispose: () => {}, defineTool: (t) => t,
  core: { http: { body: async (r) => r.__body || {}, query: () => ({}) } },
  __bambuTestHooks: {
    printerManager: manager,
    listDevices: async () => ({ ok: true, devices: [{ serial: '01S00C000000001', name: 'X1C', model: 'X1C' }] }),
    // 只桩掉「真正去 Bambu 云端」那一步（没有真账号），其余全部真实
    createCloudLogin: () => ({
      async login () { return { ok: true, accessToken: 'REAL-TOKEN-abcdef123456', uid: '123456', region: 'cn' } },
      async requestCode () { return { ok: true, channel: 'email' } },
      async submitCode () { return { ok: true, accessToken: 'REAL-TOKEN-abcdef123456', uid: '123456', region: 'cn' } },
      async submitTfa () { return { ok: true, accessToken: 'REAL-TOKEN-abcdef123456', uid: '123456', region: 'cn' } },
    }),
  },
}
const def = mod.default || mod
const exp = def.setup(api)
const call = (p, b) => routes.get(p)({ __body: b || {}, __query: b || {} })
const say = async (text) => {
  replies.length = 0
  const m = { kind: 'private', chatId: 'private:200002', userId: '200002', groupId: '', nickname: 'u', role: '', text, messageId: 'm', images: [], stickers: [], records: [], forwards: [], raw: {} }
  for (const h of handlers.filter((x) => x.e === 'message')) { if (await h.fn(m)) break }
  return replies.at(-1) || ''
}

console.log('【1】用户发 /打印机 登录')
const linkReply = await say('/打印机 登录')
console.log(linkReply.split('\n').slice(0, 3).join('\n'))
const pubMatch = linkReply.match(/#k=([A-Za-z0-9_-]{87})/)
if (!pubMatch) throw new Error('链接里没有 87 字符公钥')
const publicKey = pubMatch[1]
console.log('   公钥:', publicKey.slice(0, 20) + '...（87 字符）')

console.log('\n【2】启动本地静态服务，把 assets/enroll 原样发出去')
const ENROLL_DIR = path.resolve('assets/enroll')
const ACCOUNT = 'tester@example.com'
const PASSWORD = 'MyBambuPass#2026'
const wrapper = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
  '<iframe id="f" src="./index.html#k=' + publicKey + '" style="width:900px;height:1400px"></iframe>' +
  '<pre id="out">PENDING</pre><script>' +
  'const f=document.getElementById("f"),out=document.getElementById("out");' +
  'f.addEventListener("load",function(){const w=f.contentWindow,d=f.contentDocument;const t0=Date.now();' +
  'const tick=function(){const btn=d.getElementById("generate");if(!btn||btn.disabled){if(Date.now()-t0>12000)return out.textContent="ERR: 页面没就绪";return setTimeout(tick,100)}' +
  'const set=function(id,v){const el=d.getElementById(id);el.value=v;el.dispatchEvent(new w.Event("input",{bubbles:true}))};' +
  'set("code","");set("account",' + JSON.stringify(ACCOUNT) + ');set("password",' + JSON.stringify(PASSWORD) + ');set("ttl","15");' +
  'd.getElementById("form").dispatchEvent(new w.Event("submit",{bubbles:true,cancelable:true}));' +
  'const wait=function(){const res=d.getElementById("result"),txt=d.getElementById("output").value;' +
  'if(res&&!res.hidden&&txt){out.textContent=txt;return} if(Date.now()-t0>15000){const i=d.getElementById("issues");return out.textContent="ERR: "+(i?i.innerText:"?")} setTimeout(wait,100)};wait()};' +
  'setTimeout(tick,100)});<\/script></body></html>'
const server = createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const name = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '')
  if (name === 'e2e.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(wrapper); return }
  if (!/^[\w.-]+$/.test(name)) { res.writeHead(400); res.end(); return }
  try {
    const body = await readFile(path.join(ENROLL_DIR, name))
    const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'
    res.writeHead(200, { 'content-type': type }); res.end(body)
  } catch { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const origin = 'http://127.0.0.1:' + server.address().port
console.log('   地址:', origin + '/e2e.html')

console.log('\n【3】用真实浏览器（headless Edge）打开页面、填表、点生成')
const browsers = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
const browser = browsers.find((p) => existsSync(p))
if (!browser) { console.log('   没找到浏览器，跳过'); process.exit(0) }
const ud = await mkdtemp(path.join(os.tmpdir(), 'edge-'))
const { stdout } = await run(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage', '--virtual-time-budget=9000', '--user-data-dir=' + ud, '--dump-dom', origin + '/e2e.html'], { timeout: 40000, maxBuffer: 8 * 1024 * 1024 })
await rm(ud, { recursive: true, force: true })
const mm = stdout.match(/<pre id="out">([^<]*)<\/pre>/)
if (!mm) throw new Error('浏览器没有输出')
const envelope = mm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
if (!envelope.startsWith('BBX1.')) throw new Error('生成失败：' + envelope.slice(0, 300))
console.log('   浏览器生成:', envelope.length, '字符，前缀', envelope.slice(0, 16))

console.log('\n【4】把密文贴回机器人：/打印机 登录 <那段>')
const loginReply = await say('/打印机 登录 ' + envelope)
console.log('   回复:', loginReply)

console.log('\n【5】查状态')
const statusReply = await say('/打印机 状态')
console.log('   ' + statusReply.split('\n').slice(0, 3).join('\n   '))

console.log('\n【6】安全检查')
const all = replies.join('\n') + linkReply + loginReply
console.log('   聊天里出现密码?', all.includes(PASSWORD))
console.log('   聊天里出现账号?', all.includes(ACCOUNT))
console.log('   聊天里出现 token?', all.includes('REAL-TOKEN-abcdef123456'))
await say('/打印机 登录 ' + envelope)
console.log('   重放同一段:', replies.at(-1))

console.log('\n【7】落盘检查')
const files = (await readdir(dir)).sort()
console.log('   数据目录:', files.join(', '))
const vaultRaw = await readFile(path.join(dir, 'vault.json'), 'utf8')
console.log('   vault.json 含明文 token?', vaultRaw.includes('REAL-TOKEN-abcdef123456'))
const keyRaw = await readFile(path.join(dir, 'bbx-key.json'), 'utf8')
console.log('   bbx-key.json 含私钥?', keyRaw.includes('"d"'), '| 含明文密码?', keyRaw.includes(PASSWORD))

server.close()
await rm(dir, { recursive: true, force: true })
console.log('\n✅ 测试结束')
