/**
 * mod-scan.mjs —— 她自写模块的静态闸门
 *
 * `newmod` 动作允许模型写一个新模块并热加载。这是本模块里唯一能让模型**间接影响代码**
 * 的地方，所以两道闸：
 *   1. 默认关闭（settings.allowNewMod，默认 false）
 *   2. 就算打开了，写出来的代码也要过这里——禁用一切进程、网络、内部对象、动态求值入口
 *
 * 这不是沙箱，是降低误伤和恶意形状的门槛；真正的边界是「默认不给她写」。
 */

/** 禁用的模块/接口：命中即拒，理由是给人看的。 */
const BANNED = [
  // 起进程 / 直接碰系统
  { re: /\bchild_process\b/, why: '不允许起子进程' },
  { re: /\bnode:(os|v8|vm|worker_threads|cluster)\b/, why: '不允许碰底层系统接口' },
  { re: /\b(execFile|execSync|spawnSync|fork)\s*\(/, why: '不允许执行外部命令' },
  { re: /\bprocess\.(binding|dlopen|kill|setuid)\b/, why: '不允许操作进程' },
  // 网络直连
  { re: /\bnode:(net|tls|dgram|https?)\b/, why: '不允许直接连网络' },
  { re: /\bnew\s+(WebSocket|TCPSocket)\b/, why: '不允许开网络连接' },
  { re: /\bfetch\s*\(/, why: '不允许自己发网络请求' },
  // 动态求值
  { re: /\beval\s*\(/, why: '不允许 eval' },
  { re: /\bnew\s+Function\s*\(/, why: '不允许 new Function' },
  { re: /\bFunction\s*\(\s*['"`]/, why: '不允许动态构造函数' },
  // 插件内部对象（这一层权限太大）
  { re: /\bapi\.(core|lib|dsh)\b/, why: '不允许用插件内部对象' },
  { re: /\bglobalThis\.aurabot/, why: '不允许拿全局句柄' },
  // 文件系统越界：只允许 api.dataDir() 底下
  { re: /\bfs\.(unlink|rm|rmdir|rename|chmod|chown|symlink|lchmod)\s*\(/, why: '不允许删除/改权限/改属主' },
  { re: /\b(fs|fsp|fsPromises)\.\w*(Sync)?\s*\([^)]*0o?7{3}/, why: '不允许给 777 权限' },
  { re: /['"`](?:[A-Za-z]:[\\/]|\/(?:etc|usr|bin|sbin|var|root|home)\/)/, why: '不允许写系统路径' },
  { re: /\.\.\//, why: '不允许路径穿越' },
]

/** 必须有的形状：一个模块定义。 */
const REQUIRED = /\bexport\s+default\s*\{/

/**
 * 扫描一段模块源码。
 * @param {string} code
 * @returns {{ok: boolean, reason?: string, hits?: string[]}}
 */
export function scanModuleCode(code) {
  const src = String(code || '')
  if (!src.trim()) return { ok: false, reason: '没有代码' }
  if (src.length > 60_000) return { ok: false, reason: '代码太长了（上限 60KB）' }
  if (!REQUIRED.test(src)) return { ok: false, reason: '代码里没有 export default { ... }，模块加载不了' }

  const hits = []
  for (const { re, why } of BANNED) {
    if (re.test(src)) hits.push(why)
  }
  if (hits.length) return { ok: false, reason: '代码里有不允许的东西：' + hits.join('；'), hits }
  return { ok: true }
}

/** 只给测试和文档用 */
export const BANNED_RULES = BANNED.map((b) => ({ pattern: b.re.source, why: b.why }))
