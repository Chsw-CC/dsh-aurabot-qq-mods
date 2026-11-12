// 衣柜：她的衣服、今天的穿搭、按穿搭生图预览。
//
// 一件衣服 = 参考图 + 一段文字描述（描述由看图模型从参考图生成，可手改）。
// 生图时：能带参考图的服务就用参考图，不能（比如 Codex）就用文字描述。
//
// v1：手动选衣服、手动换装、按预设姿势出预览图。聊天里的自动匹配留到下一版。

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const KINDS = ['set']
const KIND_NAME = { set: '整套' }

const POSES = {
  stand: { name: '站姿', text: '全身站姿，正面，双手自然垂下，看着镜头' },
  sit: { name: '坐姿', text: '坐在床边，双腿并拢，手放在膝盖上，看着镜头' },
  lookback: { name: '回眸', text: '侧身回头看向镜头，头发微微扬起' },
  chin: { name: '托腮', text: '坐在桌前单手托腮，看着镜头' },
  peace: { name: '比耶', text: '举一只手比耶，歪着头笑' },
  mirror: { name: '对镜自拍', text: '举着手机对镜自拍，手机挡住半张脸' },
}

const DEFAULT_BASE = '蓝发少女，蓝色长卷发，发尾渐变成浅海蓝，头顶一撮翘起来的呆毛，一对深蓝色的鲸鱼耳朵，身后拖着一条鲸鱼尾巴，大眼睛，笑起来脸会红，皮肤白皙'
const DEFAULT_OUTFIT = '蓝白配色女仆装，白色荷叶边头饰，围裙上绣着一只小鲸鱼'
const DEFAULT_STYLE = '二次元插画风格，干净线条，柔和上色，白色背景'

const mimeOf = (b64) => (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('iVBOR') ? 'image/png' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png')
const extOf = (mime) => (mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png')

export default {
  id: 'wardrobe',
  name: '衣柜',
  version: '1.0.0',
  api: 1,
  description: '她的衣服：参考图 + 文字描述；手动挑今天穿什么，按姿势生成预览图',
  panel: 'panel.js',
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'visionModel', label: '看图模型', type: 'text', hint: '留空 = 用当前聊天模型（能看图就行）；也可以填 provider/model 强制指定，比如 deepseek-official/deepseek-flash' },
  ],

  setup(api) {
    const cfg = () => ({ enabled: true, visionModel: '', ...(api.settings() || {}) })
    const dir = () => api.dataDir()
    const file = () => join(dir(), 'wardrobe.json')
    const imgDir = () => join(dir(), 'images')
    const prevDir = () => join(dir(), 'preview')

    const load = () => {
      try {
        const s = JSON.parse(readFileSync(file(), 'utf8'))
        const today = s.today || {}
        if (!today.set && (today.top || today.bottom || today.outer || today.shoes || today.accessory)) {
          today.set = today.top || today.bottom || today.outer || today.shoes || today.accessory
          delete today.top; delete today.bottom; delete today.outer; delete today.shoes; delete today.accessory
        }
        return { items: Array.isArray(s.items) ? s.items : [], today, history: Array.isArray(s.history) ? s.history : [], base: String(s.base || ''), style: String(s.style || '') }
      } catch (error) { return { items: [], today: {}, history: [], base: '', style: '' } }
    }
    const save = (s) => { mkdirSync(dir(), { recursive: true }); writeFileSync(file(), JSON.stringify(s, null, 2)) }

    // 第一次跑的时候放一套默认女仆装，省得衣柜是空的
    const MAID = { id: 'w_maid', name: '女仆装', kind: 'set', desc: DEFAULT_OUTFIT, image: '', mediaType: '', seeded: true }
    function seedOnce() {
      const s = load()
      if (s.seeded) return
      if (!(s.items || []).some((x) => x.id === MAID.id || x.name === MAID.name)) {
        s.items = [...(s.items || []), { ...MAID, createdAt: Date.now() }]
        if (!s.today || !s.today.set) s.today = { ...(s.today || {}), set: MAID.id }
      }
      s.seeded = true
      save(s)
    }
    function itemOf(id, s = load()) { return (s.items || []).find((x) => x.id === id) || null }

    function outfitText(s = load()) {
      const whole = itemOf(s.today.set, s)
      if (whole) return whole.desc || whole.name
      const parts = KINDS.filter((k) => k !== 'set').map((k) => {
        const it = itemOf(s.today[k], s)
        return it ? it.desc || it.name : ''
      }).filter(Boolean)
      return parts.join('，')
    }

    function buildPrompt(poseKey, s = load()) {
      const base = String(s.base || '').trim() || DEFAULT_BASE
      const style = String(s.style || '').trim() || DEFAULT_STYLE
      const outfit = outfitText(s) || DEFAULT_OUTFIT
      const pose = (POSES[poseKey] || POSES.stand).text
      return [base, outfit ? '今天穿：' + outfit : '', pose, style].filter(Boolean).join('，')
    }

    /** 看图写描述：优先用设置里的模型，失败就换一个能看图的。 */
    async function caption(b64, mediaType) {
      const c = cfg()
      const [provider, model] = String(c.visionModel || '').split('/').map((x) => x.trim())
      const target = provider && model ? { provider, model } : null
      const ask = (m) => api.ask({
        model: m || undefined,
        system: '你在描述一件衣服或一套穿搭，用来给生图模型当参考。用中文写 60 字以内：品类、颜色、材质、版型、明显细节（图案、领口、长度、配饰）。不要写人、不要写背景、不要评价。',
        text: '描述这张图里的衣服。',
        images: [{ data: b64, mediaType }],
        maxTokens: 300,
        temperature: 0.2,
      })
      try {
        const out = String(await ask(target)).trim()
        if (out) return out
      } catch (error) { api.log.debug?.('指定看图模型失败，换默认：', error.message) }
      return String(await ask(null)).trim()
    }

    async function addItem({ name, kind, image, desc }) {
      const b64 = String(image || '').replace(/^data:[^,]+,/, '')
      const typed = String(desc || '').trim()
      if (!b64 && !typed) return { ok: false, message: '给一张图，或者写一段描述' }
      if (b64.length > 6 * 1024 * 1024) return { ok: false, message: '图片太大了（base64 超过 6MB）' }
      const mediaType = b64 ? mimeOf(b64) : ''
      const id = 'w_' + Math.random().toString(36).slice(2, 8)
      let fname = ''
      if (b64) {
        mkdirSync(imgDir(), { recursive: true })
        fname = id + '.' + extOf(mediaType)
        writeFileSync(join(imgDir(), fname), Buffer.from(b64, 'base64'))
      }
      let text = typed
      if (!text && b64) {
        try { text = await caption(b64, mediaType) } catch (error) { text = '' }
      }
      const s = load()
      s.items.push({
        id,
        name: String(name || '').trim() || (KIND_NAME[kind] || '整套'),
        kind: 'set',
        desc: text.slice(0, 200),
        image: fname,
        mediaType,
        createdAt: Date.now(),
      })
      save(s)
      return { ok: true, item: s.items[s.items.length - 1], captioned: Boolean(text) }
    }

    async function replaceImage({ id, image }) {
      const b64 = String(image || '').replace(/^data:[^,]+,/, '')
      if (!b64) return { ok: false, message: '没有图片' }
      if (b64.length > 6 * 1024 * 1024) return { ok: false, message: '图片太大了（base64 超过 6MB）' }
      const s = load()
      const it = itemOf(String(id || ''), s)
      if (!it) return { ok: false, message: '没这件' }
      const mediaType = mimeOf(b64)
      mkdirSync(imgDir(), { recursive: true })
      const fname = it.id + '-' + Date.now() + '.' + extOf(mediaType)
      writeFileSync(join(imgDir(), fname), Buffer.from(b64, 'base64'))
      it.image = fname
      it.mediaType = mediaType
      it.updatedAt = Date.now()
      save(s)
      return { ok: true, item: it, outfit: outfitText(s) }
    }
    function updateItem({ id, name, desc }) {
      const s = load()
      const it = itemOf(String(id || ''), s)
      if (!it) return { ok: false, message: '没这件' }
      if (typeof name === 'string' && name.trim()) it.name = name.trim().slice(0, 20)
      if (typeof desc === 'string') it.desc = desc.trim().slice(0, 200)
      save(s)
      return { ok: true, item: it, outfit: outfitText(s) }
    }
    function clearAll() {
      const s = load()
      for (const it of s.items || []) {
        try { unlinkSync(join(imgDir(), it.image)) } catch (error) { /* 文件不在就算了 */ }
      }
      s.items = []
      s.today = {}
      save(s)
      return { ok: true }
    }
    function removeItem(id) {
      const s = load()
      const it = itemOf(id, s)
      if (!it) return { ok: false, message: '没这件' }
      s.items = s.items.filter((x) => x.id !== id)
      for (const k of Object.keys(s.today)) if (s.today[k] === id) delete s.today[k]
      save(s)
      try { unlinkSync(join(imgDir(), it.image)) } catch (error) { /* 文件不在就算了 */ }
      return { ok: true }
    }

    function setToday(patch) {
      const s = load()
      s.today = s.today || {}
      for (const k of KINDS) {
        if (!(k in patch)) continue
        const v = String(patch[k] || '')
        if (!v) delete s.today[k]
        else if (itemOf(v, s)) s.today[k] = v
      }
      save(s)
      return { ok: true, today: s.today, outfit: outfitText(s) }
    }

    async function preview(poseKey) {
      const s = load()
      const prompt = buildPrompt(poseKey, s)
      const ig = api.use('imagegen')
      if (!ig || typeof ig.generate !== 'function') return { ok: false, message: '生图模块没开' }
      const provider = String(api.config().imageGen && api.config().imageGen.provider || '')
      // 能带参考图的服务，用当前上衣的参考图；Codex 不支持，直接文字
      let ref = null
      if (provider !== 'codex') {
        const top = itemOf(s.today.top, s) || (s.items || [])[0]
        if (top) {
          try { ref = readFileSync(join(imgDir(), top.image)) } catch (error) { ref = null }
        }
      }
      let buf
      try {
        buf = await ig.generate(prompt, { shape: 'portrait', image: ref || undefined })
      } catch (error) {
        if (ref) {
          // 带图失败就退回纯文字
          try { buf = await ig.generate(prompt, { shape: 'portrait' }) } catch (error2) { return { ok: false, message: '生图失败：' + error2.message } }
        } else {
          return { ok: false, message: '生图失败：' + error.message }
        }
      }
      mkdirSync(prevDir(), { recursive: true })
      const id = 'p_' + Date.now()
      writeFileSync(join(prevDir(), id + '.png'), buf)
      const s2 = load()
      s2.history = [{ id, at: Date.now(), pose: String(poseKey || 'stand'), prompt, outfit: outfitText(s2), usedReference: Boolean(ref) }, ...(s2.history || [])].slice(0, 60)
      save(s2)
      return { ok: true, id, prompt, usedReference: Boolean(ref) }
    }


    // 穿搭进上下文：挂在 persona 上（不改人格文件），用第三人称写成背景，
    // 这样她是“知道自己今天穿什么”，而不是收到一条要执行的指令。
    api.on('persona', (text) => {
      if (!cfg().enabled) return text
      const s = load()
      const outfit = outfitText(s)
      if (!outfit) return text
      return String(text || '') + '\n\n【当前的穿着】\n' + outfit + '。\n画自己的时候，这段穿着原样写进画面描述，别改写、别漏配饰。'
    })
    const sendImage = (res, buf, type) => {
      res.statusCode = 200
      res.setHeader?.('content-type', type || 'image/png')
      res.setHeader?.('cache-control', 'no-store')
      res.end?.(buf)
    }
    seedOnce()

    api.route('/list', async () => {
      const s = load()
      return {
        ok: true,
        items: s.items,
        today: s.today,
        outfit: outfitText(s),
        base: String(s.base || '') || DEFAULT_BASE,
        style: String(s.style || '') || DEFAULT_STYLE,
        poses: Object.entries(POSES).map(([k, v]) => ({ key: k, name: v.name })),
      }
    })
    api.route('/appearance/save', async (req) => {
      const b = await api.core.http.body(req)
      const s = load()
      if (typeof b.base === 'string') s.base = b.base.trim().slice(0, 300)
      if (typeof b.style === 'string') s.style = b.style.trim().slice(0, 160)
      save(s)
      return { ok: true, base: s.base, style: s.style }
    })
    api.route('/add', async (req) => {
      const b = await api.core.http.body(req)
      return addItem(b)
    })
    api.route('/image/replace', async (req) => {
      const b = await api.core.http.body(req)
      return replaceImage(b || {})
    })
    api.route('/update', async (req) => {
      const b = await api.core.http.body(req)
      return updateItem(b || {})
    })
    api.route('/clear', async () => clearAll())
    api.route('/del', async (req) => {
      const b = await api.core.http.body(req)
      return removeItem(String(b.id || ''))
    })
    api.route('/today', async (req) => {
      const b = await api.core.http.body(req)
      return setToday(b || {})
    })
    api.route('/preview', async (req) => {
      const b = await api.core.http.body(req)
      return preview(String(b.pose || 'stand'))
    })
    api.route('/open-folder', async () => {
      const d = prevDir()
      mkdirSync(d, { recursive: true })
      const opts = { detached: true, stdio: 'ignore' }
      if (process.platform === 'win32') spawn('explorer.exe', [d], opts).unref()
      else if (process.platform === 'darwin') spawn('open', [d], opts).unref()
      else spawn('xdg-open', [d], opts).unref()
      return { ok: true, dir: d }
    })
    api.route('/history', async () => {
      const s = load()
      return { ok: true, list: (s.history || []).map((h) => ({ ...h, poses: POSES[h.pose] ? POSES[h.pose].name : h.pose })) }
    })
    api.route('/preview/del', async (req) => {
      const b = await api.core.http.body(req)
      const id = String(b.id || '')
      const s = load()
      s.history = (s.history || []).filter((h) => h.id !== id)
      save(s)
      try { unlinkSync(join(prevDir(), id + '.png')) } catch (error) { /* 文件不在就算了 */ }
      return { ok: true }
    })
    api.route('/preview/file', async (req, res) => {
      const id = String(api.core.http.query(req).id || '')
      if (!/^p_\d+$/.test(id)) return { ok: false, message: 'id 不对' }
      try { return sendImage(res, readFileSync(join(prevDir(), id + '.png'))) } catch (error) { return { ok: false, message: '没有这张图' } }
    })
    api.route('/image/file', async (req, res) => {
      const id = String(api.core.http.query(req).id || '')
      const it = itemOf(id)
      if (!it) return { ok: false, message: '没这件' }
      try { return sendImage(res, readFileSync(join(imgDir(), it.image)), it.mediaType) } catch (error) { return { ok: false, message: '图没了' } }
    })
  },
}
