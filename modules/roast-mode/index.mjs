/**
 * roast-mode —— 毒舌模式
 * 作用：主人发关键字开/关某个聊天的「毒舌模式」；开着时按设定接管消息，
 *      从语料抽一句损友式吐槽回过去（引用回复）。语料默认内置预设，
 *      可打开「读文本文件」开关改读数据目录的 corpus.txt（每行一句）。
 * 契约：扩展接口 v1（api: 1）；capabilities: filesystem（读写语料文件）。
 * 数据：状态存 api.dataDir('state.json')，语料文件 api.dataDir('corpus.txt')。
 *      模块源码目录不写任何运行数据。
 * 风格：只做损友式调侃/优雅毒舌，不产辱骂、脏话与针对性攻击内容。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 内置预设语料：损友式吐槽，健康向 */
const DEFAULT_LINES = [
  '你这脑子今天是不是忘记充电了？',
  '就这？我还以为能听到点新鲜的呢。',
  '你这发言，评论区看了都要叹气。',
  '行行行，你说得都对，下次继续。',
  '你这操作我愿称之为「迷惑行为大赏」冠军。',
  '别说了，再说下去我都要替你尴尬了。',
  '你这水平，建议回炉重造，记得带保修。',
  '我沉默不是无话可说，是不知道从哪吐槽起。',
  '你这逻辑跳跃得，刘翔看了都想拜师。',
  '好好好，这么玩是吧，我记小本本上了。',
  '你这话说得，连 Siri 都想装听不见。',
  '建议把这条消息裱起来，警示后人。',
  '你这不叫想法，叫一闪而过的念头。',
  '我的嘴替今日休息，先给你记一笔账。',
  '就你这战术水平，团战第一个倒下的就是你。',
  '你这波操作，反向教学都不配上镜。',
  '听得进去就改，听不进去……那你也改。',
  '你这脑回路，导航都得重新规划路线。',
  '别急，让子弹再飞一会儿，反正也打不中。',
  '你这发言，建议自带降噪耳机再发一遍。',
]

/** 语料文件模板（首次自动写到数据目录，用户可随便改） */
const CORPUS_TEMPLATE = [
  '# 毒舌模式语料：每行一句，# 开头的行是注释会被忽略，空行忽略。',
  '# 文件位置由面板显示；改完保存即可，模块每次发言前都会重新读。',
  ...DEFAULT_LINES,
].join('\n') + '\n'

/** 模块设置表单（面板自动生成） */
const SETTINGS = [
  { key: 'onKeyword', label: '开启关键字', type: 'text', hint: '在这个聊天里发它就开毒舌模式', placeholder: '毒舌开启' },
  { key: 'offKeyword', label: '关闭关键字', type: 'text', hint: '发它就关', placeholder: '毒舌关闭' },
  { key: 'ownerOnly', label: '只有主人能开关', type: 'switch', hint: '开着时别人发关键字无效' },
  { key: 'useFile', label: '从文本文件读语料', type: 'switch', hint: '关=用内置预设；开=读数据目录的 corpus.txt（每行一句）' },
  { key: 'mode', label: '接管方式', type: 'select', options: [
    { value: 'roast', label: '抽查：按概率回毒舌，其余照常聊' },
    { value: 'all', label: '全接管：开着时每条消息都回毒舌' },
  ] },
  { key: 'probability', label: '抽查概率 %', type: 'number', min: 0, max: 100, step: 5, hint: '接管方式=抽查时生效' },
  { key: 'cooldownSec', label: '冷却秒数', type: 'number', min: 0, max: 600, step: 5, hint: '两次毒舌之间的最小间隔，防刷屏' },
]

/** 导出给别的模块 / 测试用的纯函数 */
export function parseCorpus(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
}

export function pickLine(lines, lastLine) {
  const pool = lines.filter((l) => l !== lastLine)
  const list = pool.length ? pool : lines
  if (!list.length) return null
  return list[Math.floor(Math.random() * list.length)]
}

export default {
  id: 'roast-mode',
  name: '毒舌模式',
  version: '1.0.0',
  api: 1,
  description: '主人发关键字开关的损友式吐槽模式，语料可改读文本文件（每行一句）',
  defaults: {
    onKeyword: '毒舌开启',
    offKeyword: '毒舌关闭',
    ownerOnly: true,
    useFile: false,
    mode: 'roast',
    probability: 60,
    cooldownSec: 20,
  },
  settings: SETTINGS,

  setup(api) {
    const dataDir = api.dataDir()
    const corpusPath = join(dataDir, 'corpus.txt')
    const statePath = join(dataDir, 'state.json')

    // ── 状态：每个聊天是否开着 ─────────────────────────────
    let enabled = new Set()
    try {
      if (existsSync(statePath)) {
        const arr = JSON.parse(readFileSync(statePath, 'utf8'))
        if (Array.isArray(arr)) enabled = new Set(arr.filter((x) => typeof x === 'string'))
      }
    } catch (e) {
      api.log.warn('读取毒舌开关状态失败，按全关处理：', e?.message || e)
    }
    const saveState = () => {
      try {
        writeFileSync(statePath, JSON.stringify([...enabled], null, 2), 'utf8')
      } catch (e) {
        api.log.warn('保存毒舌开关状态失败：', e?.message || e)
      }
    }

    // ── 语料：首次落一份模板到数据目录；带 mtime 缓存读文件 ──
    try {
      if (!existsSync(corpusPath)) writeFileSync(corpusPath, CORPUS_TEMPLATE, 'utf8')
    } catch (e) {
      api.log.warn('写语料模板失败：', e?.message || e)
    }
    let fileCache = { mtime: 0, lines: [] }
    const fileLines = () => {
      try {
        const mtime = statSync(corpusPath).mtimeMs
        if (mtime !== fileCache.mtime) {
          fileCache = { mtime, lines: parseCorpus(readFileSync(corpusPath, 'utf8')) }
        }
        return fileCache.lines
      } catch (e) {
        api.log.warn('读语料文件失败，本次用内置预设：', e?.message || e)
        return []
      }
    }
    const linesNow = () => (api.settings().useFile ? fileLines() : DEFAULT_LINES)

    // ── 冷却 / 防重复 ─────────────────────────────────────
    let lastFireAt = 0
    let lastLine = null

    const fireRoast = async (msg) => {
      const now = Date.now()
      const cd = Math.max(0, Number(api.settings().cooldownSec) || 0) * 1000
      if (now - lastFireAt < cd) return false
      const line = pickLine(linesNow(), lastLine)
      if (!line) return false
      lastFireAt = now
      lastLine = line
      await api.reply(msg, line)
      return true
    }

    // ── 消息入口 ─────────────────────────────────────────
    api.on('message', async (msg) => {
      const s = api.settings()
      const text = String(msg.text || '').trim()

      // 1) 开关关键字（精确匹配）
      if (text === s.onKeyword || text === s.offKeyword) {
        if (s.ownerOnly && !api.isOwner(msg.userId)) return false // 别人发关键字当没看见
        const turningOn = text === s.onKeyword
        if (turningOn) enabled.add(msg.chatId)
        else enabled.delete(msg.chatId)
        saveState()
        await api.reply(msg, turningOn ? '毒舌模式已开启，说话小心点哦～' : '毒舌模式已关闭，恢复温柔模式。')
        return true
      }

      // 2) 没开的聊天不管
      if (!enabled.has(msg.chatId)) return false

      // 3) 接管方式
      const mode = s.mode === 'all' ? 'all' : 'roast'
      if (mode === 'roast' && !msg.mentioned) {
        const prob = Math.min(100, Math.max(0, Number(s.probability) || 0))
        if (Math.random() * 100 >= prob) return false // 这次不抽查，照常聊天
      }
      return fireRoast(msg)
    })

    api.onDispose(() => saveState())

    // ── 导出：面板/别的模块可查状态 ───────────────────────
    return {
      status() {
        return { chats: [...enabled], corpusPath, useFile: api.settings().useFile }
      },
      corpusPath,
    }
  },
}
