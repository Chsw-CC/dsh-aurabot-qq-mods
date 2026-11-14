import { TONES, toneOf, applyTone, DEFAULT_TONE } from './tones.js'

// ---------- 本地状态 ----------
const LS = {
  host: 'pocket.host',
  token: 'pocket.token',
  tone: 'pocket.tone',
  toneLocal: 'pocket.tone.local',
}

const S = {
  // 过一遍 normalizeHost：老版本存的是 192.168.1.5:7788 这种没协议的，升级后自动补成 http://…
  hosts: String(localStorage.getItem(LS.host) || '')
    .split(/[,，;；\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => normalizeHost(x))
    .filter(Boolean),
  host: '',
  token: localStorage.getItem(LS.token) || '',
  tone: localStorage.getItem(LS.tone) || DEFAULT_TONE,
  toneLocal: localStorage.getItem(LS.toneLocal) === '1',
  seq: 0,
  msgs: [],
  pending: 0,
  polling: null,
  online: true,
  state: null,
  playing: null,
  img: null, // 待发送的图片 { dataUrl, b64 }
  recording: false,
  recStart: 0,
  playingText: '',
}
S.host = S.hosts[0] || ''

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

// 从地址栏接管密钥/地址（扫码或 APK 首启带过来）
function takeFromUrl() {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  const token = h.get('token') || q.get('token')
  const host = h.get('host') || q.get('host')
  if (host) {
    const list = hostList(host)
    if (list.length) {
      const clean = list.join(',')
      localStorage.setItem(LS.host, clean)
      S.hosts = list
      S.host = list[0]
    }
  }
  if (token) {
    localStorage.setItem(LS.token, token)
    S.token = token
  }
  if (token || host) {
    try {
      history.replaceState(null, '', location.pathname)
    } catch {}
  }
}

/**
 * 把用户填的东西变成完整 origin（含协议），比如：
 *   192.168.1.5            → http://192.168.1.5:7788
 *   100.88.1.2:7788        → http://100.88.1.2:7788
 *   [240e:3b0::12]:7788    → http://[240e:3b0::12]:7788   （IPv6 直连，手机 4G/5G 也能通）
 *   https://pocket.xx.com  → https://pocket.xx.com        （Cloudflare Tunnel 之类给的域名）
 */
function normalizeHost(v) {
  let s = String(v || '').trim()
  if (!s) return ''
  let scheme = ''
  const m = s.match(/^(https?):\/\//i)
  if (m) {
    scheme = m[1].toLowerCase()
    s = s.slice(m[0].length)
  }
  s = s.replace(/\/+$/, '')
  if (!s) return ''
  // 手打的逗号/冒号残渣：[240e::1]: → [240e::1]；240e::1: → 240e::1（但不碰合法的 ::）
  if (s.endsWith(']:')) s = s.slice(0, -1)
  if (!s.endsWith(']') && s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1)
  // 裸 IPv6（冒号两个以上又没方括号）→ 补方括号
  if (!s.startsWith('[') && (s.match(/:/g) || []).length >= 2) s = '[' + s + ']'
  const hasPort = /^\[[^\]]+\]:\d+$/.test(s) || /^[^[\]]+:\d+$/.test(s)
  // https 域名（Cloudflare Tunnel 之类）走 443，不加端口；其余默认补 7788
  if (!hasPort && scheme !== 'https') s += ':7788'
  return `${scheme || 'http'}://${s}`
}

/** 地址框里的多个地址（逗号/空格隔开）→ 数组；家里填局域网地址，外面填 IPv6 / 域名 / Tailscale，全都填上就自动挑能通的 */
function hostList(v) {
  return String(v || '')
    .split(/[,，;；\s]+/)
    .map((x) => normalizeHost(x))
    .filter(Boolean)
}

/** S.host 存的是完整 origin，直接用 */
const base = () => (S.host ? S.host.replace(/\/+$/, '') : location.origin)

/** 当前地址连不上时，挨个试其它候选，谁通用谁（家里 WiFi ↔ 外面 4G/5G 自动切换） */
async function switchHost() {
  for (const cand of S.hosts) {
    if (cand === S.host) continue
    try {
      const r = await fetch(`${cand}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (r.ok) {
        S.host = cand
        S.hosts = [cand, ...S.hosts.filter((x) => x !== cand)]
        localStorage.setItem(LS.host, S.hosts.join(','))
        return true
      }
    } catch {}
  }
  return false
}

async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
  const one = async () => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const res = await fetch(base() + path, {
        method,
        signal: ctl.signal,
        headers: {
          'x-pocket-token': S.token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      })
      if (res.status === 401) {
        const e = new Error('密钥不对')
        e.code = 401
        throw e
      }
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('json')) return res
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    return await one()
  } catch (e) {
    // 网络不通（不是密钥错）：先换个地址试一次，还在家/在外网不同地址间自动切换
    if (e.code === 401) throw e
    if (S.hosts.length > 1 && (await switchHost())) return await one()
    throw e
  }
}

// ---------- 视图 ----------
function show(view) {
  for (const v of $$('.view')) v.hidden = v.id !== 'view-' + view
  $('#tabbar').hidden = view === 'pair'
  if (view !== 'pair') {
    for (const b of $$('#tabbar button')) b.classList.toggle('on', b.dataset.tab === view)
  }
}

// ---------- 配色（只改界面，不动图标） ----------
const AVATAR = 'icons/avatar.png'

function paintTone(id, { persist = false } = {}) {
  const t = applyTone(id)
  S.tone = t.id
  $$('.tone').forEach((b) => b.classList.toggle('on', b.dataset.tone === t.id))
  if (persist) {
    localStorage.setItem(LS.tone, t.id)
    if (!S.toneLocal && S.token) api('/api/tone', { method: 'POST', body: { tone: t.id } }).catch(() => {})
  }
}

function buildToneGrid() {
  const grid = $('#tone-grid')
  grid.innerHTML = ''
  for (const t of TONES) {
    const b = document.createElement('button')
    b.className = 'tone'
    b.dataset.tone = t.id
    b.innerHTML = `<span class="sw" style="background:linear-gradient(135deg,${t.gradA},${t.gradB})"></span><span>${t.name}</span>`
    b.onclick = () => paintTone(t.id, { persist: true })
    grid.appendChild(b)
  }
  $('#tone-local').checked = S.toneLocal
  $('#tone-local').onchange = (e) => {
    S.toneLocal = e.target.checked
    localStorage.setItem(LS.toneLocal, S.toneLocal ? '1' : '0')
  }
}

// ---------- 聊天 ----------
function fmtTime(ts) {
  const d = new Date(ts || Date.now())
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const same = (a, b) => a.toDateString() === b.toDateString()
  if (same(d, today)) return '今天'
  const y = new Date(today.getTime() - 86400000)
  if (same(d, y)) return '昨天'
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

/** 她的话里可能带 <voice> / <sticker:名字> / [voice] 占位 / [沉默]，拆干净 */
function parseReply(text) {
  let t = String(text || '')
  const hasVoice = /<voice>/i.test(t)
  t = t.replace(/<voice>[\s\S]*?<\/voice>/gi, '').replace(/<\/?voice>/gi, '')
  t = t.replace(/<sticker:[^>]*>/gi, '')
  t = t.replace(/\[(sticker|表情|voice)\]/gi, '')
  t = t.replace(/\[沉默\]/g, '')
  return { text: t.trim(), hasVoice }
}

const nearBottom = () => {
  const el = $('#chat-list')
  return el.scrollHeight - el.scrollTop - el.clientHeight < 90
}
function scrollBottom(force) {
  const el = $('#chat-list')
  if (force || nearBottom()) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
}

function addMsg({ who, text, at, voice, image, audio, audioMime }, { animate = true } = {}) {
  const list = $('#chat-list')
  const el = document.createElement('div')
  el.className = 'msg ' + (who === 'me' ? 'me' : 'her')

  if (who !== 'me') {
    const ava = document.createElement('img')
    ava.className = 'ava'
    ava.src = AVATAR
    el.appendChild(ava)
  }
  const b = document.createElement('div')
  b.className = 'bubble'
  if (image) {
    const im = document.createElement('img')
    im.className = 'bubble-img'
    im.src = image
    im.alt = '图片'
    im.onclick = () => window.open(image, '_blank')
    b.appendChild(im)
  }
  if (text) b.appendChild(document.createTextNode(text))
  if (audio) {
    const vb = document.createElement('button')
    vb.className = 'voice-btn'
    vb.textContent = '▶ 语音条'
    vb.onclick = () => playBlob(b, vb, audio)
    b.appendChild(vb)
  } else if (voice && who !== 'me') {
    const vb = document.createElement('button')
    vb.className = 'voice-btn'
    vb.textContent = '🔊 听她说'
    vb.onclick = () => playVoice(b, text)
    b.appendChild(vb)
  }
  const st = document.createElement('span')
  st.className = 'stamp'
  st.textContent = fmtTime(at)
  b.appendChild(st)
  el.appendChild(b)
  if (!animate) el.style.animation = 'none'
  list.appendChild(el)
  return el
}

function pushMsg(m) {
  S.msgs.push(m)
  addMsg(m)
  scrollBottom()
}

async function loadHistory() {
  try {
    const r = await api('/api/history?days=7')
    if (!r || !r.ok) return
    const list = r.list || []
    let lastDay = ''
    for (const m of list) {
      const d = dayLabel(m.at)
      if (d !== lastDay) {
        lastDay = d
        const div = document.createElement('div')
        div.className = 'day-divider'
        div.textContent = d
        $('#chat-list').appendChild(div)
      }
      S.msgs.push(m)
      addMsg({ ...m, text: parseReply(m.text).text }, { animate: false })
    }
    scrollBottom(true)
  } catch (e) {
    handleErr(e)
  }
}

async function send() {
  const input = $('#chat-input')
  const text = input.value.trim()
  const img = S.img
  if (!text && !img) return
  input.value = ''
  autoGrow()
  clearImgPreview()
  $('#emoji-panel').hidden = true // 发出去了就把面板收起来
  const at = Date.now()
  addMsg({ who: 'me', text, image: img && img.dataUrl, at })
  S.msgs.push({ who: 'me', text: text || (img ? '[图片]' : ''), at })
  scrollBottom(true)
  S.pending = at
  $('#typing').hidden = false
  try {
    const r = await api('/api/message', { method: 'POST', body: { text, image: img ? img.b64 : undefined }, timeout: 30000 })
    if (r && r.ok === false) throw new Error(r.message || '发不出去')
  } catch (e) {
    S.pending = 0
    $('#typing').hidden = true
    addSysToast('没送到她那儿：' + (e.message || '网络不通'))
    handleErr(e)
  }
}

async function playVoice(bubbleEl, text) {
  // 正在放的是同一条 → 停掉就行
  if (S.playing && S.playingText === text) {
    S.playing.pause()
    if (S.stopPlaying) S.stopPlaying()
    return
  }
  stopPlaying()
  const btn = bubbleEl.querySelector('.voice-btn')
  const old = btn.textContent
  btn.textContent = '…合成中'
  try {
    const res = await fetch(`${base()}/api/voice?text=${encodeURIComponent(text)}&token=${encodeURIComponent(S.token)}`)
    if (!res.ok || !(res.headers.get('content-type') || '').includes('audio')) {
      const j = await res.json().catch(() => ({}))
      throw new Error(j.message || '语音没合成出来')
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    S.playing = audio
    S.playingText = text
    bubbleEl.classList.add('playing')
    btn.textContent = '■ 播放中'
    audio.onended = cleanupPlaying
    audio.onerror = cleanupPlaying
    S.stopPlaying = cleanupPlaying
    await audio.play()
    function cleanupPlaying() {
      bubbleEl.classList.remove('playing')
      btn.textContent = old
      S.playing = null
      S.playingText = ''
      S.stopPlaying = null
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    btn.textContent = old
    addSysToast(e.message || '语音失败')
  }
}

/** 停掉当前在放的那条（不营是真实语音条还是合成的），并把它的按钮恢复 */
function stopPlaying() {
  if (S.playing) {
    try { S.playing.pause() } catch {}
    S.playing = null
  }
  if (S.stopPlaying) {
    const f = S.stopPlaying
    S.stopPlaying = null
    f()
  }
}

/** 放她发来的真实语音条（send 钩子抓的原始音频，data:URL）；按钮状态跟 playVoice 一致 */
function playBlob(bubbleEl, btn, src) {
  if (S.playing && S.playingSrc === src) {
    S.playing.pause()
    if (S.stopPlaying) S.stopPlaying()
    return
  }
  stopPlaying()
  const old = btn.textContent
  const audio = new Audio(src)
  S.playing = audio
  S.playingSrc = src
  S.playingText = ''
  bubbleEl.classList.add('playing')
  btn.textContent = '■ 播放中'
  const cleanup = () => {
    bubbleEl.classList.remove('playing')
    btn.textContent = old
    if (S.playing === audio) {
      S.playing = null
      S.playingSrc = ''
    }
    S.stopPlaying = null
  }
  S.stopPlaying = cleanup
  audio.onended = cleanup
  audio.onerror = () => {
    cleanup()
    addSysToast('这条语音放不出来')
  }
  audio.play().catch(() => {})
}

/** 屏幕下方的浮动提示（设置页也能看见，不像聊天里的系统气泡） */
let toastTimer = 0
function toast(text) {
  let el = $('#toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'toast'
    el.className = 'toast glass'
    $('#app').appendChild(el)
  }
  el.textContent = text
  el.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('on'), 2200)
}

// ---------- 换她的形象（从相册） ----------
function pickAvatar() {
  $('#avatar-file').click()
}

async function onAvatarPicked(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  toast('正在处理这张图…')
  try {
    const r = await compressAvatar(f)
    const res = await api('/api/avatar', { method: 'POST', body: { image: r.dataUrl }, timeout: 60000 })
    if (!res || res.ok === false) throw new Error((res && res.message) || '没换成功')
    refreshAvatars()
    toast('形象换好啦')
  } catch (err) {
    toast('这张换不了：' + (err.message || err))
  }
}

/** 压到 1024px、转 jpeg：图片不会太大，透明 PNG 铺白底免得变黑 */
function compressAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const MAX = 1024
        let w = img.naturalWidth
        let h = img.naturalHeight
        if (!w || !h) throw new Error('读不到尺寸')
        if (Math.max(w, h) > MAX) {
          const k = MAX / Math.max(w, h)
          w = Math.round(w * k)
          h = Math.round(h * k)
        }
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const g = c.getContext('2d')
        g.fillStyle = '#ffffff'
        g.fillRect(0, 0, w, h)
        g.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        resolve({ dataUrl: c.toDataURL('image/jpeg', 0.9) })
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('不是能读的图片'))
    }
    img.src = url
  })
}

/** 换完给所有头像加个时间戳，绕过缓存 */
function refreshAvatars() {
  const v = Date.now()
  for (const im of $$('img')) {
    const s = im.getAttribute('src') || ''
    if (s.indexOf('icons/avatar.png') === 0) im.src = 'icons/avatar.png?v=' + v
  }
}

async function resetAvatar() {
  try {
    const res = await api('/api/avatar', { method: 'DELETE' })
    if (!res || res.ok === false) throw new Error((res && res.message) || '没恢复成')
    refreshAvatars()
    toast('换回默认形象了')
  } catch (e) {
    toast('没恢复成：' + (e.message || e))
  }
}

function addSysToast(text) {
  const el = document.createElement('div')
  el.className = 'day-divider'
  el.textContent = text
  $('#chat-list').appendChild(el)
  scrollBottom()
  setTimeout(() => el.remove(), 6000)
}

// ---------- 发图片 ----------
function pickImage() { $('#chat-file').click() }

function onFilePicked(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  compressImage(f)
    .then((r) => {
      S.img = r
      const im = $('#img-preview-img')
      im.src = r.dataUrl
      $('#img-preview-size').textContent = kb(r.b64.length) + ' · 点发送一起发出去'
      $('#img-preview').hidden = false
      scrollBottom(true) // 预览条占了一块高度，把最后一条消息顶上去
    })
    .catch((err) => addSysToast('图片读不出来：' + (err.message || err)))
}

const kb = (b64len) => {
  const n = Math.round((b64len * 3) / 4 / 1024)
  return n > 1024 ? (n / 1024).toFixed(1) + ' MB' : n + ' KB'
}

/** 压到 1280px / jpeg 0.85，手机照片也不会超过几百 KB */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      try {
        const MAX = 1280
        let w = img.naturalWidth, h = img.naturalHeight
        if (Math.max(w, h) > MAX) {
          const k = MAX / Math.max(w, h)
          w = Math.round(w * k)
          h = Math.round(h * k)
        }
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        c.getContext('2d').drawImage(img, 0, 0, w, h)
        const dataUrl = c.toDataURL('image/jpeg', 0.85)
        URL.revokeObjectURL(url)
        resolve({ dataUrl, b64: dataUrl.slice(dataUrl.indexOf(',') + 1) })
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('不是能读的图')) }
    img.src = url
  })
}

function clearImgPreview() {
  S.img = null
  $('#img-preview').hidden = true
  $('#img-preview-img').removeAttribute('src')
  scrollBottom(true)
}

// ---------- 语音条（按住说话） ----------
let rec = null
// 装在手机里时，网页跑在 http://192.168.x.x 这种非安全上下文上，没有 getUserMedia，
// 所以优先用安卓壳里的原生录音（PocketMic），浏览器里再回退到 MediaRecorder。
const NATIVE_MIC = !!(window.PocketMic && typeof window.PocketMic.start === 'function')

function nativeMicStart() {
  let onDone = null
  window.__pocketMicDone = (b64) => {
    const fn = onDone
    onDone = null
    if (fn) fn(String(b64 || ''))
  }
  let r = 'ok'
  try {
    r = String(window.PocketMic.start() || '')
  } catch (e) {
    r = String((e && e.message) || e)
  }
  if (r !== 'ok') {
    delete window.__pocketMicDone
    return { error: r }
  }
  return {
    wait: (cb) => {
      onDone = cb
    }
  }
}

function b64ToBuf(b64) {
  const s = atob(b64)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u.buffer
}

async function startRec() {
  if (S.recording || rec) return
  if (NATIVE_MIC) {
    const h = nativeMicStart()
    if (h.error) {
      addSysToast('拿不到麦克风：' + h.error)
      return
    }
    rec = { native: true, onDone: h.wait }
    S.recording = true
    S.recStart = Date.now()
    $('#rec-indicator').hidden = false
    $('#chat-mic').classList.add('recording')
    if (navigator.vibrate) navigator.vibrate(12)
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mr = new MediaRecorder(stream)
    mr._stream = stream // 太短的录音要自己关麦，onstop 会被摘掉
    const chunks = []
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' })
      blob.arrayBuffer().then((ab) => sendVoiceNote(ab, blob.type)).catch(() => {})
    }
    mr.start()
    rec = mr
    S.recording = true
    S.recStart = Date.now()
    $('#rec-indicator').hidden = false
    $('#chat-mic').classList.add('recording')
    if (navigator.vibrate) navigator.vibrate(12)
  } catch {
    addSysToast('拿不到麦克风（检查权限）')
  }
}

function stopRec() {
  if (!rec) return
  $('#rec-indicator').hidden = true
  $('#chat-mic').classList.remove('recording')
  S.recording = false
  const mr = rec
  const dur = Date.now() - (S.recStart || 0)
  rec = null
  S.recStart = 0

  if (mr.native) {
    if (dur < 700) {
      try { window.PocketMic.cancel() } catch {}
      delete window.__pocketMicDone
      addSysToast('按住话筒别松手，说完再松开')
      return
    }
    mr.onDone((b64) => {
      if (!b64) {
        addSysToast('这条语音没录上，再试一次')
        return
      }
      sendVoiceNote(b64ToBuf(b64), 'audio/mp4')
    })
    try { window.PocketMic.stop() } catch {}
    return
  }

  if (dur < 700) {
    // 误触：不往外发，自己把麦克风关掉
    mr.onstop = null
    mr.ondataavailable = null
    try { mr.stop() } catch {}
    try { mr._stream && mr._stream.getTracks().forEach((t) => t.stop()) } catch {}
    addSysToast('按住话筒别松手，说完再松开')
    return
  }
  try { mr.stop() } catch {}
}

async function sendVoiceNote(ab, mime) {
  const m = mime || 'audio/webm'
  const b64 = bufToB64(ab)
  const at = Date.now()
  addMsg({ who: 'me', text: '', audio: 'data:' + m + ';base64,' + b64, audioMime: m, at })
  S.msgs.push({ who: 'me', text: '[语音]', at })
  scrollBottom(true)
  try {
    const r = await api('/api/voice-note', { method: 'POST', body: { audio: b64 }, timeout: 150000 })
    if (r && r.ok === false) addSysToast(r.message || '她没听清这条语音')
  } catch (e) {
    addSysToast('语音没送到：' + (e.message || e))
  }
}

function bufToB64(buf) {
  const u = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
  return btoa(s)
}

// ---------- emoji 面板（emoji 就是文字，走同一条消息） ----------
const EMOJIS = '😀 😁 😂 🤣 😊 😍 🥰 😘 😜 🤪 😎 🥳 😭 😢 😡 🤬 😱 😴 🤤 🥺 😏 🤔 🤗 🙈 🐶 🐱 🐟 🍚 🍜 🍰 🧋 🍦 🌊 🌙 ⭐ 💕 💖 💘 ✨ 🌸 🍀'.split(/\s+/).filter(Boolean)

function buildEmoji() {
  const panel = $('#emoji-panel')
  panel.innerHTML = ''
  for (const em of EMOJIS) {
    const b = document.createElement('button')
    b.className = 'emoji-item'
    b.textContent = em
    b.onclick = () => {
      insertAtCursor(em)
      panel.hidden = true
    }
    panel.appendChild(b)
  }
}

function insertAtCursor(t) {
  const el = $('#chat-input')
  const st = el.selectionStart ?? el.value.length
  const en = el.selectionEnd ?? st
  el.value = el.value.slice(0, st) + t + el.value.slice(en)
  el.selectionStart = el.selectionEnd = st + t.length
  el.focus()
  autoGrow()
}

// 轮询她的话
async function poll() {
  try {
    const r = await api('/api/events?after=' + S.seq, { timeout: 8000 })
    setOnline(true)
    if (!r || !r.ok) return
    S.seq = r.seq || S.seq
    for (const e of r.list || []) {
      if (e.type === 'her') {
        const p = parseReply(e.text)
        if (!p.text) continue
        S.pending = 0
        $('#typing').hidden = true
        pushMsg({ who: 'her', text: p.text, at: e.at, voice: p.hasVoice })
      } else if (e.type === 'her-media') {
        // 她发的图片 / 表情包 / 语音条（send 钩子抓的原始段）
        S.pending = 0
        $('#typing').hidden = true
        if (e.kind === 'image' && e.data) {
          pushMsg({ who: 'her', text: e.text || '', image: `data:${e.mime || 'image/png'};base64,${e.data}`, at: e.at })
        } else if (e.kind === 'voice' && e.data) {
          pushMsg({ who: 'her', text: '', audio: `data:${e.mime || 'audio/wav'};base64,${e.data}`, audioMime: e.mime, at: e.at })
        }
      } else if (e.type === 'qq-state') {
        renderStatus(e.state === 'connected')
      }
    }
    if (S.pending && Date.now() - S.pending > 120000) {
      S.pending = 0
      $('#typing').hidden = true
    }
  } catch (e) {
    if (e.code === 401) return toPair('密钥不对，重新输一下')
    setOnline(false)
  }
}

function setOnline(ok) {
  if (S.online === ok) return
  S.online = ok
  let bar = $('#offline')
  if (!ok) {
    if (!bar) {
      bar = document.createElement('div')
      bar.id = 'offline'
      bar.textContent = '电脑那边连不上，在重试…'
      $('#app').appendChild(bar)
    }
    bar.hidden = false
  } else if (bar) {
    bar.hidden = true
  }
}

function personaName(id) {
  const map = { dafeiyu: '鲸汐汐' }
  return map[String(id || '')] || (id ? String(id) : '她')
}

function renderStatus(qqOnline) {
  const st = S.state || {}
  const nm = personaName(st.persona)
  $('#chat-name').textContent = nm
  $('#mo-name').textContent = nm + '的空间'
  const parts = [qqOnline ? '在线' : '离线']
  if (st.moodLabel) parts.push(st.moodLabel)
  $('#chat-status').textContent = parts.join(' · ')
  $('#set-qq').textContent = qqOnline ? '在线' : '离线'
  $('#set-host').textContent = S.host || location.host || '本机'
  $('#set-token').textContent = S.token ? S.token.slice(0, 5) + '…' : '–'
  $('#set-mem').textContent = st.memoryCount != null ? st.memoryCount + ' 条' : '–'
}

// ---------- 空间 ----------
function visibilityLabel(v) {
  const map = { public: '公开', private: '仅自己', friends: '好友可见', owner: '只给主人看', qzone: '空间' }
  return map[String(v || '')] || ''
}

function renderMoments(data) {
  const list = $('#moments-list')
  list.innerHTML = ''
  const items = (data && data.list) || []
  if (!items.length) {
    list.innerHTML = '<div class="empty">这里还空着<br>她在电脑那边写了日记就会出现在这儿</div>'
  } else {
    for (const it of items) {
      const card = document.createElement('article')
      card.className = 'moment'
      const when = document.createElement('div')
      when.className = 'when'
      const t = document.createElement('span')
      t.textContent = `${dayLabel(it.at)} ${fmtTime(it.at)}`
      when.appendChild(t)
      const body = document.createElement('div')
      body.className = 'body'
      body.textContent = it.text
      card.append(when, body)
      const vl = visibilityLabel(it.visibility)
      if (vl) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = vl
        card.appendChild(tag)
      }
      list.appendChild(card)
    }
  }
  drawMood((data && data.mood) || [])
}

function guessMood() {
  return [62, 70, 74, 66, 80, 78, 84]
}

function drawMood(points) {
  const svg = $('#mood-chart')
  const vals = (points || []).map((p) => Number(p && typeof p === 'object' ? (p.value ?? p.mood) : p)).filter((n) => Number.isFinite(n))
  const data = vals.length ? vals : []
  const w = 320
  const h = 80
  const pad = 8
  svg.innerHTML = ''
  if (data.length < 2) {
    const v = data.length === 1 ? data[0] : Number(S.state?.mood)
    $('#mood-value').textContent = Number.isFinite(v) ? Math.round(v) : '–'
    if (Number.isFinite(v)) {
      const y = h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2)
      svg.innerHTML = `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${w - pad}" y2="${y.toFixed(1)}" stroke="var(--primary)" stroke-width="2" stroke-dasharray="4 6" opacity=".6"/><circle cx="${w - pad}" cy="${y.toFixed(1)}" r="3.6" fill="var(--primary)"/>`
    }
    return
  }
  $('#mood-value').textContent = Math.round(data[data.length - 1])
  const step = (w - pad * 2) / (data.length - 1)
  const xy = data.map((v, i) => [pad + i * step, h - pad - (Math.max(0, Math.min(100, v)) / 100) * (h - pad * 2)])
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${h - pad} L${pad},${h - pad} Z`
  svg.innerHTML = `
    <defs><linearGradient id="mg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--primary)" stop-opacity=".35"/>
      <stop offset="1" stop-color="var(--primary)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#mg)"/>
    <path d="${line}" fill="none" stroke="var(--primary)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${xy[xy.length - 1][0].toFixed(1)}" cy="${xy[xy.length - 1][1].toFixed(1)}" r="3.4" fill="var(--primary)"/>`
}

async function loadMoments() {
  try {
    const r = await api('/api/moments')
    if (r && r.ok) renderMoments(r)
  } catch (e) {
    handleErr(e)
  }
}

// ---------- 宠物 ----------
const FOOD_ICON = { rice: '🍚', fish: '🐟', hotpot: '🍲', milktea: '🧋', cake: '🍰', ice: '🍨' }

function renderPet(st) {
  if (!st) return
  const set = (bar, val, v) => {
    const el = $(bar)
    el.style.width = v + '%'
    el.classList.toggle('low', v < 30)
    $(val).textContent = v
  }
  set('#bar-satiety', '#val-satiety', st.satiety)
  set('#bar-mood', '#val-mood', st.mood)
  set('#bar-intimacy', '#val-intimacy', st.intimacy)
  const mascot = $('#pet-mascot')
  mascot.classList.toggle('sleepy', !!st.sleepy)
  $('#pet-sub').textContent = st.hungry ? '她饿了，快投喂！' : st.sleepy ? '她困了，让她早点睡' : '她在里面游来游去'
}

function buildFoods(foods) {
  const grid = $('#food-grid')
  grid.innerHTML = ''
  for (const f of foods && foods.length ? foods : [{ id: 'rice', name: '白米饭' }]) {
    const b = document.createElement('button')
    b.className = 'food'
    b.innerHTML = `<span class="ico">${FOOD_ICON[f.id] || '🍚'}</span><span>${f.name}</span>`
    b.onclick = () => petAct('feed', f.id)
    grid.appendChild(b)
  }
}

function petBubble(text, ms = 4200) {
  const el = $('#pet-bubble')
  el.textContent = text
  el.hidden = false
  clearTimeout(petBubble._t)
  petBubble._t = setTimeout(() => (el.hidden = true), ms)
}

function petFx(emojis) {
  const box = $('#pet-fx')
  for (let i = 0; i < (emojis || 6); i++) {
    const s = document.createElement('span')
    s.className = 'fx-emoji'
    s.textContent = ['💗', '✨', '🫧', '🐟', '🍚'][Math.floor(Math.random() * 5)]
    s.style.left = 30 + Math.random() * 40 + '%'
    s.style.top = 55 + Math.random() * 20 + '%'
    s.style.animationDelay = Math.random() * 0.35 + 's'
    box.appendChild(s)
    setTimeout(() => s.remove(), 1600)
  }
}

async function petAct(action, food) {
  const mascot = $('#pet-mascot')
  try {
    const r = await api('/api/pet', { method: 'POST', body: { action, food } })
    if (!r) return
    if (r.reply) petBubble(r.reply)
    if (r.ok) {
      petFx()
      mascot.classList.remove('happy', 'shake')
      void mascot.offsetWidth
      mascot.classList.add(action === 'pet' ? 'shake' : 'happy')
    } else if (r.refused) {
      mascot.classList.remove('shake')
      void mascot.offsetWidth
      mascot.classList.add('shake')
    }
    if (r.state) {
      renderPet(r.state)
      buildFoods(r.state.foods)
    }
  } catch (e) {
    handleErr(e)
  }
}

// ---------- 设置 ----------
function renderSettings() {
  const st = S.state || {}
  renderStatus(st.qqOnline)
}

function toPair(reason) {
  clearInterval(S.polling)
  S.polling = null
  $('#pair-err').textContent = reason || ''
  $('#pair-err').hidden = !reason
  $('#pair-host').value = (S.hosts.length ? S.hosts.join(',') : S.host) || localStorage.getItem(LS.host) || ''
  $('#pair-token').value = ''
  show('pair')
}

async function doPair() {
  const err = $('#pair-err')
  const hosts = hostList($('#pair-host').value)
  const token = $('#pair-token').value.trim()
  err.hidden = true
  if (!hosts.length) return (err.textContent = '先填电脑地址（面板上有；家里/外面两个地址都用逗号填上）'), (err.hidden = false)
  if (!token) return (err.textContent = '先填配对密钥'), (err.hidden = false)
  const btn = $('#pair-go')
  btn.disabled = true
  btn.textContent = '正在连…'
  try {
    // 挨个探活，谁通用谁（多地址时其余的留着做备用）
    let ok = null
    let lastErr = null
    for (const cand of hosts) {
      try {
        const h = await fetch(`${cand}/api/health`, { signal: AbortSignal.timeout(6000) })
        if (h.ok) { ok = cand; break }
        lastErr = new Error('电脑上的口袋没开（' + h.status + '）')
      } catch (e) {
        lastErr = e
      }
    }
    if (!ok) throw lastErr || new Error('都连不上')
    S.host = ok
    S.hosts = [ok, ...hosts.filter((x) => x !== ok)]
    S.token = token
    const r = await api('/api/state', { timeout: 6000 })
    if (!r || !r.ok) throw new Error((r && r.message) || '密钥不对')
    localStorage.setItem(LS.host, S.hosts.join(','))
    localStorage.setItem(LS.token, token)
    boot()
  } catch (e) {
    err.textContent = e.name === 'TimeoutError' || e.name === 'AbortError' ? '连不上：检查地址；在家要和电脑同一个 WiFi，在外面要填公网 IPv6 地址（并放行 7788 端口）' : '连不上：' + (e.message || e)
    err.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = '连上她'
  }
}

// ---------- 启动 ----------
function autoGrow() {
  const el = $('#chat-input')
  el.style.height = 'auto'
  el.style.height = Math.min(108, el.scrollHeight) + 'px'
}

async function boot() {
  takeFromUrl()
  paintTone(S.tone)
  buildToneGrid()
  $('#btn-repair').onclick = () => toPair()
  $('#pair-go').onclick = doPair
  $('#chat-send').onclick = send
  $('#btn-scroll-down').onclick = () => scrollBottom(true)
  $('#chat-emoji').onclick = () => {
    const p = $('#emoji-panel')
    p.hidden = !p.hidden
    if (!p.hidden) scrollBottom(true)
  }
  $('#chat-img').onclick = pickImage
  $('#chat-file').addEventListener('change', onFilePicked)
  $('#img-preview-del').onclick = clearImgPreview
  // 换她的形象：小窝那颗相机按钮 + 设置页两个按钮
  $('#pet-avatar-btn').onclick = pickAvatar
  $('#btn-avatar-pick').onclick = pickAvatar
  $('#btn-avatar-reset').onclick = resetAvatar
  $('#avatar-file').addEventListener('change', onAvatarPicked)
  const mic = $('#chat-mic')
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    try { mic.setPointerCapture(e.pointerId) } catch {}
    startRec()
  })
  // 手指滑出按钮、来电、切后台都要兜底停掉，不然会一直「按着」
  window.addEventListener('pointerup', stopRec)
  window.addEventListener('pointercancel', stopRec)
  window.addEventListener('blur', stopRec)
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopRec() })
  buildEmoji()
  $('#chat-input').addEventListener('input', autoGrow)
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      send()
    }
  })
  for (const b of $$('#tabbar button')) {
    b.onclick = () => {
      show(b.dataset.tab)
      if (b.dataset.tab === 'moments') loadMoments()
      if (b.dataset.tab === 'pet' && S.state) renderPet(S.state.pet)
      if (b.dataset.tab === 'settings') renderSettings()
    }
  }
  for (const b of $$('.pet-btns [data-action]')) b.onclick = () => petAct(b.dataset.action)

  if (!S.token) return toPair()

  try {
    const st = await api('/api/state', { timeout: 8000 })
    if (!st || !st.ok) throw new Error((st && st.message) || '连不上')
    S.state = st
    S.seq = 0
    renderStatus(st.qqOnline)
    renderPet(st.pet)
    buildFoods(st.pet && st.pet.foods)
    // 服务器上有色调设置、本地没改过 → 跟服务器走
    if (st.tone && !localStorage.getItem(LS.tone) ) paintTone(st.tone)
    show('chat')
    await loadHistory()
    clearInterval(S.polling)
    S.polling = setInterval(poll, 1600)
    poll()
  } catch (e) {
    if (e.code === 401) return toPair('密钥不对，重新输一下')
    toPair('连不上电脑：' + (e.message || e))
  }
}

boot()
