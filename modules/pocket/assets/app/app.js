import { TONES, toneOf, applyTone, DEFAULT_TONE } from './tones.js'

// ---------- 本地状态 ----------
const LS = {
  host: 'pocket.host',
  token: 'pocket.token',
  tone: 'pocket.tone',
  toneLocal: 'pocket.tone.local',
}

const S = {
  host: localStorage.getItem(LS.host) || '',
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
  playingText: '',
}

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

// 从地址栏接管密钥/地址（扫码或 APK 首启带过来）
function takeFromUrl() {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  const token = h.get('token') || q.get('token')
  const host = h.get('host') || q.get('host')
  if (host) {
    const clean = normalizeHost(host)
    if (clean) {
      localStorage.setItem(LS.host, clean)
      S.host = clean
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

function normalizeHost(v) {
  let s = String(v || '').trim()
  if (!s) return ''
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!/:\d+$/.test(s)) s += ':7788'
  return s
}

const base = () => (S.host ? `http://${S.host}` : location.origin)

async function api(path, { method = 'GET', body, timeout = 15000 } = {}) {
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

/** 她的话里可能带 <voice> / <sticker:名字> / [沉默]，拆干净 */
function parseReply(text) {
  let t = String(text || '')
  const hasVoice = /<voice>/i.test(t)
  t = t.replace(/<voice>[\s\S]*?<\/voice>/gi, '').replace(/<\/?voice>/gi, '')
  t = t.replace(/<sticker:[^>]*>/gi, '')
  t = t.replace(/\[(sticker|表情)\]/gi, '')
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

function addMsg({ who, text, at, voice }, { animate = true } = {}) {
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
  b.appendChild(document.createTextNode(text))
  if (voice && who !== 'me') {
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
  if (!text) return
  input.value = ''
  autoGrow()
  const at = Date.now()
  addMsg({ who: 'me', text, at })
  S.msgs.push({ who: 'me', text, at })
  scrollBottom(true)
  S.pending = at
  $('#typing').hidden = false
  try {
    const r = await api('/api/message', { method: 'POST', body: { text } })
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
    cleanupPlaying()
    return
  }
  if (S.playing) {
    S.playing.pause()
    cleanupPlaying()
  }
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
    await audio.play()
    function cleanupPlaying() {
      bubbleEl.classList.remove('playing')
      btn.textContent = old
      S.playing = null
      S.playingText = ''
      URL.revokeObjectURL(url)
    }
  } catch (e) {
    btn.textContent = old
    addSysToast(e.message || '语音失败')
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
  $('#pair-host').value = S.host || localStorage.getItem(LS.host) || ''
  $('#pair-token').value = ''
  show('pair')
}

async function doPair() {
  const err = $('#pair-err')
  const host = normalizeHost($('#pair-host').value)
  const token = $('#pair-token').value.trim()
  err.hidden = true
  if (!host) return (err.textContent = '先填电脑地址（面板上有）'), (err.hidden = false)
  if (!token) return (err.textContent = '先填配对密钥'), (err.hidden = false)
  const btn = $('#pair-go')
  btn.disabled = true
  btn.textContent = '正在连…'
  try {
    // 先探活，再验密钥
    const h = await fetch(`http://${host}/api/health`, { signal: AbortSignal.timeout(6000) })
    if (!h.ok) throw new Error('电脑上的口袋没开（' + h.status + '）')
    S.host = host
    S.token = token
    const r = await api('/api/state', { timeout: 6000 })
    if (!r || !r.ok) throw new Error((r && r.message) || '密钥不对')
    localStorage.setItem(LS.host, host)
    localStorage.setItem(LS.token, token)
    boot()
  } catch (e) {
    err.textContent = e.name === 'TimeoutError' || e.name === 'AbortError' ? '连不上：检查地址，手机和电脑要在同一网络' : '连不上：' + (e.message || e)
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
