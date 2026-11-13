// 适配层的纯逻辑测试：不联网、不需要插件环境。
import test from 'node:test'
import assert from 'node:assert/strict'

import { asrConfig, pickPath, probeStt, ttsConfig, wavHeader } from '../lib/providers.mjs'

test('pickPath 能顺着路径和数组下标取值', () => {
  const j = { data: { result: [{ text: '你好' }] }, text: '顶层' }
  assert.equal(pickPath(j, 'data.result[0].text'), '你好')
  assert.equal(pickPath(j, 'text'), '顶层')
  assert.equal(pickPath(j, 'data.missing.text'), undefined)
  assert.equal(pickPath(j, ''), undefined)
})

test('认不出的引擎一律回落到本地识别', () => {
  assert.equal(asrConfig({ asrProvider: 'nope' }).provider, 'local')
  assert.equal(asrConfig({}).provider, 'local')
  assert.equal(asrConfig({ asrProvider: 'openai' }).lang, 'zh')
})

test('OpenAI 兼容转写没填 Key 时明确提示，不假装就绪', async () => {
  const info = await probeStt({ provider: 'openai', url: 'https://api.example.com/v1', key: '' })
  assert.equal(info.ready, false)
  assert.match(info.why, /Key/)
})

test('自定义模板没填 url 也不能算就绪', async () => {
  const info = await probeStt({ provider: 'http', template: {} })
  assert.equal(info.ready, false)
})

test('follow 跟随全局引擎，并把音色带过去', () => {
  const g = ttsConfig({ ttsProvider: 'follow' }, { engine: 'gptsovits', gptsovits: { url: 'http://127.0.0.1:9880', refAudio: 'a.wav' } })
  assert.equal(g.provider, 'gptsovits')
  assert.equal(g.follow, true)

  const e = ttsConfig({ ttsProvider: 'follow' }, { engine: 'edge', voice: 'zh-CN-XiaoxiaoNeural', rate: '+5%' })
  assert.equal(e.provider, 'edge')
  assert.equal(e.edgeVoice, 'zh-CN-XiaoxiaoNeural')
  assert.equal(e.edgeRate, '+5%')
})

test('显式指定的引擎优先于全局设置', () => {
  const c = ttsConfig({ ttsProvider: 'openai', ttsModel: 'tts-1' }, { engine: 'gptsovits' })
  assert.equal(c.provider, 'openai')
  assert.equal(c.follow, false)
  assert.equal(c.format, 'pcm')
})

test('WAV 头长度和采样率写得对', () => {
  const head = wavHeader(24000, 1, 16)
  assert.equal(head.length, 44)
  assert.equal(head.toString('ascii', 0, 4), 'RIFF')
  assert.equal(head.toString('ascii', 8, 12), 'WAVE')
  assert.equal(head.readUInt32LE(24), 24000)
  assert.equal(head.readUInt16LE(22), 1)
  assert.equal(head.readUInt16LE(34), 16)
  assert.equal(head.readUInt32LE(40), 0xffffffff) // 长度未知，边下边播用
})
