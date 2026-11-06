// Breeze Blue 在线语音：设置放在面板「语音」页最下面。
// 语音模块（modules/voice）合成时来问我一句 ttsOptions()，返回 null 就走它原来的引擎。
// 另外带一个每日自动签到（领 400 免费积分）：到点试一次，DSH 那时候没开就在启动时补一次。
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'

export default {
  id: 'breeze',
  name: 'Breeze 语音',
  version: '1.2.0',
  api: 1,
  description: 'Breeze Blue 在线文字转语音 + 每日自动签到领积分',
  tab: 'voice',
  panel: 'panel.js',
  defaults: {
    on: true,
    apiKey: '',
    voiceId: '',
    model: 'breeze-tts-2',
    language: 'zh',
    instructions: '',
    checkinOn: true,
    checkinTime: '08:10',
    notifyCheckin: true,
    browserPath: '',
  },
  setup(api) {
    /** 给语音模块用：返回 null = 不接管，用原来的引擎 */
    function ttsOptions() {
      const s = api.settings() || {}
      if (!s.on) return null
      const apiKey = String(s.apiKey || '').trim()
      const voiceId = String(s.voiceId || '').trim()
      if (!apiKey || !voiceId) return null
      return {
        engine: 'breeze',
        breeze: {
          url: 'https://api.breeze.blue',
          apiKey,
          voiceId,
          modelId: String(s.model || 'breeze-tts-2').trim(),
          language: String(s.language || 'zh').trim(),
          instructions: String(s.instructions || ''),
          outputFormat: 'mp3_24000_128',
        },
      }
    }

    // ---- 每日签到 ----
    const stateFile = join(api.dataDir(), 'checkin.json')
    const readState = () => {
      try {
        return JSON.parse(readFileSync(stateFile, 'utf8'))
      } catch {
        return {}
      }
    }
    const writeState = (o) => {
      try {
        mkdirSync(api.dataDir(), { recursive: true })
        writeFileSync(stateFile, JSON.stringify(o, null, 2))
      } catch (error) {
        api.log.warn('签到状态写不进去：', error.message)
      }
    }
    const today = () => {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    }
    /** 设置里的签到时间，形如 '08:10' */
    const checkinTime = () => String((api.settings() || {}).checkinTime || '08:10').trim() || '08:10'
    /** 'HH:MM' → [小时, 分钟] */
    const hm = (at) => String(at || '08:10').split(':').map((x) => Number(x) || 0)
    /** 'HH:MM' → 分钟数，用来比较早晚（'9:00' 和 '08:10' 直接比字符串会错） */
    const toMinutes = (at) => {
      const [h, m] = hm(at)
      return h * 60 + m
    }
    const nowMinutes = () => {
      const d = new Date()
      return d.getHours() * 60 + d.getMinutes()
    }

    /** 登录态只认模块数据夹里的 cookie.txt（自动抓的时候写进去） */
    function loginCookie() {
      try {
        return readFileSync(join(api.dataDir(), 'cookie.txt'), 'utf8').trim()
      } catch {
        return ''
      }
    }

    /** 真去领一次。返回 { ok, message, balance? } */
    async function claim() {
      const cookie = loginCookie()
      if (!cookie) return { ok: false, message: '还没抓到登录 Cookie，先在面板点一下「登录」' }
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'Mozilla/5.0',
        origin: 'https://breezeblue.ai',
        referer: 'https://breezeblue.ai/zh/app',
        cookie,
      }
      try {
        const res = await fetch('https://breezeblue.ai/api/credits/daily-claim', {
          method: 'POST',
          headers,
          body: '{}',
          signal: AbortSignal.timeout(20000),
        })
        const text = await res.text()
        if (!res.ok) {
          api.log.warn(`签到失败 HTTP ${res.status}：${text.slice(0, 300)}`)
          return { ok: false, message: `HTTP ${res.status} ${text.slice(0, 200)}` }
        }
        let data = {}
        try {
          data = JSON.parse(text)
        } catch {}
        const got = data.credits_issued ?? data.credits ?? data.amount
        let msg = '领好了'
        if (data.claimed && got) msg = `领到 ${got} 积分`
        else if (data.already_claimed || data.daily_claim_available === false) msg = '今天已经领过了'
        else if (data.claimed === false && !got) msg = '这次没领到（可能已经领过）'
        else if (data.message) msg = String(data.message).slice(0, 80)
        const balance = typeof data.balance === 'number' ? `（余额 ${Math.round(data.balance)}）` : ''
        api.log.info('签到：' + msg + balance)
        if (data.claimed && (api.settings() || {}).notifyCheckin !== false) {
          const b = typeof data.balance === 'number' ? `，余额 ${Math.round(data.balance)}` : ''
          notifyOwner('Breeze 今日已签到成功' + b)
        }
        return { ok: true, message: msg + balance, balance: typeof data.balance === 'number' ? Math.round(data.balance) : null }
      } catch (error) {
        api.log.warn('签到出错：', error.message)
        return { ok: false, message: error.message }
      }
    }

    function notifyOwner(text) {
      try {
        const qq = api.config().ownerQQ
        if (qq) api.sendText(`private:${qq}`, text)
      } catch (error) {
        api.log.warn('签到结果发不出去：', error.message)
      }
    }

    const RETRY_MS = 5 * 60 * 1000
    const MAX_TRIES = 3

    /** 到点没领过就领；启动时也补一次；没成功 5 分钟后再试，一天最多三次 */
    async function tick(reason) {
      const s = api.settings() || {}
      if (!s.checkinOn) return
      const st = readState()
      if (st.done === today()) return
      if (!loginCookie()) return
      if (nowMinutes() < toMinutes(checkinTime())) return
      const tried = st.day === today() ? st.tries || 0 : 0
      if (tried >= MAX_TRIES) return
      const r = await claim()
      markDone(r.ok, r.message, reason)
      if (r.ok) return
      if (tried + 1 < MAX_TRIES) {
        api.log.warn(`签到没成功（今天第 ${tried + 1} 次），5 分钟后再试：` + r.message)
        api.later(RETRY_MS, () => tick('retry'))
      } else {
        api.log.warn(`签到今天试了 ${tried + 1} 次都没成，明天再说：` + r.message)
        if ((api.settings() || {}).notifyCheckin !== false) {
          notifyOwner(`Breeze 今天签到没成功：${r.message}。可能登录过期了，去面板点「登录」重新登一次`)
        }
      }
    }

    /** 记一笔这次的结果（顺便数今天试了几次） */
    function markDone(ok, message, reason) {
      const cur = readState()
      const d = today()
      const next = {
        ...cur,
        lastTry: new Date().toISOString(),
        lastResult: message,
        day: d,
        tries: cur.day === d ? (cur.tries || 0) + 1 : 1,
      }
      if (reason) next.lastReason = reason
      if (ok) next.done = d
      writeState(next)
    }

    /** 距下一个签到时间还有多少毫秒 */
    function msUntil(at) {
      const [h, m] = hm(at)
      const now = new Date()
      const next = new Date(now)
      next.setHours(h, m, 0, 0)
      if (next <= now) next.setDate(next.getDate() + 1)
      return next - now
    }

    /** 每天到点只醒一次，不轮询；改过签到时间就重排（旧的那个认 token 自己退场，不会越堆越多） */
    let scheduleToken = 0
    function scheduleNext() {
      const token = ++scheduleToken
      api.later(msUntil(checkinTime()), async () => {
        if (token !== scheduleToken) return
        await tick('timer')
        scheduleNext()
      })
    }
    scheduleNext()

    api.on('config', (next, before) => {
      const a = (before && before.ext && before.ext.breeze) || {}
      const b = (next && next.ext && next.ext.breeze) || {}
      if (a.checkinTime !== b.checkinTime || a.checkinOn !== b.checkinOn) scheduleNext()
    })
    // 启动时补一次（昨天没开 DSH 的情况）
    api.later(8000, () => tick('startup'))

    // ---------- 登录并抓 cookie：按需开一次 Chrome，抽完就关 ----------
    const PORT_FROM = 9333
    const PORT_TO = 9343
    let debugPort = 0

    /** 找浏览器：面板里填的优先，其次常见安装位置（Chrome → Edge → 其他 Chromium） */
    function findBrowser() {
      const fromPanel = String((api.settings() || {}).browserPath || '').trim()
      if (fromPanel && existsSync(fromPanel)) return fromPanel
      const env = process.env
      const bases = [
        ['Google\\Chrome\\Application\\chrome.exe', env.PROGRAMFILES],
        ['Google\\Chrome\\Application\\chrome.exe', env['PROGRAMFILES(X86)']],
        ['Google\\Chrome\\Application\\chrome.exe', env.LOCALAPPDATA],
        ['Microsoft\\Edge\\Application\\msedge.exe', env.PROGRAMFILES],
        ['Microsoft\\Edge\\Application\\msedge.exe', env['PROGRAMFILES(X86)']],
      ]
      const list = bases.filter(([, base]) => base).map(([rel, base]) => join(base, rel))
      list.push(
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      )
      for (const p of list) {
        try {
          if (existsSync(p)) return p
        } catch {}
      }
      return ''
    }

    function chromeDir() {
      const dir = join(api.dataDir(), 'browser')
      mkdirSync(dir, { recursive: true })
      return dir
    }

    async function debugJson(path) {
      if (!debugPort) throw new Error('还没找到调试端口')
      const res = await fetch(`http://127.0.0.1:${debugPort}${path}`, { signal: AbortSignal.timeout(3000) })
      return res.json()
    }

    /** 上次开的那个窗口还活着吗？活着就沿用它的端口，别再 spawn 一个同配置的 */
    async function findExistingPort() {
      for (let p = PORT_FROM; p <= PORT_TO; p++) {
        try {
          const res = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: AbortSignal.timeout(800) })
          if (!res.ok) continue
          const v = await res.json()
          if (v?.webSocketDebuggerUrl) return p
        } catch {}
      }
      return 0
    }

    /** 这个端口能不能拿来监听（true = 空着） */
    function portFree(port) {
      return new Promise((resolve) => {
        const srv = net.createServer()
        srv.once('error', () => resolve(false))
        srv.once('listening', () => srv.close(() => resolve(true)))
        srv.listen(port, '127.0.0.1')
      })
    }

    /** 挑一个空闲端口给浏览器调试用 */
    async function pickPort() {
      for (let p = PORT_FROM; p <= PORT_TO; p++) {
        if (await portFree(p)) return p
      }
      throw new Error(`${PORT_FROM}-${PORT_TO} 都被占着，腾一个出来再试`)
    }

    function cdpCall(ws, id, method, params) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 20000)
        const onMsg = (event) => {
          let m
          try {
            m = JSON.parse(event.data)
          } catch {
            return
          }
          if (m.id !== id) return
          clearTimeout(timer)
          try {
            ws.removeEventListener('message', onMsg)
          } catch {}
          resolve(m)
        }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id, method, params }))
      })
    }

    /** 起 Chrome（带专用配置目录 + 调试端口）；上一次开的还活着就直接用 */
    async function startBrowser() {
      const alive = await findExistingPort()
      if (alive) {
        debugPort = alive
        return { reused: true }
      }
      const browser = findBrowser()
      if (!browser) throw new Error('没找到 Chrome 或 Edge，可以在设置里手填浏览器路径')
      debugPort = await pickPort()
      const child = spawn(
        browser,
        [
          `--remote-debugging-port=${debugPort}`,
          `--user-data-dir=${chromeDir()}`,
          '--no-first-run',
          '--no-default-browser-check',
          'https://breezeblue.ai/zh/auth/login',
        ],
        { detached: true, stdio: 'ignore' },
      )
      child.on('error', (error) => api.log.warn('[breeze] 浏览器起不来：', error.message))
      child.unref()
      for (let i = 0; i < 40; i++) {
        try {
          const v = await debugJson('/json/version')
          if (v?.webSocketDebuggerUrl) return { reused: false }
        } catch {}
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('Chrome 20 秒内没开出调试端口')
    }

    /** 把那个登录窗口关掉（连不上就算了） */
    async function closeBrowser() {
      try {
        const v = await debugJson('/json/version')
        if (!v?.webSocketDebuggerUrl) return
        const ws = new WebSocket(v.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => {
          ws.onopen = resolve
          ws.onerror = () => reject(new Error('连不上'))
        })
        ws.send(JSON.stringify({ id: 98, method: 'Browser.close', params: {} }))
        setTimeout(() => {
          try {
            ws.close()
          } catch {}
        }, 500)
      } catch {}
    }

    /** 读出 breezeblue.ai 的 cookie（能读到 HttpOnly）；关不关窗口由调用方决定 */
    async function grabCookies() {
      const v = await debugJson('/json/version')
      if (!v?.webSocketDebuggerUrl) throw new Error('没有调试地址')
      const ws = new WebSocket(v.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        ws.onopen = resolve
        ws.onerror = () => reject(new Error('连不上调试端口'))
      })
      let list = []
      try {
        const r = await cdpCall(ws, 1, 'Storage.getCookies', {})
        list = r?.result?.cookies || []
      } catch (error) {
        api.log.debug('[breeze] Storage.getCookies 失败：', error.message)
      }
      if (!list.length) {
        try {
          const r = await cdpCall(ws, 2, 'Network.getAllCookies', {})
          list = r?.result?.cookies || []
        } catch (error) {
          api.log.debug('[breeze] Network.getAllCookies 失败：', error.message)
        }
      }
      try {
        ws.close()
      } catch {}
      const now = Date.now() / 1000
      return list
        .filter((c) => String(c.domain || '').includes('breezeblue.ai'))
        .filter((c) => !c.expires || c.expires > now)
        .map((c) => `${c.name}=${c.value}`)
    }

    const SESSION_KEY = 'breeze_blue_session='

    function looksLoggedIn(parts) {
      return parts.some((p) => p.startsWith(SESSION_KEY) && p.length > SESSION_KEY.length + 5)
    }

    let watching = false
    // 退出登录 / 重新登录会换一代，正在盯着的那轮就自己退场，免得退出后又冒出「还没登录」的提示
    let loginGen = 0

    /** 开完窗口后盯着 cookie：一出现登录态就存下来、领一次、关窗口 */
    async function watchLogin(maxMs) {
      if (watching) return
      watching = true
      const gen = loginGen
      const started = Date.now()
      try {
        while (Date.now() - started < maxMs) {
          if (gen !== loginGen) return
          await new Promise((r) => setTimeout(r, 2000))
          let parts = []
          try {
            parts = await grabCookies()
          } catch (error) {
            api.log.debug('[breeze] 等待登录时读不到 cookie：', error.message)
            continue
          }
          if (!looksLoggedIn(parts)) continue
          const msg = await saveAndClaim(parts)
          notifyOwner('Breeze ' + msg)
          api.log.info('[breeze] 自动抓取完成：' + msg)
          return
        }
        notifyOwner('Breeze 登录窗口开了 5 分钟还没看到登录，先不等了；要是已经登好了，再点一次「登录」就会直接抓')
      } catch (error) {
        api.log.warn('[breeze] 自动抓取出错：', error.message)
      } finally {
        watching = false
      }
    }

    /** 存下 cookie、关掉窗口、顺手领一次 */
    async function saveAndClaim(parts) {
      const cookie = parts.join('; ')
      try {
        mkdirSync(api.dataDir(), { recursive: true })
        writeFileSync(join(api.dataDir(), 'cookie.txt'), cookie, 'utf8')
      } catch (error) {
        api.log.warn('cookie.txt 写不进去：', error.message)
        return 'cookie 存不进去：' + error.message
      }
      await closeBrowser()
      const r = await claim()
      markDone(r.ok, r.message, 'login')
      if (!r.ok) return '登录好了，但今天没签到成功：' + r.message
      return r.balance == null ? '今日已签到成功' : `今日已签到成功，余额 ${r.balance}`
    }

    async function doLogin() {
      const r = await startBrowser()
      // 已经登录过就直接抓；否则盯着等他登
      let parts = []
      try {
        parts = await grabCookies()
      } catch (error) {
        api.log.debug('[breeze] 打开后读 cookie 失败：', error.message)
      }
      if (looksLoggedIn(parts)) {
        const msg = await saveAndClaim(parts)
        return '本来就已经登录着。' + msg
      }
      watchLogin(5 * 60 * 1000)
      return r.reused ? '登录窗口开着呢，登进去以后我自动抓' : '登录窗口开好了，登录完我会自己抓，不用再点'
    }

    api.route('/login', async () => {
      try {
        return { ok: true, message: await doLogin() }
      } catch (error) {
        return { ok: false, message: '开不了浏览器：' + error.message }
      }
    })

    /** 退出登录：清掉 cookie，顺手把那个登录用的浏览器配置目录也清空（换个号才连得上新账号） */
    async function logout() {
      loginGen++
      watching = false
      await closeBrowser()
      await new Promise((r) => setTimeout(r, 800))
      try {
        unlinkSync(join(api.dataDir(), 'cookie.txt'))
      } catch {}
      try {
        rmSync(chromeDir(), { recursive: true, force: true })
      } catch (error) {
        api.log.warn('[breeze] 浏览器配置目录没删干净：', error.message)
      }
      writeState({ ...readState(), lastResult: '已退出登录', lastReason: 'logout' })
      api.log.info('[breeze] 已退出登录，cookie 和浏览器配置都清了')
    }

    api.route('/logout', async () => {
      try {
        await logout()
        return { ok: true, message: '已经退出登录，cookie 删了；要换号就再点「登录」' }
      } catch (error) {
        return { ok: false, message: '退出没干净：' + error.message }
      }
    })

    api.route('/checkin', async () => {
      const r = await claim()
      markDone(r.ok, r.message, 'manual')
      return { ok: r.ok, message: r.ok ? r.message : '没成功：' + r.message }
    })

    api.route('/status', async () => {
      const st = readState()
      return { ok: true, hasCookie: Boolean(loginCookie()), checkin: st }
    })

    return { ttsOptions, claim }
  },
}
