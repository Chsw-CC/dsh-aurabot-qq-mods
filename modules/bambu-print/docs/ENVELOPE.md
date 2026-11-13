# 信封（envelope）：离线加密登录凭证

模块 `bambu-print` 的 Bambu 账号 / 密码**永远不经过聊天**。
用户在 GitHub Pages 的静态网页里填写，网页在浏览器本地用**本机公钥**加密成一段短文本
（下称「信封」），用户只把这段密文贴给机器人。机器人用自己的私钥解开，用完即弃。

本文件是 `assets/enroll/bbx.js`（浏览器与 Node 共用的唯一实现）、`lib/envelope.mjs`（服务端
私钥 / 一次性 / 有效期策略）和静态网页三者之间的契约。改格式先改这里。

## 1. 为什么是公钥

| 方案 | 问题 |
|---|---|
| 对称加密 + 共享密钥 | 共享密钥必须写进静态网页（公开仓库）→ 谁都能解 |
| 对称加密 + 口令派生 | 机器人拿不到口令就解不开，等于没解决「密码不进聊天」 |
| **公钥（本机生成，只公开公钥）** | 网页只能加密；只有这台机器上的私钥能解。静态网页公开也不影响 |

私钥 `bbx-key.json` 只落在 `api.dataDir()`，0600，永不导出、永不出现在日志 / 聊天 / 面板。
公钥通过链接 `.../enroll/#k=<87 字符>` 交给网页。换机器 = 换私钥，旧链接立即作废（这是特性）。

## 2. 信封文本

```
BBX1.<base64url(二进制)>
```

base64url 用 `-_ ` 之外的 `_-?`：**URL 安全字母表，无填充**（`A-Za-z0-9-_`）。
解析时容忍首尾空白、换行、全角空格；整串上限 4096 字符。

### 2.1 外层二进制（`BBX1` v1，suite 1）

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 4 | magic | ASCII `BBX1` |
| 4 | 1 | ver | `1` |
| 5 | 1 | suite | `1` = P-256 ECDH + HKDF-SHA256 + AES-256-GCM |
| 6 | 65 | ephemeral | 一次性 P-256 公钥，**未压缩点** `0x04 || X(32) || Y(32)` |
| 71 | 16 | salt | HKDF salt |
| 87 | 12 | iv | AES-GCM nonce |
| 99 | n | ciphertext | 明文 body 的密文 |
| 99+n | 16 | tag | GCM tag |

- **AAD = 前 99 字节原样**（magic + ver + suite + ephemeral + salt + iv），任何一位被改都会解密失败。
- 总长下限 99 + 1 + 16；上限 99 + 4096 + 16。

### 2.2 密钥派生

```
shared = ECDH-P256(ephemeralPrivate, recipientPublic)      // 32B
prk    = HKDF-Extract(salt, shared)
key    = HKDF-Expand(prk, info = "bambu-print/envelope/v1", 32)
```
用 WebCrypto 的 `HKDF` + `deriveKey({name:'AES-GCM', length:256})` 一步完成即可，
info 必须逐字节等于 `bambu-print/envelope/v1`（UTF-8）。

### 2.3 明文 body（`BBXB` v1）

大端序，定长前缀 + 4 个「长度前缀」字段：

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 4 | magic | ASCII `BBXB` |
| 4 | 1 | bodyVer | `1` |
| 5 | 1 | flags | 保留位；bit1 恒为 1（带账号）。**只做一致性校验** |
| 6 | 4 | iat | 签发时间，Unix **秒**（u32） |
| 10 | 4 | exp | 失效时间，Unix **秒**（u32），`exp = iat + ttl*60` |
| 14 | 2 | ttlMin | 生存时间（分钟，u16），1..1440 |
| 16 | 1 | region | `0`=us，`1`=eu，`2`=cn |
| 17 | 16 | jti | 一次性随机值（16B），服务端据此防重放 |
| 33 | 2 | accountLen | Bambu 账号 UTF-8 字节数，1..200 |
| .. | * | account | 账号（邮箱或手机号） |
| .. | 2 | passwordLen | 密码 UTF-8 字节数，1..256 |
| .. | * | password | 密码 |

定长前缀 33 字节 + 2 个长度前缀 4 字节 = 37 字节起。

只有一种用法：**登录**（账号 + 密码，两者都必须有）。







account 或 password 缺一个就是 `BAD_PAYLOAD`。

## 3. 服务端策略（`lib/envelope.mjs`）

- `ensureKeyPair(dir)` → 首次生成并落盘 `bbx-key.json`（0600），之后复用。
- `publicKeyOf()` → 87 字符 b64url 点；`enrollLink(baseUrl, publicKey)` → `<base>#k=<pub>`。
- `open(text)` → 解密 + 解析 + 校验，返回 `{ account, password, iat, exp, ttlMin, region, jti }`。
  错误码：`BAD_FORMAT` / `BAD_VERSION` / `BAD_SUITE` / `TOO_LARGE` / `BAD_TAG` / `BAD_PAYLOAD` /
  `EXPIRED` / `NOT_YET` / `REPLAYED` / `BAD_INPUT`。
- 时间检查：`now > exp + SKEW(120s)` → `EXPIRED`；`iat > now + SKEW` → `NOT_YET`。
  生存时间上限由设置 `enrollMaxTtlMinutes`（默认 1440，上限 1440）兜底：`ttlMin > 上限` 视为 `BAD_PAYLOAD`。
  网页上默认填的是另一个设置 `enrollTtlMinutes`（默认 60）——这两个键在 `normalizeSettings` 里做了
  交叉约束：`max` 不允许小于 `ttl`，否则「网页按默认值生成、服务端自己拒掉」。
- 一次性：`jti` 首次成功解密后记入 `bbx-used.json`（`{ v:1, used: { jti: exp } }`，0600，按 exp 清理），
  重复提交 → `REPLAYED`。**先记账再执行**，失败也作废（防止对着同一个信封暴力试）。
- 解密失败与过期都不透露原因细节（统一中文话术），日志只记错误码与 jti 前 4 字节。

## 4. 静态网页（`assets/enroll/`）

- `index.html`：唯一页面，无构建、无依赖、无网络请求（除同目录的 `bbx.js` / `enroll-form.js`）。
- `bbx.js`：**唯一加解密实现**（ESM，`globalThis.crypto.subtle`，能在 Node 22 里直接 import 做互操作测试）。
- `enroll-form.js`：纯函数 `validateInputs` / `buildPayload`，同样可在 Node 里测。
- 页面从 `location.hash` 的 `k=` 取公钥；没有就显示「先用 /打印机 登录 拿链接」并允许手动粘贴公钥。
- 生成后：只展示一段文本 + 复制按钮，明确写「这段里是你的秘密，只在私聊发，发完删掉」。
- 页面**不保存**任何输入到 localStorage；离开即丢（输入框只有当前会话的内存）。
