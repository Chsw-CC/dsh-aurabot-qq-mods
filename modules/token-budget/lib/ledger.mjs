// 日账本：按本地日期滚动的 token / 花费记录与熔断判定。
// 来源：本模块原创；作用：记账（估算 token → 折算元）、软/硬熔断状态、当日豁免、近 7 天曲线数据。
// 数据写 api.dataDir('ledger.json')（由调用方传入目录），保留最近 30 天。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 30
const NOTIFY_PER_DAY = 2 // 每日至多提醒几次，别刷屏

// 本地日期键：YYYY-MM-DD（按本机时区，不和 UTC 混）
export function dayKey(ts = Date.now(), tzOffsetMin = -new Date().getTimezoneOffset()) {
  const d = new Date(ts + tzOffsetMin * 60_000)
  return d.toISOString().slice(0, 10)
}

const emptyDay = () => ({ inTok: 0, outTok: 0, notified: 0, exempt: false })

export function createLedger({ dataDir, log = console, prices, overheadFactor = 1.3, softPct = 80, tzOffsetMin } = {}) {
  const file = join(dataDir || '.', 'ledger.json')
  let days = {}
  let loaded = false

  function load() {
    if (loaded) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      // 容错：账本损坏就当空账本，别让一条坏 JSON 卡死聊天（对齐 store.js 的容错思路）
      if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) days = raw.days
    } catch { days = {} }
    loaded = true
  }

  function save() {
    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(file, JSON.stringify({ days }, null, 1))
    } catch (error) { log.warn?.('token-budget 账本写盘失败：', error?.message || error) }
  }

  function today(ts) {
    load()
    const key = dayKey(ts, tzOffsetMin)
    if (!days[key]) {
      days[key] = emptyDay()
      // 跨日滚动：清掉 30 天前的旧账
      const keys = Object.keys(days).sort()
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k]
      save()
    }
    return { key, day: days[key] }
  }

  const factor = () => (Number(overheadFactor) > 0 ? Number(overheadFactor) : 1)

  function add(kind, tokens, ts) {
    const { day } = today(ts)
    const t = Math.max(0, Math.round(Number(tokens) || 0)) * factor()
    if (kind === 'in') day.inTok += t
    else day.outTok += t
    save()
    return t
  }

  // 当日花费（元）。priceIn / priceOut：元 / 百万 token。
  function spentYuan(ts) {
    const { day } = today(ts)
    const pin = Math.max(0, Number(prices?.in) || 0)
    const pout = Math.max(0, Number(prices?.out) || 0)
    return (day.inTok * pin + day.outTok * pout) / 1_000_000
  }

  // 熔断状态：'ok' | 'soft'（达软熔线） | 'hard'（达日预算线）；豁免日永远 'ok'。
  function state(ts) {
    const { day } = today(ts)
    if (day.exempt) return 'ok'
    const limit = Math.max(0.01, Number(prices?.limit) || 0)
    const yuan = spentYuan(ts)
    if (yuan >= limit) return 'hard'
    const softAt = limit * (Math.min(100, Math.max(1, Number(softPct) || 80)) / 100)
    return yuan >= softAt ? 'soft' : 'ok'
  }

  // 当日已提醒次数（记在账本里，重启不清零）；超过上限返回 -1 表示「别再提醒了」。
  function takeNotifySlot(ts) {
    const { day } = today(ts)
    if (day.notified >= NOTIFY_PER_DAY) return -1
    day.notified++
    save()
    return day.notified
  }

  function setExempt(ts, on = true) {
    const { key, day } = today(ts)
    day.exempt = Boolean(on)
    save()
    return key
  }

  // 近 N 天曲线数据（给面板）：[{ day, inTok, outTok, yuan }]
  function recent(n = 7, ts = Date.now()) {
    load()
    const out = []
    for (let i = n - 1; i >= 0; i--) {
      const key = dayKey(ts - i * 86_400_000, tzOffsetMin)
      const d = days[key] || emptyDay()
      const pin = Math.max(0, Number(prices?.in) || 0)
      const pout = Math.max(0, Number(prices?.out) || 0)
      out.push({ day: key, inTok: Math.round(d.inTok), outTok: Math.round(d.outTok), yuan: +((d.inTok * pin + d.outTok * pout) / 1_000_000).toFixed(3) })
    }
    return out
  }

  return { add, spentYuan, state, setExempt, recent, today, takeNotifySlot }
}
