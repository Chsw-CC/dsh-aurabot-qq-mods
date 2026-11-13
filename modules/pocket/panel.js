// 口袋面板：配对信息一眼可抄——地址、密钥、配对链接；顺便预设 app 端的人物色调
const { useState, useEffect } = React

// 与 app/tones.js 同一套基础色调（面板只挑 key，界面配色在 app 端）
const TONES = [
  { id: 'ocean', name: '深海蓝', a: '#54a8e6', b: '#2f6fb8' },
  { id: 'sakura', name: '樱粉', a: '#f393b2', b: '#c9537a' },
  { id: 'mint', name: '薄荷绿', a: '#57cdaa', b: '#1e8f72' },
  { id: 'grape', name: '葡萄紫', a: '#a68fea', b: '#6a52b8' },
  { id: 'sunset', name: '落日橙', a: '#f5a86b', b: '#c96a2e' },
  { id: 'moon', name: '月白', a: '#9db3cd', b: '#5d7595' },
  { id: 'abyss', name: '深海夜', a: '#5b76cf', b: '#26306b' },
  { id: 'rose', name: '陈玫', a: '#e57c90', b: '#a83349' },
]

return function Panel({ settings, save, toast }) {
  const [net, setNet] = useState(null)
  const tone = TONES.some((t) => t.id === settings?.tone) ? settings.tone : 'ocean'
  const token = String(settings?.token || '')

  const reload = () => call('/net-info').then((r) => setNet(r || {})).catch(() => setNet({ ok: false }))
  useEffect(() => { reload() }, [])

  const regen = async () => {
    const strong = 'pk_' + Array.from({ length: 3 }, () => Math.random().toString(36).slice(2, 12)).join('')
    await save({ token: strong })
    toast('密钥已换，所有设备要重新配对')
  }

  const port = net?.port || 7788
  const addrs = (net?.addresses || []).map((ip) => `${ip}:${port}`)
  const pairLink = addrs.length && token ? `http://${addrs[0]}/#host=${addrs[0]}&token=${encodeURIComponent(token)}` : ''
  const pairText = (addrs.length ? addrs.map((a) => `http://${a}`).join('\n') : '') + (token ? `\n密钥：${token}` : '')

  // 给每个地址标一句「什么时候填它」，免得对着三个地址不知道抄哪个
  const addrLabel = (ip) => {
    const v4 = ip.replace(/^\[|\]$/g, '')
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
      if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4)) return '家里 WiFi（和电脑连同一个路由器时用）'
      return '局域网 IPv4'
    }
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4)) return 'Tailscale（装了才用）'
    if (v4.includes(':')) return '公网 IPv6（在外面用 4G/5G 时用，需要光猫/路由器放行 ' + port + ' 端口）'
    return ''
  }

  const cell = { border: '1px solid rgba(128,128,128,.3)', borderRadius: 8, padding: '5px 10px', fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all' }
  const sw = { width: 34, height: 34, borderRadius: 10, border: '2px solid transparent', cursor: 'pointer', padding: 0 }

  return h(ui.Card, { title: '口袋aurabot' },
    h('p', { className: 'ab-note' },
      '把她的对话流开放给手机 app（app 消息走她原生流程，记忆和 QQ 端共用一套）。家里连同一个 WiFi 用局域网地址；人在外面用 4G/5G 时填公网 IPv6 地址。'),

    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
      h(ui.Btn, {
        onClick: () => { navigator.clipboard?.writeText(pairLink || pairText || token).then(() => toast('配对链接已复制，手机浏览器打开即可')); },
      }, '复制配对链接'),
      h(ui.Btn, { onClick: regen }, '换密钥'),
      h('span', { className: 'ab-small ab-muted' },
        net ? (net.enabled ? (net.error ? `服务异常：${net.error}` : `服务端口 ${port}`) : '手机接口关着') : '读取中…'),
    ),

    h('div', { style: { marginTop: 10 } },
      h('p', { className: 'ab-small ab-muted' }, '可用地址（手机 app 配对页填，可多个都填上、逗号隔开——中英文逗号都行，app 会自动挑能通的）：'),
      addrs.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            addrs.map((a) => h('div', { key: a, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              h('code', { style: cell }, `http://${a}`),
              h('span', { className: 'ab-small ab-muted' }, addrLabel(a)),
            )))
        : h('p', { className: 'ab-small ab-muted' }, net ? '没找到局域网地址（没联网？）' : '读取中…'),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 6 } }, '密钥：'),
      h('code', { style: cell }, token || '（还没生成，动一下开关就会生成）'),
    ),

    h('div', { style: { marginTop: 12 } },
      h('p', { className: 'ab-small', style: { fontWeight: 600 } }, '怎么用：'),
      h('ol', { className: 'ab-small ab-muted', style: { margin: '4px 0 0', paddingLeft: 20, lineHeight: 1.8 } },
        h('li', null, '手机装好「口袋aurabot」app（或直接用手机浏览器开上面的地址也行）'),
        h('li', null, 'app 配对页把地址填进去——在家填「家里 WiFi」那条；在外面填「公网 IPv6」那条；拿不准就把几条都填上，逗号隔开'),
        h('li', null, '密钥抄下面这条（或点上面的「复制配对链接」，手机浏览器打开就自动填好）'),
        h('li', null, '点「连上她」即可；换密钥后所有设备要重新配对'),
      ),
      h('p', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
        '小提示：在外面连不上时，先看光猫/路由器有没有放行 ' + port + ' 端口的 IPv6 入站（浏览器开 IPv6 测试网站确认家里宽带有没有公网 IPv6）。'),
    ),

    // ---- 人物色调预设 ----
    h('div', { style: { marginTop: 14 } },
      h('p', { className: 'ab-small ab-muted' }, '人物色调预设（app 界面配色，手机端也能改）：'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 } },
        TONES.map((t) =>
          h('button', {
            key: t.id,
            title: t.name,
            style: { ...sw, background: `linear-gradient(135deg, ${t.a}, ${t.b})`, borderColor: tone === t.id ? 'var(--ab-primary, #3f86d4)' : 'transparent', outline: tone === t.id ? '2px solid rgba(63,134,212,.35)' : 'none' },
            onClick: async () => {
              await save({ tone: t.id })
              toast(`色调预设为「${t.name}」，app 端会跟着换`)
            },
          }),
        ),
      ),
    ),

    h('p', { className: 'ab-small ab-muted', style: { marginTop: 10 } },
      'app 界面直接手机浏览器开 http://电脑IP:' + port + ' 也行；全部接口要配对密钥。消息只注入主人的私聊，发不了别人和群。'),
  )
}
