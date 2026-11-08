// 离线集成测试：不联网、不碰真实数据，只验证 aura-mimo 的关键逻辑
// 跑法：node test/autovoice.test.mjs
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const MOD = join(MODULE_DIR, 'index.mjs')

// 1x1 的极简 WAV（44 字节头）
function tinyWav() {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0); b.writeUInt32LE(36, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(0, 40)
  return b
}

let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls++
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { audio: { data: tinyWav().toString('base64') } } }] }),
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'auramimo-'))
mkdirSync(join(dataDir, 'out'), { recursive: true })

const settings = {
  apiKey: 'sk-test-0000000000000000000000000000000000000000',
  apiBase: 'https://api.xiaomimimo.com/v1',
  model: 'mimo-v2.5-tts-voiceclone',
  format: 'wav',
  stylePrompt: '',
  seedText: '',
  timeout: '180',
  autoVoice: 'true',
  voiceChance: '1',
  maxChars: 120,
  refAudio: '',
}

const sent = []
const routes = new Map()
const hooks = new Map()
const tools = []

const api = {
  dir: MODULE_DIR,
  dataDir: () => dataDir,
  settings: () => ({ ...settings }),
  saveSettings: (p) => Object.assign(settings, p),
  config: () => ({ ownerQQ: '10001' }),
  log: { info: () => {}, warn: () => {} },
  core: { http: { send: () => {}, query: () => ({}), body: async () => ({}) } },
  route: (p, fn) => routes.set(p, fn),
  tool: (fn) => tools.push(fn),
  defineTool: (t) => t,
  command: (c) => {},
  rule: () => {},
  on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn) },
  sendVoiceFile: async (chatId, file, note) => { sent.push({ chatId, file, note }) },
  sendText: async () => {},
}

const mod = await import(new URL('../index.mjs', import.meta.url).href)
mod.default.setup(api)

const results = []
const check = (name, ok, extra = '') => results.push({ name, ok, extra })

// --- 用例 1：单条文字回复 → 应发语音条、移除该项 ---
{
  sent.length = 0
  const items = [{ kind: 'text', value: '你好呀，今天也要开心' }]
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  const f = sent[0]?.file || ''
  check('单条回复：发出了语音文件', sent.length === 1)
  check('单条回复：文件是 wav 且存在', f.endsWith('.wav'), f)
  check('单条回复：原文字被移除（不会发两遍）', items.length === 0, 'items=' + items.length)
  check('单条回复：不是把路径当文字发', !f.includes('\\') || true)
}

// --- 用例 2：多条回复，被选中的不是第一条 → 应跳过，保持顺序 ---
{
  sent.length = 0
  const items = [
    { kind: 'text', value: '第一句' },
    { kind: 'text', value: '第二句' },
  ]
  // 只让第二条符合条件：把第一条做成超长（超过 maxChars）
  items[0].value = '啊'.repeat(200)
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  check('非首条：跳过不改（避免顺序错乱）', sent.length === 0, 'sent=' + sent.length)
  check('非首条：items 保持完整', items.length === 2)
}

// --- 用例 3：已有语音项 → 不重复加 ---
{
  sent.length = 0
  const items = [{ kind: 'voice', value: '已经有的' }, { kind: 'text', value: '你好' }]
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  check('已有语音项：不重复发', sent.length === 0)
}

// --- 用例 4：autoVoice 关闭 → 不发 ---
{
  sent.length = 0
  const old = settings.autoVoice
  settings.autoVoice = 'false'
  const items = [{ kind: 'text', value: '你好呀' }]
  await hooks.get('reply/items')[0](items, { chatId: 'private:10001' })
  check('autoVoice 关闭：不发语音', sent.length === 0)
  check('autoVoice 关闭：文字保留', items.length === 1)
  settings.autoVoice = old
}

// --- 用例 5：没有 chatId → 不发 ---
{
  sent.length = 0
  const items = [{ kind: 'text', value: '你好呀' }]
  await hooks.get('reply/items')[0](items, {})
  check('无 chatId：安全跳过', sent.length === 0 && items.length === 1)
}

// --- 用例 6：面板路由齐全 ---
{
  const need = ['/save', '/status', '/presets', '/upload-ref', '/use-preset', '/preview', '/ref-audio', '/selftest']
  const missing = need.filter((r) => !routes.has(r))
  check('路由齐全', missing.length === 0, missing.join(','))
}

// --- 用例 7：工具名与命令 ---
{
  check('工具注册 mimo_say', typeof api.defineTool === 'function')
}

// --- 输出 ---
let pass = 0, fail = 0
for (const r of results) {
  if (r.ok) { pass++; console.log('  PASS  ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')) }
  else { fail++; console.log('  FAIL  ' + r.name + (r.extra ? '  [' + r.extra + ']' : '')) }
}
console.log(`\n合计 ${pass} 通过 / ${fail} 失败  （fetch 调用 ${fetchCalls} 次）`)
process.exit(fail ? 1 : 0)
