const { useEffect, useState } = React
const { Card, Row, Btn } = ui

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读不到参考音频'))
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.readAsDataURL(file)
  })
}

return function Panel({ settings, toast }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [voiceText, setVoiceText] = useState('')
  const [audio, setAudio] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [image, setImage] = useState('')

  async function refresh() {
    const result = await call('/status')
    if (!result?.ok) throw new Error(result?.message || '读取模块状态失败')
    setStatus(result)
  }

  useEffect(() => {
    refresh().catch((error) => toast(error.message))
  }, [settings.voiceEnabled, settings.mimoKey, settings.imageEnabled, settings.modelScopeToken, settings.imageModels, settings.imageDefaultModel])

  async function run(path, body, success) {
    setBusy(true)
    try {
      const result = await call(path, await body)
      if (!result?.ok) throw new Error(result?.message || '操作失败')
      if (success) success(result)
      if (result.message) toast(result.message)
      if (path === '/reference' || path === '/local') await refresh()
    } catch (error) {
      toast(error.message)
    } finally {
      setBusy(false)
    }
  }

  function upload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > 7 * 1024 * 1024) return toast('参考音频最大 7 MB')
    return run('/reference', asBase64(file).then((base64) => ({ base64 })))
  }

  function binding(slot, title) {
    const current = status?.local?.[slot]
    return h(Row, {
      label: title,
      hint: current?.conflict ? '检测到已有的本地脚本，请先到「本地接口」页处理。' :
        '同时在 Aurabot「' + (slot === 'tts' ? '语音' : '生图') + '」页打开对应功能。',
    }, h(Btn, {
      small: true, disabled: busy || !current || current.conflict,
      onClick: () => run('/local', { slot, enabled: !current.active }),
    }, current?.active ? '关闭接管' : '启用接管'))
  }

  const models = status?.models || []
  return h(React.Fragment, null,
    h(Card, { title: 'MiMo 试听', desc: '保存 MiMo 设置后，上传 WAV 或 MP3 参考音频。' },
      h(Row, { label: '参考音频', hint: status?.hasReference ? '已上传，可替换。' : '最大 7 MB。' },
        h('input', { type: 'file', accept: '.wav,.mp3,audio/wav,audio/mpeg', 'aria-label': '上传参考音频', disabled: busy, onChange: upload })),
      h(Row, { label: '朗读内容' },
        h('textarea', { className: 'ab-textarea', value: voiceText, maxLength: 300, 'aria-label': '朗读内容', onChange: (event) => setVoiceText(event.target.value) }),
        h(Btn, { disabled: busy || !voiceText.trim(), onClick: () => run('/preview-voice', { text: voiceText }, (result) => setAudio(result.url)) }, '生成试听')),
      audio && h('audio', { controls: true, src: audio, 'aria-label': 'MiMo 试听音频' }),
      binding('tts', '平时的语音回复使用 MiMo')),
    h(Card, { title: '魔搭试画', desc: '保存魔搭设置后，可以在这里试用列表里的模型。' },
      h(Row, { label: '本次模型' },
        h('select', { className: 'ab-input', value: models.includes(model) ? model : '', 'aria-label': '试画模型', onChange: (event) => setModel(event.target.value) },
          h('option', { value: '' }, status?.defaultModel ? '默认 · ' + status.defaultModel : '默认模型'),
          ...models.map((id) => h('option', { key: id, value: id }, id)))),
      h(Row, { label: '画面描述' },
        h('textarea', { className: 'ab-textarea', value: prompt, maxLength: 1999, 'aria-label': '画面描述', onChange: (event) => setPrompt(event.target.value) }),
        h(Btn, { disabled: busy || !prompt.trim(), onClick: () => run('/preview-image', { prompt, model: models.includes(model) ? model : '' }, (result) => setImage(result.url)) }, '试画')),
      image && h('img', { src: image, alt: '魔搭试画结果', style: { display: 'block', maxWidth: '100%', maxHeight: 440, objectFit: 'contain' } }),
      binding('image', '内置生图使用魔搭默认模型')),
  )
}
