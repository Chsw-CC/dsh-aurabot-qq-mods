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
  assert.equal('value' in store.envList()[0], false)
  assert.equal(JSON.stringify(publicState(store)).includes('fake-secret'), false)
  assert.throws(() => store.upsertEnv({ name: 'BAD-NAME', value: 'x' }), /变量名/)
})

test('本地脚本运行、Cron 发现、运行记录与日志脱敏形成闭环', async (t) => {
  const store = createStore(temp(t))
  store.addSubscription({ id: 'local-test', name: '本地测试', url: 'https://example.com/repo.git' })
  const repo = join(store.root, 'repos', 'local-test')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'selftest.js'), '// cron */1 * * * * *\nconsole.log("selftest-ok")\nconsole.log("secret=" + process.env.AURABOT_SELFTEST)\n')
  store.upsertEnv({ name: 'AURABOT_SELFTEST', value: 'fake-secret-value' })
  const runner = createRunner({ store, settings: () => ({ nodePath: process.execPath, timeoutMinutes: 1 }) })
  t.after(() => runner.dispose())
  const [script] = runner.discover('local-test')
  assert.equal(script.cron, '*/1 * * * * *')
  store.upsertTask({ id: script.id, subscriptionId: 'local-test', file: script.file, name: '自测任务', cron: script.cron, enabled: false })
  const started = await runner.run(script.id)
  let task
  for (let i = 0; i < 100; i++) {
    task = store.state().tasks.find((x) => x.id === script.id)
    if (task.lastStatus && task.lastStatus !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(task.lastStatus, 'success')
  const result = await runner.readLog(started.runId)
  assert.match(result.content, /selftest-ok/)
  assert.match(result.content, /secret=\[已隐藏\]/)
  assert.doesNotMatch(result.content, /fake-secret-value/)
  assert.equal(readFileSync(join(store.root, 'env.json'), 'utf8').includes('fake-secret-value'), true, '变量仅在本机私密存储中')
})
