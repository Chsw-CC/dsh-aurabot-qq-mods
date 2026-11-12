import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ID = 'mimo-modelscope'
const KEY = 'aurabot.mimo-modelscope.local.v1'
const slots = {
  tts: { enabled: 'voiceEnabled', preference: 'attachVoice' },
  image: { enabled: 'imageEnabled', preference: 'attachImage' },
}

function adapter(slot) {
  return [
    '// 由 Aurabot 模块 mimo-modelscope 安装。',
    "import { realpathSync } from 'node:fs'",
    "import { fileURLToPath } from 'node:url'",
    ...(slot === 'image' ? ['export const supportsImage = true'] : []),
    'export default async function (input) {',
    "  const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))",
    "  const run = globalThis[Symbol.for('" + KEY + "')]?.get(root)?." + slot,
    "  if (!run) throw new Error('请启用「MiMo 语音与魔搭生图」，或在 Aurabot 本地接口页关闭此接管')",
    '  return run(input)',
    '}',
    '',
  ].join('\n')
}

export function localBindings(api, providers) {
  const root = realpathSync(resolve(api.dataDir(), '..', '..'))
  const directory = join(root, 'local')
  const symbol = Symbol.for(KEY)
  const instances = globalThis[symbol] ??= new Map()
  instances.set(root, providers)

  const known = Object.keys(slots)
  const path = (slot) => join(directory, slot + '.mjs')
  function ownership(slot) {
    try {
      const file = path(slot)
      const info = lstatSync(file)
      const content = adapter(slot)
      return info.isFile() && info.size === Buffer.byteLength(content) && readFileSync(file, 'utf8') === content ? 'ours' : 'other'
    } catch (error) {
      if (error.code === 'ENOENT') return 'missing'
      throw error
    }
  }

  function install(slot) {
    const state = ownership(slot)
    if (state === 'ours') return false
    if (state === 'other') throw new Error('已有本地 ' + slot + '.mjs，请先在本地接口页处理冲突')
    mkdirSync(directory, { recursive: true })
    writeFileSync(path(slot), adapter(slot), { flag: 'wx' })
    return true
  }

  function remove(slot) {
    if (ownership(slot) === 'ours') unlinkSync(path(slot))
  }

  function reconcile() {
    const cfg = api.config()
    const settings = api.settings()
    for (const slot of known) {
      const { enabled, preference } = slots[slot]
      try {
        if (cfg.local?.[slot] && settings[enabled] && settings[preference]) {
          if (ownership(slot) === 'missing') install(slot)
        } else {
          remove(slot)
        }
      } catch (error) {
        api.log.warn('处理本地接口 ' + slot + ' 失败：' + error.message)
      }
    }
  }

  api.onDispose(() => {
    if (instances.get(root) !== providers) return
    instances.delete(root)
    for (const slot of known) {
      try { remove(slot) } catch (error) { api.log.warn('清理本地接口 ' + slot + ' 失败：' + error.message) }
    }
    if (!instances.size) delete globalThis[symbol]
  })
  api.on('config', reconcile)
  reconcile()

  function set(slot, enabled) {
    if (!Object.hasOwn(slots, slot)) throw new Error('未知的本地接口')
    const binding = slots[slot]
    if (enabled) {
      if (!api.settings()[binding.enabled]) throw new Error('请先启用并保存对应的功能')
      const created = install(slot)
      try {
        api.setConfig({ local: { [slot]: true }, ext: { [ID]: { [binding.preference]: true } } })
      } catch (error) {
        if (created) remove(slot)
        throw error
      }
    } else {
      const ownsSlot = ownership(slot) === 'ours'
      api.setConfig({
        ...(ownsSlot ? { local: { [slot]: false } } : {}),
        ext: { [ID]: { [binding.preference]: false } },
      })
      remove(slot)
    }
  }

  function status() {
    return Object.fromEntries(known.map((slot) => {
      const state = ownership(slot)
      return [slot, { active: state === 'ours' && Boolean(api.config().local?.[slot]), conflict: state === 'other' }]
    }))
  }

  return { set, status }
}
