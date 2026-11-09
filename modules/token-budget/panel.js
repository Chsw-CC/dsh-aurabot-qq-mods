// 预算管家面板：顶部今日概览 + 近 7 天曲线条 + 每个会话一张消耗/节省卡片。
// 来源：本模块原创；约定：React/h/ui/call/toast 由面板宿主注入（对齐 meme-wiki / feed 的写法）。
const { useState, useEffect } = React

const fmtTok = (n) => (n >= 10000 ? (Math.round(n / 1000) + 'k') : Math.round(n) + '')
const chatLabel = (id) => {
  const m = String(id || '').match(/^(private|group):(.+)$/)
  if (!m) return String(id || '（未知会话）')
  return m[1] === 'group' ? '群 ' + m[2] : '私聊 ' + m[2]
}

return function TokenBudgetPanel({ settings, save, toast }) {
  const [st, setSt] = useState(null)

  const load = async () => {
    try { setSt(await call('/status')) } catch (e) { toast('读账本失败：' + e.message) }
  }
  useEffect(() => { load() }, [])
  // 每 30 秒自己刷一次，聊天在跑时数字是活的
  useEffect(() => {
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [])

  const put = async (patch) => { try { await save(patch) } catch (e) { toast('保存失败：' + e.message) } }

  const STATE_TEXT = { ok: ['正常', '#7a9e6f'], soft: ['软熔：非主人聊天在用便宜模型', '#b98a2f'], hard: ['硬熔：非必回的消息先不接', '#b05a4a'] }
  const stateInfo = STATE_TEXT[st?.state] || STATE_TEXT.ok

  const box = (label, value, note) => h('div', { style: { minWidth: 110 } },
    h('div', { className: 'ab-small ab-muted' }, label),
    h('div', { style: { fontSize: 19, fontWeight: 600 } }, value),
    note ? h('div', { className: 'ab-small ab-muted' }, note) : null)

  const card = (c) => {
    const total = c.inTok + c.outTok
    const savedPct = total > 0 ? Math.min(100, Math.round((c.saved / (total + c.saved)) * 100)) : 0
    return h('div', {
      key: c.chatId,
      style: { border: '1px solid var(--ab-border, #333)', borderRadius: 10, padding: '10px 12px', minWidth: 240, flex: '1 1 240px' },
    },
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
        h('div', { style: { fontWeight: 600 } }, chatLabel(c.chatId)),
        h('div', { className: 'ab-small ab-muted' }, c.turns + ' 轮')),
      h('div', { className: 'ab-flex', style: { gap: 14, margin: '6px 0' } },
        box('消耗', fmtTok(c.inTok + c.outTok) + ' tok', '≈ ' + c.yuan + ' 元'),
        box('节省', fmtTok(c.saved) + ' tok', '≈ ' + c.savedYuan + ' 元'),
        box('省下占比', savedPct + '%', '省的是注入 token')),
      // 一条「消耗 vs 节省」双色条
      h('div', { style: { height: 6, borderRadius: 99, background: '#3a3a3a', overflow: 'hidden' } },
        h('div', {
          style: { height: '100%', width: Math.max(4, savedPct) + '%', background: '#7a9e6f' },
          title: '绿色 = 节省占比',
        })))
  }

  const maxDay = Math.max(1, ...(st?.recent || []).map((d) => d.inTok + d.outTok))
  const barRow = (d) => h('div', { key: d.day, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0' } },
    h('div', { className: 'ab-small ab-muted', style: { width: 46 } }, d.day.slice(5)),
    h('div', { style: { flex: 1, height: 6, borderRadius: 99, background: '#3a3a3a', overflow: 'hidden' } },
      h('div', { style: { height: '100%', width: Math.round(((d.inTok + d.outTok) / maxDay) * 100) + '%', background: '#b98a2f' } })),
    h('div', { className: 'ab-small ab-muted', style: { width: 64, textAlign: 'right' } }, d.yuan + ' 元'))

  return h(ui.Card, { title: '预算管家', desc: '省 token：内容封顶、只带最相关的记忆、超了自动熔断' },
    st ? h('div', null,
      h('div', { className: 'ab-flex', style: { gap: 18, flexWrap: 'wrap', marginBottom: 10 } },
        box('今日消耗', fmtTok(st.today.inTok + st.today.outTok) + ' tok', '≈ ' + st.today.yuan + ' 元'),
        box('熔断线', st.today.limit + ' 元', '已用 ' + st.today.pct + '%'),
        box('状态', stateInfo[0], '')),
      h('div', { className: 'ab-small ab-muted', style: { color: stateInfo[1], marginBottom: 10 } }, stateInfo[1] !== '正常' ? stateInfo[0] : ''),
      h('div', { style: { marginBottom: 12 } },
        h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, '近 7 天（token / 折算）'),
        st.recent.map(barRow)),
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 6 } },
        '每个会话的消耗与节省（近 7 天；绿色 = 这轮省下的注入占比）'),
      st.chats.length
        ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 10 } }, st.chats.map(card))
        : h('div', { className: 'ab-small ab-muted' }, '还没有会话数据——她收到 / 回出消息后这里就会长出来。'))
      : h('div', { className: 'ab-small ab-muted' }, '读账本中…'),
    ui.Row ? null : null,
    h(ui.Row, { label: '启用预算管家', hint: '总开关：关掉后不记账、不裁剪、不熔断' },
      h(ui.Switch, { on: settings.enabled !== false, onChange: (v) => put({ enabled: v }) })))
}
