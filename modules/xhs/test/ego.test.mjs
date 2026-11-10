// ego 后端回归测试：冷启动给子进程的环境不能把「宿主自带的无头」继承下去。
//
// 背景：EGO_LINUX_HEADLESS 有三个来源 —— 系统环境变量、宿主进程（DSH 在某些装法下
// 自己带着 =1）、面板里的 headless override。桌面平台上头两个都不是用户选的，
// 继承下去等于每次冷启动都拉起无头实例：没窗口没法扫码登录，页面按后台节流渲染，
// 卡片量成 0×0，解析全空后才退到滚动兜底（xhs 的 b.scroll 就是这么炸的）。
// 这组测试锁住判定规则本身，不启动浏览器。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { egoChildEnv } from '../lib/ego.mjs'

test('桌面平台剥掉宿主继承的无头标记（win32 / darwin）', () => {
  for (const plat of ['win32', 'darwin']) {
    const env = egoChildEnv({ EGO_LINUX_HEADLESS: '1' }, plat)
    assert.equal(env.EGO_LINUX_HEADLESS, undefined, plat + ' 不该继承无头标记')
    // 其它变量原样带过去，只摘这一个键
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1', '仍要设 ELECTRON_RUN_AS_NODE')
  }
})

test('Linux 无显示环境仍尊重原变量（服务器 / CI 不被打坏）', () => {
  const env = egoChildEnv({ EGO_LINUX_HEADLESS: '1' }, 'linux')
  assert.equal(env.EGO_LINUX_HEADLESS, '1', 'linux 不该被改写')
})

test('显式要无头时保留（AURABOT_EGO_HEADLESS=1 是用户自己的意思）', () => {
  for (const value of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    const env = egoChildEnv({ EGO_LINUX_HEADLESS: '', AURABOT_EGO_HEADLESS: value }, 'win32')
    assert.equal(env.EGO_LINUX_HEADLESS, '1', 'value=' + value + ' 应保留无头')
  }
})

test('显式值不是真值时按无头处理掉（别被 AURABOT_EGO_HEADLESS=0 骗了）', () => {
  for (const value of ['0', 'false', 'no', 'off', '', 'abc']) {
    const env = egoChildEnv({ EGO_LINUX_HEADLESS: '1', AURABOT_EGO_HEADLESS: value }, 'darwin')
    assert.equal(env.EGO_LINUX_HEADLESS, undefined, 'value=' + value + ' 不该无头')
  }
})

test('不改动调用方传进来的对象', () => {
  const base = { EGO_LINUX_HEADLESS: '1', PATH: '/bin' }
  const env = egoChildEnv(base, 'win32')
  assert.equal(base.EGO_LINUX_HEADLESS, '1', 'base 不该被改')
  assert.notEqual(env, base, '应返回新对象')
  assert.equal(env.PATH, '/bin', '其它变量原样保留')
})

test('Linux 下同样不改原对象，且变量原样带出', () => {
  const base = { EGO_LINUX_HEADLESS: '1' }
  const env = egoChildEnv(base, 'linux')
  assert.equal(base.EGO_LINUX_HEADLESS, '1')
  assert.equal(env.EGO_LINUX_HEADLESS, '1')
})
