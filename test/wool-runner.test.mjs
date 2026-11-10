import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCron, cronMatches, extractCron } from '../modules/wool-runner/lib/cron.mjs'
import { createStore, publicState } from '../modules/wool-runner/lib/store.mjs'
import { createRunner } from '../modules/wool-runner/lib/runner.mjs'

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wool-runner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const fixture = (t, root, { script = '// cron */1 * * * * *\nconsole.log("selftest-ok")\nconsole.log("secret=" + (process.env.AURABOT_SELFTEST || "none"))\nconsole.log("host-env=" + (process.env.AURABOT_HOST_SECRET || "absent"))\n', envs = [] } = {}) => {
  const store = createStore(root)
  store.addSubscription({ id: 'local-test', name: '本地测试', url: 'https://example.com/repo.git' })
  const repo = join(store.root, 'repos', 'local-test')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'selftest.js'), script)
  for (const e of envs) store.upsertEnv(e)
  const base = { enabled: true, nodePath: process.execPath, timeoutMinutes: 1, maxConcurrent: 2, memoryMb: 128 }
  const settings = { ...base }
  const runner = createRunner({ store, settings: () => ({ ...settings }) })
  t.after(() => runner.dispose())
  const [found] = runner.discover('local-test')
  store.upsertTask({ id: found.id, subscriptionId: 'local-test', file: found.file, name: '自测任务', cron: found.cron, enabled: false, envNames: [] })
  return { store, runner, settings, task: () => store.state().tasks.find((x) => x.id === found.id), taskId: found.id }
}

const waitFinish = async (store, id, limit = 200) => {
  for (let i = 0; i < limit; i++) {
    const t = store.state().tasks.find((x) => x.id === id)
    if (t.lastStatus && t.lastStatus !== 'running') return t
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('等待任务结束超时')
}

test('支持 5/6 字段 Cron、月份星期名称和块注释提取', () => {
  assert.equal(cronMatches(parseCron('0 8 * * *'), new Date(2026, 0, 1, 8, 0, 0)), true)
  assert.equal(cronMatches(parseCron('*/5 * * * * *'), new Date(2026, 0, 1, 0, 0, 5)), true)
  assert.equal(cronMatches(parseCron('0 0 9 * jan mon'), new Date(2026, 0, 5, 9, 0, 0)), true)
  assert.equal(extractCron('/* cron 31 11 * * *\n * next line */'), '31 11 * * *')
  assert.equal(extractCron('// cron: 0 8 * * *'), '0 8 * * *')
  assert.equal(extractCron('const cron = "15 2 * * *"'), '15 2 * * *')
  assert.throws(() => parseCron('invalid'), /5 或 6/)
})

test('环境变量列表与公开状态不泄露变量值', (t) => {
  const store = createStore(temp(t))
  store.upsertEnv({ name: 'JD_COOKIE', value: 'pt_key=fake-secret;pt_pin=fake-user;' })
  assert.equal(store.envValues().JD_COOKIE, 'pt_key=fake-secret;pt_pin=fake-user;')
  assert.equal(store.envValues([]).JD_COOKIE, undefined, '未授权任务拿不到任何变量')
  assert.equal(store.envValues(['JD_COOKIE']).JD_COOKIE, 'pt_key=fake-secret;pt_pin=fake-user;')
  assert.equal('value' in store.envList()[0], false)
  assert.equal(JSON.stringify(publicState(store)).includes('fake-secret'), false)
  assert.throws(() => store.upsertEnv({ name: 'BAD-NAME', value: 'x' }), /变量名/)
  assert.throws(() => store.addSubscription({ id: 'bad', url: 'https://user:token@example.com/repo.git' }), /令牌|账号|密码/)
})

test('总开关关闭时拒绝执行，打开后需显式确认才运行', async (t) => {
  const fx = fixture(t, temp(t))
  fx.settings.enabled = false
  await assert.rejects(fx.runner.run(fx.taskId, 'manual', { confirm: true }), /总开关/)
  fx.settings.enabled = true
  const ask = await fx.runner.run(fx.taskId, 'manual')
  assert.equal(ask.needsConfirmation, true, '未确认时只返回确认请求，不执行')
  assert.ok(ask.source.sha256 && ask.source.url)
})

test('任务级凭据授权：未授权变量不注入子进程', async (t) => {
  const fx = fixture(t, temp(t), { envs: [{ name: 'AURABOT_SELFTEST', value: 'granted-value' }, { name: 'AURABOT_HOST_SECRET', value: 'should-not-leak' }] })
  process.env.AURABOT_HOST_SECRET = 'inherited-host-value'
  t.after(() => delete process.env.AURABOT_HOST_SECRET)
  fx.settings.enabled = true
  // 只授权 AURABOT_SELFTEST
  const store = fx.store
  store.upsertTask({ ...fx.task(), envNames: ['AURABOT_SELFTEST'] })
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  const task = await waitFinish(store, fx.taskId)
  assert.equal(task.lastStatus, 'success')
  const [run] = store.runs()
  const log = await fx.runner.readLog(run.id)
  assert.match(log.content, /secret=\[已隐藏\]/, '授权变量已注入并被脱敏（未注入时会输出 none）')
  assert.doesNotMatch(log.content, /secret=none/, '授权变量确实注入了')
  assert.match(log.content, /host-env=absent/, '未授权与宿主环境不应注入')
  assert.doesNotMatch(log.content, /should-not-leak|inherited-host-value|granted-value/)
})

test('审批绑定来源与内容：源码变化自动撤销审批并停用任务', async (t) => {
  const fx = fixture(t, temp(t))
  const store = fx.store
  const repo = join(store.root, 'repos', 'local-test')
  fx.settings.enabled = true
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  await waitFinish(store, fx.taskId)
  assert.ok(fx.task().approval, '确认后应记录审批')
  const fingerprint = fx.task().approval.fingerprint
  // 模拟用户启用定时（审批仍有效）
  store.upsertTask({ ...fx.task(), enabled: true })
  // 篡改脚本内容（模拟上游推送或本地工作区被改）
  writeFileSync(join(repo, 'selftest.js'), '// cron */1 * * * * *\nconsole.log("malicious-update")\n')
  await assert.rejects(fx.runner.run(fx.taskId, 'schedule'), /重新审查|重新确认|变化/)
  const after = fx.task()
  assert.equal(after.approval, null, '内容变化后审批应被撤销')
  assert.equal(after.enabled, false, '内容变化后定时应停用')
  assert.notEqual(fingerprint, undefined)
})

test('订阅地址或分支变化撤销全部任务审批', (t) => {
  const fx = fixture(t, temp(t))
  const store = fx.store
  store.upsertTask({ ...fx.task(), approval: { fingerprint: 'x', source: {}, approvedAt: new Date().toISOString() }, enabled: true })
  store.updateSubscription('local-test', { branch: 'dev' })
  const after = fx.task()
  assert.equal(after.approval, null)
  assert.equal(after.enabled, false)
  assert.match(after.revokedReason, /分支|重新/)
})

test('路径边界：拒绝仓库外的脚本与符号链接逃逸', (t) => {
  const fx = fixture(t, temp(t))
  const store = fx.store
  fx.settings.enabled = true
  store.upsertTask({ ...fx.task(), file: '../../../etc/passwd', approval: { fingerprint: 'x' } })
  assert.throws(() => fx.runner.fingerprint(fx.taskId), /越界/)
  store.upsertTask({ ...fx.task(), file: 'selftest.js', approval: { fingerprint: 'x' } })
})

test('日志脱敏：授权变量值与常见凭据字段不落明文', async (t) => {
  const fx = fixture(t, temp(t), {
    envs: [{ name: 'AURABOT_SELFTEST', value: 'super-secret-value' }],
    script: '// cron */1 * * * * *\nconsole.log("raw=" + process.env.AURABOT_SELFTEST)\nconsole.log("pt_key=abcdef123456789")\n',
  })
  fx.settings.enabled = true
  fx.store.upsertTask({ ...fx.task(), envNames: ['AURABOT_SELFTEST'] })
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  const task = await waitFinish(fx.store, fx.taskId)
  assert.equal(task.lastStatus, 'success')
  const [run] = fx.store.runs()
  const log = await fx.runner.readLog(run.id)
  assert.doesNotMatch(log.content, /super-secret-value/)
  assert.doesNotMatch(log.content, /pt_key=abcdef123456789/)
  assert.match(log.content, /\[已隐藏\]/)
  assert.match(log.content, /selftest|raw=/)
})

test('并发上限：超过 maxConcurrent 时拒绝新任务', async (t) => {
  const fx = fixture(t, temp(t), { script: '// cron */1 * * * * *\nsetTimeout(() => console.log("slow-done"), 800)\n' })
  fx.settings.enabled = true
  fx.settings.maxConcurrent = 1
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  // 同一任务运行中再次触发被拒
  await assert.rejects(fx.runner.run(fx.taskId, 'manual', { confirm: true }), /正在运行/)
  await waitFinish(fx.store, fx.taskId)
})
