import { rmSync } from 'node:fs'
import { createStore, publicState } from './lib/store.mjs'
import { createRunner } from './lib/runner.mjs'
import { createJdQr } from './lib/jd-qr.mjs'
import { parseCron } from './lib/cron.mjs'

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'wool-runner',
  name: '薅羊毛任务中心',
  version: '1.0.0',
  api: 1,
  description: '参考青龙的订阅、环境变量、Cron 任务与日志管理，内置 jdpro、smzdm_script、QLScriptPublic 源，支持京东扫码获取 JD_COOKIE',
  panel: 'panel.js',
  defaults: { nodePath: '', pythonPath: '', bashPath: '', timeoutMinutes: 30 },
  settings: [
    { key: 'nodePath', label: 'Node.js 路径（可选）', type: 'text', hint: '留空使用 DSH 当前运行时；也可填本机 node.exe 的绝对路径' },
    { key: 'pythonPath', label: 'Python 路径（可选）', type: 'text', hint: '运行 .py 脚本时使用，留空从 PATH 查找 python' },
    { key: 'bashPath', label: 'Bash 路径（可选）', type: 'text', hint: '运行 .sh 脚本时使用，留空从 PATH 查找 bash' },
    { key: 'timeoutMinutes', label: '单任务超时（分钟）', type: 'number', min: 1, max: 240, step: 1 },
  ],
  setup(api) {
    const store = createStore(api.dataDir())
    const runner = createRunner({ store, log: api.log, settings: api.settings })
    const qr = createJdQr({ store })
    const body = async (req) => api.core.http.body(req)
    const route = (path, handler) => api.route(path, async (req, res) => {
      try { return await handler(req, res) }
      catch (error) { return { ok: false, message: String(error?.message || error).slice(0, 1200) } }
    }, { access: 'panel' })
    const state = () => ({ ok: true, ...publicState(store, runner.runtime) })

    route('/state', state)
    route('/subscription/add', async (req) => ({ ok: true, item: store.addSubscription(await body(req)) }))
    route('/subscription/update', async (req) => {
      const input = await body(req)
      if (!input.id) throw new Error('缺少订阅 id')
      return { ok: true, item: store.updateSubscription(input.id, input) }
    })
    route('/subscription/sync', async (req) => runner.sync(String((await body(req)).id || '')))
    route('/subscription/delete', async (req) => {
      const input = await body(req)
      const id = String(input.id || '')
      const related = store.state().tasks.filter((t) => t.subscriptionId === id)
      await Promise.all(related.map((t) => runner.stop(t.id, '删除订阅')))
      const item = store.removeSubscription(id)
      if (input.purge) rmSync(runner.repoDir(item.id), { recursive: true, force: true })
      return { ok: true, message: input.purge ? '订阅、任务和本地源码已删除' : '订阅和关联任务已删除，本地源码保留' }
    })
    route('/scripts', async (req) => {
      const id = api.core.http.query(req).id
      return { ok: true, items: runner.discover(String(id || '')) }
    })
    route('/task/add', async (req) => {
      const input = await body(req)
      const sub = store.state().subscriptions.find((s) => s.id === input.subscriptionId)
      if (!sub) throw new Error('订阅不存在')
      const script = runner.discover(sub.id).find((x) => x.id === input.scriptId || x.file === input.file)
      if (!script) throw new Error('脚本不存在，请重新同步')
      if (store.state().tasks.some((t) => t.id === script.id)) throw new Error('这个脚本已在任务列表中')
      const cron = String(input.cron || script.cron || '').trim()
      parseCron(cron)
      return { ok: true, item: store.upsertTask({ id: script.id, subscriptionId: sub.id, file: script.file, name: String(input.name || script.name), cron, enabled: false }) }
    })
    route('/task/update', async (req) => {
      const input = await body(req)
      const old = store.state().tasks.find((t) => t.id === input.id)
      if (!old) throw new Error('任务不存在')
      if (input.cron !== undefined) parseCron(input.cron)
      return { ok: true, item: store.upsertTask({ ...old, name: input.name === undefined ? old.name : String(input.name).slice(0, 120), cron: input.cron ?? old.cron, enabled: input.enabled === undefined ? old.enabled : input.enabled === true }) }
    })
    route('/task/run', async (req) => runner.run(String((await body(req)).id || '')))
    route('/task/stop', async (req) => runner.stop(String((await body(req)).id || '')))
    route('/task/delete', async (req) => {
      const id = String((await body(req)).id || '')
      await runner.stop(id, '删除任务')
      store.removeTask(id)
      return { ok: true, message: '任务已删除，订阅源码保留' }
    })
    route('/log', async (req) => ({ ok: true, ...await runner.readLog(api.core.http.query(req).id) }))
    route('/env/save', async (req) => ({ ok: true, item: store.upsertEnv(await body(req)) }))
    route('/env/delete', async (req) => { store.removeEnv(String((await body(req)).id || '')); return { ok: true, message: '环境变量已删除' } })
    route('/qr/jd/start', async () => qr.start())
    route('/qr/jd/poll', async (req) => qr.poll(String((await body(req)).session || '')))
    route('/qr/jd/cancel', async (req) => qr.cancel(String((await body(req)).session || '')))

    api.every(1000, () => runner.tick(), '薅羊毛 Cron 调度')
    api.onDispose(() => runner.dispose())
    api.command({
      name: '羊毛', desc: '查看薅羊毛任务：/羊毛 列表；/羊毛 运行 任务名',
      async run(arg) {
        const text = String(arg || '').trim()
        const tasks = store.state().tasks
        if (!text || text === '列表') return tasks.length ? tasks.map((t, i) => `${i + 1}. ${t.name}｜${t.enabled ? '定时开' : '定时关'}｜${t.lastStatus || '未运行'}`).join('\n') : '还没有任务，请先到 Aurabot 面板的「薅羊毛任务中心」添加。'
        const match = text.match(/^运行\s+(.+)$/)
        if (!match) return '用法：/羊毛 列表，或 /羊毛 运行 任务名'
        const found = tasks.find((t) => t.name === match[1] || t.id === match[1])
        if (!found) return '没找到这个任务，先发 /羊毛 列表 看看名字。'
        const result = await runner.run(found.id)
        return result.message + `：${found.name}`
      },
    })
    api.tool(({ level, chat }) => level === 'full' && chat.kind === 'private' ? api.defineTool({
      name: 'wool_tasks',
      description: '查看或手动运行主人在 Aurabot 薅羊毛任务中心里配置的脚本任务。action 填 list 或 run；run 时 task 填完整任务名。不能新增任务、修改定时或读取环境变量。',
      properties: { action: { type: 'string', enum: ['list', 'run'] }, task: { type: 'string', description: '运行时的完整任务名' } },
      required: ['action'],
      execute: async ({ action, task: name }) => {
        if (action === 'list') return { ok: true, tasks: store.state().tasks.map((t) => ({ name: t.name, enabled: t.enabled, lastStatus: t.lastStatus || 'never' })) }
        const found = store.state().tasks.find((t) => t.name === String(name || ''))
        if (!found) return { ok: false, message: '没找到完整任务名，请先列出任务' }
        return runner.run(found.id)
      },
    }) : [])
    return { state, sync: runner.sync, run: runner.run, stop: runner.stop, dispose: runner.dispose }
  },
}
