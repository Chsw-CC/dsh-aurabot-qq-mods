// assets/enroll/enroll-form.js —— 表单判定 / 校验 / 组装 payload 的纯函数。
//
// 这里**不 import bbx.js**：本文件只做字符串与数值判断，加解密一律交给 bbx.js，
// 这样它能同时在浏览器（index.html）和 Node 单测里直接 import 使用。
//
// 判定口径与 docs/ENVELOPE.md 一致：
//   填账号+密码            -> 'login'      （安全码就是这个新账号的安全码）
//   只填安全码            -> 'unlock'
//   旧安全码 + 新安全码    -> 'changecode'
// 安全码强度只做前端提示（errors 只放结构性错误，warnings 放「太弱」这类建议），
// 最终以服务端 checkCodeStrength / vault 的判定为准。

export const TTL_MIN = 1
export const TTL_MAX = 1440
export const CODE_MIN = 8
export const CODE_MAX = 128
export const CODE_DIGITS_MIN = 10
export const ACCOUNT_MAX = 200
export const PASSWORD_MAX = 256
export const REGIONS = ['cn', 'us', 'eu']
/** 页面下拉框的默认值，和 index.html 里 <option selected> 那一项一致。 */
export const REGION_OPTIONS = [
  { value: 'cn', label: '中国大陆（bambulab.cn）' },
  { value: 'us', label: '国际（bambulab.com）' },
  { value: 'eu', label: '欧洲' },
]
// 网页没给区域时按中国大陆处理（大多数用户是国服账号）。
// 注意：这不是 lib/cloud.mjs 的 DEFAULT_REGION（那一个故意保持 us，见那边的注释）；
// 这里只是这份网页表单的默认值，用户能在页面上改。
export const DEFAULT_REGION = 'cn'
export const DEFAULT_TTL_MIN = 60

/** 三种信封用途的短标签（界面直接用，避免各处再写一遍）。 */
export const KIND_LABELS = {
  login: '登录',
  unlock: '解锁',
  changecode: '改安全码',
}

/** 每种用途的一句话说明（界面提示用）。 */
export const KIND_HINTS = {
  login: '会用这个安全码建号（如果还没有），然后登录 Bambu 云端。',
  unlock: '只解锁，不改任何东西。',
  changecode: '旧安全码换成新安全码，账号和密码要留空。',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_RE = /^\d{5,15}$/

// 与服务端 checkCodeStrength 保持同一份常见弱串表（只用于提示，不拦截）。
const WEAK_SUBSTRINGS = [
  'qwerty', 'qwertyui', 'asdfgh', 'zxcvbn', 'password', 'passwd', 'letmein',
  'admin', 'abc123', '123456', '654321', '111111', '222222', '000000', '888888',
  '999999', '666666',
]
const SEQUENCES = [
  '0123456789', '9876543210',
  'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
  'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz',
]

const utf8 = typeof TextEncoder === 'function' ? new TextEncoder() : null

function text (value) {
  return value == null ? '' : String(value)
}

function trimmed (value) {
  return text(value).trim()
}

function byteLength (value) {
  const string = text(value)
  return utf8 ? utf8.encode(string).length : string.length
}

/**
 * 有账号或有密码就算「想登录」；有新安全码就算「改安全码」。
 * 只做用途归类，不做合法性判定（冲突由 validateInputs 报错）。
 * @param {{code?:string, account?:string, password?:string, newCode?:string}} input
 * @returns {'login'|'unlock'|'changecode'}
 */
export function classify (input = {}) {
  const account = trimmed(input.account)
  const password = text(input.password)
  const newCode = trimmed(input.newCode)
  if (newCode) return 'changecode'
  if (account || password) return 'login'
  return 'unlock'
}

/** 安全码结构问题（与服务端 checkCodeStrength 的「硬规则」部分一致，只做提示）。返回问题条数。 */
function pushCodeShapeErrors (value, label, errors) {
  const before = errors.length
  if (!value) {
    errors.push(label + '不能为空')
    return errors.length - before
  }
  if (value.length < CODE_MIN) errors.push(label + '至少 ' + CODE_MIN + ' 位（现在 ' + value.length + ' 位）')
  if (value.length > CODE_MAX || byteLength(value) > CODE_MAX) errors.push(label + '最多 ' + CODE_MAX + ' 位')
  if (/\s/.test(value)) errors.push(label + '不能包含空格或换行')
  if (/^\d+$/.test(value) && value.length < CODE_DIGITS_MIN) {
    errors.push('纯数字' + label + '至少 ' + CODE_DIGITS_MIN + ' 位')
  }
  return errors.length - before
}

/** 弱码原因（不带安全码原文，只描述问题），没问题返回空串。 */
function weaknessOf (value) {
  if (!value) return ''
  if (new Set(value).size === 1) return '是同一个字符重复'
  const lower = value.toLowerCase()
  if (WEAK_SUBSTRINGS.some((weak) => lower.includes(weak))) return '含有 123456 / qwerty / password 这类常见串'
  if (SEQUENCES.some((seq) => seq.includes(lower))) return '是连续序列（如 12345678 / abcdefgh）'
  if (/^\d+$/.test(value) && new Set(value).size <= 2) return '纯数字里用到的数字太少'
  return ''
}

/**
 * 校验一份表单。不抛错，全部问题都放进返回值。
 *
 * 永远不把安全码 / 密码原文写进 errors 或 warnings（界面会直接显示这些文字）。
 *
 * @param {{code?:string, account?:string, password?:string, newCode?:string, ttlMin?:string|number|null}} input
 * @returns {{ok:boolean, errors:string[], kind:'login'|'unlock'|'changecode', warnings:string[]}}
 */
export function validateInputs (input = {}) {
  const code = trimmed(input.code)
  const account = trimmed(input.account)
  const password = text(input.password) // 密码不 trim：首尾空格也是密码的一部分
  const newCode = trimmed(input.newCode)
  const ttlRaw = input.ttlMin

  const errors = []
  const warnings = []
  const kind = classify({ code, account, password, newCode })

  const hasAccount = account.length > 0
  const hasPassword = password.length > 0
  const hasNewCode = newCode.length > 0

  // ---- 安全码（旧码 / 解锁用码）
  const codeProblems = pushCodeShapeErrors(code, '安全码', errors)

  // ---- 账号与密码必须成对
  if (hasAccount !== hasPassword) {
    errors.push('Bambu 账号和密码要一起填或一起留空（只填安全码 = 解锁；账户密码留空 + 新安全码 = 改安全码）')
  }
  if (hasAccount && hasPassword) {
    if (!EMAIL_RE.test(account) && !PHONE_RE.test(account)) {
      errors.push('Bambu 账号要填邮箱（如 name@example.com）或 5~15 位数字的手机号')
    }
    if (byteLength(account) > ACCOUNT_MAX) errors.push('Bambu 账号太长（最多 ' + ACCOUNT_MAX + ' 字节）')
    if (byteLength(password) > PASSWORD_MAX) errors.push('Bambu 密码太长（最多 ' + PASSWORD_MAX + ' 字节）')
    if (hasPassword && !password.trim()) warnings.push('Bambu 密码只有空格，确认一下没填错。')
  }

  // ---- 新安全码（改码用）
  if (hasNewCode) {
    if (hasAccount || hasPassword) {
      errors.push('改安全码时不要填 Bambu 账号或密码：一个信封只能做一件事')
    }
    const newProblems = pushCodeShapeErrors(newCode, '新安全码', errors)
    if (newCode && code && newCode === code) warnings.push('新安全码和旧安全码一样，改了等于没改。')
    const weakNew = newProblems ? '' : weaknessOf(newCode)
    if (weakNew && newCode.length >= CODE_MIN) {
      warnings.push('新安全码偏弱（' + weakNew + '），改码时服务端可能直接拒绝。')
    }
  }

  // ---- 生存时间
  const ttlText = trimmed(ttlRaw)
  const ttlNum = ttlText === '' ? NaN : Number(ttlText)
  if (!Number.isFinite(ttlNum)) {
    errors.push('生存时间要填 ' + TTL_MIN + '~' + TTL_MAX + ' 的整数分钟')
  } else if (!Number.isInteger(ttlNum)) {
    errors.push('生存时间必须是整数分钟')
  } else if (ttlNum < TTL_MIN || ttlNum > TTL_MAX) {
    errors.push('生存时间要在 ' + TTL_MIN + '~' + TTL_MAX + ' 分钟之间')
  }

  // ---- 强度提示（不拦截：最终以服务端为准；结构本身就不对时不再叠一条弱码提示）
  const weak = codeProblems ? '' : weaknessOf(code)
  if (weak && code.length >= CODE_MIN) {
    if (kind === 'login') warnings.push('这个安全码偏弱（' + weak + '）：如果是新建账号，服务端会直接拒绝。')
    else if (kind === 'unlock') warnings.push('这个安全码偏弱（' + weak + '），能解锁就说明之前已经建过号了。')
    else if (kind === 'changecode') warnings.push('旧安全码偏弱（' + weak + '），不影响这次改码。')
  }

  return { ok: errors.length === 0, errors, kind, warnings }
}

/**
 * 组装 bbx.sealEnvelope 需要的明文 body。
 * 只拼数据，不做合法性判定（先调 validateInputs）。
 *
 * @param {{code?:string, account?:string, password?:string, newCode?:string, ttlMin?:string|number, region?:string, now?:number}} input
 *        now：Unix 秒，缺省取当前时间；单测可注入。
 * @returns {{code:string, account:string, password:string, newCode:string, ttlMin:number, region:string, iat:number, exp:number}}
 */
export function buildPayload (input = {}) {
  const ttlMin = Math.round(Number(input.ttlMin))
  const nowRaw = Number(input.now)
  const iat = Number.isFinite(nowRaw) && nowRaw > 0 ? Math.floor(nowRaw) : Math.floor(Date.now() / 1000)
  const region = REGIONS.includes(trimmed(input.region).toLowerCase())
    ? trimmed(input.region).toLowerCase()
    : DEFAULT_REGION
  return {
    code: trimmed(input.code),
    account: trimmed(input.account),
    password: text(input.password), // 密码原样保留（不 trim）
    newCode: trimmed(input.newCode),
    ttlMin,
    region,
    iat,
    exp: iat + ttlMin * 60,
  }
}

/**
 * 账号掩码：'a***@b.com' / '138****8888'。空值返回空串。
 * 只在界面上展示用，不参与加密。
 */
export function maskAccount (account) {
  const value = trimmed(account)
  if (!value) return ''
  const at = value.indexOf('@')
  if (at > 0 && at < value.length - 1) {
    const local = value.slice(0, at)
    return local[0] + '***@' + value.slice(at + 1)
  }
  const digits = value.replace(/[^\d]/g, '')
  const body = PHONE_RE.test(value) ? value : digits || value
  const len = body.length
  if (len <= 1) return '*'
  const head = len >= 11 ? 3 : len >= 9 ? 2 : 1
  const tail = len >= 11 ? 4 : len >= 9 ? 3 : 2
  if (head + tail >= len) return body.slice(0, 1) + '****'
  return body.slice(0, head) + '****' + body.slice(len - tail)
}
