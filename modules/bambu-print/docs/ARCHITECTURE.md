# bambu-print 内部架构与接口契约

模块 id：`bambu-print`，中文名「拓竹打印机」。Aurabot 用户模块（api 1，minPluginVersion 1.2.0）。
只用 Node 内置模块（node:net / node:tls / node:crypto / node:fs），**不允许 npm 依赖**。
用户可见文字一律中文。仓库根：`F:/dsh-aurabot-qq-mods`。

本文件是协议层（lib/mqtt.mjs、printer.mjs、camera.mjs、cloud.mjs、status.mjs）与安全层
（lib/crypto.mjs、vault.mjs、policy.mjs）之间的契约。改动导出签名必须先改本文件。

## 局域网 TLS：打印机自签名证书

拓竹打印机的 8883（MQTT）和 6000（摄像头）都是**打印机自己生成的自签名证书**：

- 没有公共 CA 链，证书里的 CN 是序列号而不是 IP —— 默认校验必然失败；
- 直接 `rejectUnauthorized: false` 等于不校验，同网段任何人都能中间人冒充打印机，访问码就交出去了。

所以走 **TOFU（首次连接自动固定）**：

| 阶段 | 行为 |
|---|---|
| 第一次连接 | `learnOnly` 只做 TLS 握手，拿到对端证书立刻断开，**一个字节的 MQTT 都不发**（访问码不出门） |
| 落盘 | 证书 PEM + SHA-256 指纹经 `vault.setPrinterCert()` 与访问码一起加密存在 payload 里 |
| 之后每次连接 | 把该证书当 `ca` 锚点，`rejectUnauthorized: true`，指纹同时固定校验 |
| 证书变了 | `CERT_CHANGED` 拒绝覆盖，提示「可能重刷固件，也可能有人在冒充」，主人确认后 `/打印机 证书 信任` 重新固定 |

摄像头（6000）单独一个槽位（`certs.camera`），第一次拍照时同样先学后用。

证书相关命令**只给主人**：局域网接口本身就只有主人能用，其他人走云端不需要处理本地证书。
非主人发「/打印机 证书」会被告知「只提供给主人」，帮助文本里也不会出现这几行；
被授权的打印机如果证书变了，提示语会指向**绑定者**（他才能重新固定），而不是受权人。

`lib/tls-cert.mjs` 另外提供纯 Node 的自签名证书生成器（不依赖 openssl），
生成的证书带 `CA:TRUE` + SAN + `digitalSignature/keyCertSign`，
`openssl verify` 能通过、Node 端 `authorized=true`，可作为 TLS 客户端证书材料使用。

## 0. 安全底线（所有文件都必须遵守）

1. **明文 token/访问码/安全码永不落盘、永不写日志、永不出现在返回给聊天或面板的字符串里。**
   宁可少一个功能，也不要把秘密交给调用方。日志里只能出现 `maskSecret()` 后的值。
2. 每个 QQ 用户的秘密独立加密。密钥只由该用户自己的安全码经 scrypt 派生；不引入机器主密钥，
   否则拿到整份数据目录就能解密。任何时候都拿不到别人的秘密。
3. 解密后的秘密只存在进程内存（vault 的解锁会话 / 授权会话），到期、锁定、重置、模块卸载即清零。
4. 私聊里用户发来的安全码、访问码要 `api.onebot('delete_msg', ...)` 尝试撤回（由 index 做），
   失败就提示用户手动撤回；日志只记「已收到，已脱敏」。
5. 面板接口只返回元数据（QQ 打码、绑定数、打印机数、解锁状态、授权、审计摘要），
   绝不返回 secret。没有任何「导出/查看 token」接口。

## 1. 数据文件（api.dataDir()）

- `vault.json`：用户记录 + 加密后的绑定向导（见下）。权限 0600，目录 0700，原子写（tmp+rename）。
- `grants.json`：授权记录（谁授权给谁、哪几个绑定、范围、到期；**不含秘密，也没有可解密的密文**）。
- `audit.jsonl`：一行一条 JSON，超 2MB 轮转为 `audit.1.jsonl`。

### vault.json 结构

```json
{
  "v": 1,
  "users": {
    "<qq>": {
      "v": 1,
      "salt": "<base64 16B>",
      "wrapped": { "v": 1, "iv": "<b64>", "tag": "<b64>", "data": "<b64>" },
      "createdAt": 0,
      "updatedAt": 0,
      "lastSeenAt": 0,
      "prefs": { "groupShowName": false, "selectedPrinter": "" }
    }
  },
  "attempts": { "<qq>": { "fails": 0, "lockedUntil": 0 } }
}
```

- `wrapped` = AES-256-GCM(DEK, JSON payload, aad=`user:<qq>`)。
- DEK = 随机 32B；KEK = scrypt(安全码, salt, N=32768, r=8, p=1, keyLen=32, maxmem>=64MB)；
  `wrapped` 存的是把 DEK 用 KEK 包起来的结果（AAD 同上）。**没有**独立的密码 hash，
  解密失败（GCM tag）就是安全码错误。
- payload 明文结构（只在内存里出现）：

```json
{
  "v": 1,
  "bindings": [
    {
      "id": "b_xxxxxxxx",
      "label": "我的 A1",
      "mode": "lan",
      "secret": { "accessCode": "12345678" },
      "printers": [ { "serial": "01S00A123456789", "ip": "192.168.1.50", "name": "A1", "model": "A1" } ],
      "createdAt": 0
    },
    {
      "id": "b_yyyyyyyy",
      "label": "云端账号",
      "mode": "cloud",
      "secret": { "accessToken": "…", "uid": "123456", "region": "us" },
      "printers": [ { "serial": "…", "name": "X1C", "model": "X1C" } ],
      "createdAt": 0,
      "discoveredAt": 0
    }
  ]
}
```

- LAN 模式：`secret.accessCode` 是该凭据下打印机的访问码；`printers[]` 每台带 `serial`+`ip`，
  可选单独 `accessCode` 覆盖（vault.secret 只返回凭据级；index 用 `printer.ref` 里的 effectiveSecret）。
- 云端模式：一个 token 对应多台打印机；`printers[]` 由 cloud.listDevices 发现后写入。
- 安全码强度：长度 >= 8；纯数字必须 >= 10 位；不能是同一字符重复、不能是 12345678/87654321/
  qwerty 之类常见串。`normalizeCode()` 只 trim，不改大小写（大小写敏感）。
- 连续输错 5 次锁 15 分钟，第 10 次锁 60 分钟；锁定期内 unlock 抛 `LOCKED_OUT`。
  失败次数/锁定时间持久化在 vault.json 的 attempts 里（不含秘密）。

### grants.json 结构

```json
{
  "v": 1,
  "grants": [
    {
      "id": "g_xxxxxxxx",
      "ownerQQ": "111",
      "granteeQQ": "222",
      "scopes": ["status", "control", "photo"],
      "bindings": [ { "id": "b_x", "label": "我的 A1", "mode": "lan",
                      "printers": [ { "serial": "01S…", "name": "A1", "model": "A1" } ] } ],
      "createdAt": 0,
      "expiresAt": 0,
      "revokedAt": 0
    }
  ]
}
```

- 用户（owner）解锁后发起授权：只记「授权给谁、哪几个绑定（id + 展示元数据）、什么范围、到什么时候」，
  **不写秘密，也不写任何能解出秘密的密钥**。受权人操作时，秘密从 owner 自己的保险箱现解现用
  （所以 owner 要保持解锁）；revoke / 到期立即失效。
- 受权人（grantee）不需要兑换：grants 里属于自己、未撤销、未过期的记录本身就是许可；
  需要秘密时由**所有者的 DEK** 现解（所以所有者必须在解锁状态）
  （GCM tag 校验），命中的那条把 printerRefs+scopes 放进内存 grant session（到期清空）。
- 没有授权码：授权按 QQ 直接生效，少一个能泄露的字符串，也少一步人工转发。
- 授权范围只含被选中的绑定，**不是整个 vault**，所以对方最多拿到 owner 主动给的那几台。
- grant 默认 30 分钟，上限 24 小时；owner 可随时 revoke。grantee 没有名单限制（不能是自己）；
  旧版的 `settings.admins` 已废弃，不再提升任何人的权限
  （或主人），由 index 校验。

## 2. lib/crypto.mjs

```js
export const DEFAULT_KDF = { N: 32768, r: 8, p: 1, keyLen: 32 }
export function randomBytes(n) -> Buffer
export function randomToken(bytes = 32) -> string        // base64url
export function randomGrantCode() -> string              // 12 位 Crockford Base32，去掉 ILOU
export function newSalt() -> Buffer                      // 16B
export function normalizeCode(input) -> string           // trim；空串原样返回
export function checkCodeStrength(code) -> { ok: boolean, reason: string }  // 见上，reason 中文
export async function deriveKey(code, salt, opts = {}) -> Buffer(32)        // scrypt，opts 覆盖 DEFAULT_KDF
export function seal(key, plaintext, aad) -> { v:1, iv, tag, data }         // 均为 b64；key 32B
export function open(key, box, aad) -> Buffer                               // 解密失败抛 CryptoError('BAD_TAG')
export function sealJson(key, value, aad) -> box
export function openJson(key, box, aad) -> any
export function wrapKey(kek, dek, aad) -> box
export function unwrapKey(kek, box, aad) -> Buffer(32)
export function maskSecret(value, keep = 4) -> string   // '••••' + 末 keep 位；短值全遮
export function clearBuffer(buf)                        // 全 0
export class CryptoError extends Error { code }
```

scrypt 用 `node:crypto` 的异步版（promisify），`maxmem` 至少 `128*N*r*2`。
所有 b64 字段用标准 base64。

## 3. lib/vault.mjs

```js
export class VaultError extends Error { code }  // NO_USER / EXISTS / BAD_CODE / LOCKED_OUT / LOCKED / WEAK_CODE / NOT_FOUND / BAD_INPUT / EXPIRED
export const MIN_LOCK_MINUTES = 1440      // 1 天
export const DEFAULT_LOCK_MINUTES = 10080 // 7 天
export const MAX_LOCK_MINUTES = 43200     // 30 天
export function createVault({ dir, log = console, now = Date.now, kdf, lockMinutes = DEFAULT_LOCK_MINUTES, maxBindings = 5 })
```

方法（未标注 async 的为同步）：

- `await load()`：读 vault.json / grants.json，坏文件抛错（不要静默清空）。
- `hasUser(qq)`、`userCount()`
- `summary()` -> `{ users, boundUsers, bindings, printers, unlocked, activeGrants }`
- `listUsers()` -> `[{ qq, createdAt, updatedAt, lastSeenAt, bindings, printers, unlocked, lockedUntil }]`
  （不含任何 secret；qq 由调用方决定是否打码）
- `isUnlocked(qq)`、`lock(qq)`、`lockAll()`
- `setLockMinutes(minutes)`：解锁滑窗长度（分钟），夹到 1 天~30 天（1440~43200），默认 7 天（10080）
- `async register(qq, code)` -> `{ ok: true }`（已存在抛 EXISTS；弱码抛 WEAK_CODE）
- `async unlock(qq, code)` -> `{ ok: true, until }`（失败计数/锁定；成功后滑窗续期）
- `async changeCode(qq, oldCode, newCode)` -> `{ ok }`（重新包 DEK，不重加密 payload）
- `async wipeUser(qq)`：删除该用户记录/授权/会话（用于「忘记安全码」重置；不需要安全码，
  index 必须二次确认；删除是不可恢复的）
- `async addBinding(qq, input)` -> `{ ok, id }`（必须已解锁）
  input = `{ label, mode: 'lan'|'cloud', accessCode?, accessToken?, uid?, region?, printers? }`
  LAN 必须 accessCode + 至少一台 {serial, ip}；cloud 必须 accessToken + uid，printers 可空，
  由 index 调 cloud.listDevices 后再 `setDiscoveredPrinters(qq, id, printers)`。
- `async setDiscoveredPrinters(qq, id, printers)`、`async removeBinding(qq, id)`、
  `async renameBinding(qq, id, label)`（assemble 时都要求已解锁）
- `listBindings(qq)` -> `[{ id, label, mode, printers: [{ serial, ip, name, model }], createdAt, tokenMask: '••••1234' }]`
  只返回元数据；tokenMask 来自 secret 的掩码（不解密，仅授权会话/解锁时可算；未解锁返回 ''）。
- `printers(qq)` -> `[{ ref: "b_x:0", bindingId, bindingLabel, mode, index, serial, ip, name, model, accessCode?, tokenMask }]`
  （accessCode 只在**已解锁**时给；否则不出现该字段）
- `resolve(qq, selector)` -> `{ match: printerRef|null, candidates: printerRef[] }`
  selector：空 / 1 开始的序号 / serial / 名称子串（大小写不敏感）/ binding label / ref；多个命中返回 candidates。
  一次性给出全部候选（不发秘密），由 index 决定是否反问。
- `secretOf(qq, bindingId)` -> `{ mode, accessCode?, accessToken?, uid?, region? }`（必须解锁，否则 LOCKED）
- `prefs(qq)` -> `{ groupShowName, selectedPrinter }`；`async setPrefs(qq, patch)`（无需解锁；只是偏好）
- `async createGrant({ ownerQQ, granteeQQ, bindingIds, scopes, minutes })` -> `{ ok, code, grantId, expiresAt }`
  必须 owner 已解锁；bindingIds 空 = 该用户全部绑定；minutes 1..1440；scopes ⊆
  ['status','control','photo']；只把选中绑定的 printerRefs（含秘密）加密进 grant。
  失败抛 BAD_CODE；不把其中秘密返回给调用方。
- `grantSessions(granteeQQ)` -> `[{ grantId, ownerQQ, scopes, expiresAt }]`（不含秘密）
- `grantTargets(granteeQQ, grantIdOrOwnerQQ)` -> `{ match, candidates, scopes, ownerQQ, grantId }`
  内部用；match 含 `secret` 字段（只在模块内部使用，index 不得把 secret 拼进消息）。
  支持 selector 为空时：若只有一个可用 grant，直接返回其全部打印机（供反问）。
- `async revokeGrant({ byQQ, grantId })`：owner 或 grantee 或主人调用（index 校验角色），
  删除记录并清内存会话。
- `listGrants()` -> 元数据 `[{ id, ownerQQ, granteeQQ, scopes, bindings, createdAt, expiresAt, revoked }]`
- `async audit(entry)`：`{ actor, action, target?, ok, note? }`，自动补 at；note 必须已脱敏，
  不含 token/安全码/文件名（index 传入前自行截断）。
- `auditList(limit = 50)` -> 最近记录（倒序）。

写盘必须串行（内部 promise 队列），原子替换，文件 0600。`load()` 之前的方法抛 NOT_LOADED。

## 4. lib/policy.mjs（纯函数，无 IO）

```js
export function parseIdList(text) -> string[]            // 逗号/中文逗号/空白/换行分割，只留 4~15 位数字
export function roleOf({ userId, isOwner, settings }) -> 'owner'|'admin'|'user'|'guest'
export function checkPrivate({ userId, isOwner, settings, hasBinding }) -> { ok, reason }
export function checkGroup({ groupId, userId, settings, hasBinding }) -> { ok, reason }
export function groupMode(settings) -> 'off'|'status'|'control'
export function canControl({ chat, role, settings }) -> { ok, reason }
export function canPhoto({ chat, role, settings }) -> { ok, reason }
export function canBind({ chat, role }) -> { ok, reason }              // 只私聊
export function canGrant({ chat, role, settings }) -> { ok, reason }  // 只私聊、owner/admin
export function redaction({ chat, requesterQQ, ownerQQ, prefs, settings })
  -> { hideName: boolean, hideProject: boolean }
export function maskQQ(qq) -> string                    // 123****456
export function maskIp(ip) -> string                    // 192.168.*.*
export function createRateLimiter({ now = Date.now } = {})
  // -> { hit(key, limit, windowMs) -> { ok, retryMs }, reset(key) }
export function parseMinutes(text, fallback, max) -> number
```

规则：
- owner 恒可私聊；其他用户必须在 `settings.users` 里（没有「管理员」这一级）。
- 群：`groupId` 必须在 `settings.groups`；用户必须已有自己的绑定；groupMode off 一律拒。
  status 模式禁止暂停/继续/停止/灯/温度/速度/gcode；control 模式允许，但仍只作用于**发起人自己的**
  绑定（或别人给的授权），绝不回落到别人。
- 群消息拍照：需要 `settings.groupPhoto !== false` 且 groupMode != 'off'。
- 群默认脱敏 `hideName=true, hideProject=true`；只有 `requesterQQ === ownerQQ`
  且 `prefs.groupShowName === true` 且 `settings.allowGroupName === true` 时才 hideName=false；
  hideProject 在群里恒为 true。私聊不脱敏。
- 绑定/解绑/安全码/授权：只私聊，群里直接拒绝并提示私聊。

## 5. lib/status.mjs（纯函数）

```js
export function normalizeStatus(report, opts = {}) -> object | null
```

输入是 MQTT report 的 JSON（可能只有 `print` 部分；P1 系列是增量）。输出：

```json
{
  "state": "RUNNING", "stateText": "打印中",
  "percent": 42, "remainingMin": 98,
  "elapsedSec": 4320, "startedAt": 1710000000000,
  "layer": 56, "totalLayers": 132,
  "nozzle": 215.4, "nozzleTarget": 220, "bed": 60.1, "bedTarget": 60, "chamber": 32,
  "fileName": "Benchy.3mf", "projectName": "Benchy", "gcodeFile": "Metadata/plate_1.gcode",
  "subtask": "Benchy", "weight": 42.5,
  "ams": [ { "id": 0, "type": "PLA", "color": "#FF0000FF", "remain": 80 } ],
  "errors": [ "0700-8010" ], "wifi": -55, "speedLevel": 2, "light": true
}
```

要点：
- `print` 字段可能字符串数字；统一转 number，缺省 null（不要 0 假装有值）。
- stateText 映射：IDLE 空闲 / PREPARE 准备中 / RUNNING 打印中 / PAUSE 已暂停 / FINISH 已完成 /
  FAILED 失败 / SLICING 切片中 / 其他原样或「未知」。
- elapsedSec 优先级：`gcode_start_time`（Unix 秒，>0 时）-> opts.observedStart（模块观察到的开始时间）
  -> `remainingMin * percent / (100 - percent)` 估算（仅在 0<percent<100 且 remaining>0）-> null。
- 错误：`print_error` 非 0 → 16 进制格式；`hms` 数组每项 `{attr, code}` → `AAAA-BBBB` 字符串。
- 空 report/无 print 返回 null。

```js
export function formatDuration(seconds) -> string     // 0→'0 分钟'; <60m→'23 分钟'; 否则 '2 小时 5 分钟'; >24h '1 天 3 小时'
export function formatStatus(status, opts) -> string
```

formatStatus 选项：`{ printerName, redactName = false, redactProject = false, stale = false, now = Date.now() }`。
输出示例（多行，纯文本，不用 markdown 表格）：

```
🖨️ A1 · 打印中（42%）
第 56/132 层
已打印 1 小时 12 分钟 · 剩余 1 小时 38 分钟
预计 16:20 完成
喷嘴 215/220℃ · 热床 60/60℃ · 仓温 32℃
文件：Benchy.3mf
```

- 群聊脱敏时文件行显示 `文件：已脱敏`，且不显示 gcode/project/subtask 任何真实名字。
- 没有进度/时间时不要编造：省略对应行或写「进度未知」「剩余时间未知」。
- stale=true 时首行加「（数据可能过期）」。
- IDLE 时显示「空闲」+ 喷嘴/热床温度，不显示剩余时间。
- 错误非空时加一行 `⚠️ 错误：…`。

```js
export function formatBrief(status, { printerName, redactName }) -> string   // 单行：🖨️ A1 · 打印中 42% · 剩余 1小时38分钟
export function formatChoiceList(printers) -> string                        // 编号列表，带打印机名/型号/序列号打码
```

## 6. lib/mqtt.mjs

最小 MQTT 3.1.1 客户端（只依赖 node:tls / node:net），Bambu 局域网使用：
host 打印机 IP，port 8883，username `bblp`，password = 访问码，TLS 自签名（rejectUnauthorized:false，
可通过 `tlsFingerprint` 固定证书 sha256）。云端使用 mqtt.bambulab.com:8883，username `u_<uid>`，
password = access token。

```js
export function encodeRemainingLength(n) -> Buffer
export function decodeRemainingLength(buf, offset) -> { length, size } | null
export function encodeConnect({ clientId, username, password, keepalive = 60 }) -> Buffer
export function encodeSubscribe(packetId, topic, qos = 0) -> Buffer
export function encodePublish(topic, payload, { qos = 0, packetId = 0, retain = false } = {}) -> Buffer
export function encodePingreq() -> Buffer
export function encodeDisconnect() -> Buffer
export function decodePacket(buf) -> { type, flags, body, consumed } | null   // 不完整返回 null
export function parsePublish(body) -> { topic, payload }                      // QoS0/1
export function createMqttClient({ host, port = 8883, username, password, clientId,
  keepalive = 60, rejectUnauthorized = false, tlsFingerprint = '', connectTimeoutMs = 8000,
  log = console, connect = null }) -> client
```

client：
- `await connect()`：建 TLS、发 CONNECT、等 CONNACK（rc=0 才算成功），失败抛错（带 rc 说明）。
- `subscribe(topic, qos=0)`、`publish(topic, payload)`、`isOpen()`、`close()`。
- 事件：`on('message', (topic, payloadBuffer) => {})`、`on('close', ...)`、`on('error', ...)`；
  收到 PINGRESP 忽略；每 keepalive/2 发 PINGREQ；用 setInterval().unref()。
- 自动拒绝超过 4MB 的包；断线时所有 promise 拒绝。
- `connect` 参数用于测试注入（返回 Duplex），默认 tls.connect。
- 加密/明文由 `tls` 选项决定：`tls: false` 时用 net.connect（只给测试用）。

## 7. lib/printer.mjs

```js
export function createPrinterManager({ log = console, now = Date.now, clientFactory, statusTtlMs = 3000, idleCloseMs = 120000, lock = null })
```
- `clientFactory(opts)` 默认 `createMqttClient`；测试注入假客户端。
- `lock` 可选：`(key) => promise`，用于串行化同一台打印机的命令。

方法：
- `async status(target, { timeoutMs = 6000, force = false })`
  target = `{ mode:'lan'|'cloud', host, port, serial, accessCode?, accessToken?, uid?, region?, tlsFingerprint? }`
  返回 `{ ok:true, status, receivedAt, stale } | { ok:false, error }`。
- `async command(target, action, params)`，action：
  `pause | resume | stop | light | speed | temperature | gcode | home | pushall | raw`。
  返回 `{ ok, message, acked } | { ok:false, error }`。命令负载见下。同一 target 复用连接，
  空闲 idleCloseMs 后断开；status 用短缓存，force 跳缓存。
- `async snapshot(target, { timeoutMs = 15000 })` -> `{ ok, jpeg: Buffer } | { ok:false, error }`
  仅 LAN（云端直接返回错误「云端模式暂不支持拍照」）。
- `closeAll()`
- 导出的纯函数便于测试：`buildCommand(action, params)` -> `{ payload, expect? }`、
  `mergeReport(prev, incoming)`、`targetKey(target)`。

命令负载（sequence_id 自增字符串）：
- pause: `{print:{command:'pause'}}`；resume: `resume`；stop: `stop`
- light: `{system:{command:'ledctrl',led_node:'chamber_light',led_mode:'on'|'off',led_on_time:500,led_off_time:500,loop_times:0,interval_time:0}}`
- speed: `{print:{command:'print_speed',param:'1'..'4'}}`
- temperature: `{print:{command:'gcode_line',param:'M140 S<bed>\nM104 S<nozzle>\n'}}`（缺省项用当前值或省略）
- gcode: `{print:{command:'gcode_line',param: lines.join('\n')+'\n'}}`（总长 <= 2000 字符）
- home: gcode `G28\n`
- pushall: `{pushing:{command:'pushall',version:1,push_target:1}}`
- raw: 调用方给完整 payload 对象（仅内部/测试）
命令发布后最多等 2.5 秒回执（同 sequence_id 且 result 字段）；超时返回 ok:true, acked:false。
TLS 自签名是已知风险，README 必须写明；`tlsFingerprint` 可固定证书 sha256（十六进制，
不含冒号，大小写不敏感）。

## 8. lib/camera.mjs

```js
export function buildAuthPacket(username, accessCode) -> Buffer   // 80 字节
export async function captureFrame({ host, port = 6000, accessCode, username = 'bblp',
  timeoutMs = 15000, rejectUnauthorized = false, connect = null }) -> Buffer  // 返回 JPEG
```
- 协议：TLS 连接 6000，发 80 字节认证包（0x40, 0x3000, 0, 0 各 4B LE；username 32B 补 0；
  accessCode 32B 补 0）；读 16 字节头（前 3 字节小端 payload 长度），再读 payload，
  校验 JPEG 魔数 `FFD8FFE0` 与结尾 `FFD9`。超时/错误抛错。
- 只允许 JPEG，单帧 <= 8MB。

## 9. lib/cloud.mjs

```js
export const REGIONS = { us: { api: 'https://api.bambulab.com', mqtt: 'us.mqtt.bambulab.com' },
  eu: { api: 'https://api.bambulab.com', mqtt: 'eu.mqtt.bambulab.com' },
  cn: { api: 'https://api.bambulab.cn', mqtt: 'cn.mqtt.bambulab.com' } }
export function regionOf(name) -> { key, api, mqtt }
export async function listDevices({ accessToken, uid, region, fetchImpl = fetch, timeoutMs = 12000 })
  -> { ok:true, devices:[{ serial, name, model, ip, accessCode? }] } | { ok:false, error }
export function cloudTarget({ accessToken, uid, region, device }) -> target  // 给 printerManager
```
- GET `{api}/v1/iot-service/api/user/bind`，头 `Authorization: Bearer <token>`；
  解析 `devices[]` 的 `dev_id / name / dev_model_name / dev_ip / dev_access_code`（名字字段缺失时跳过）。
- 错误信息不含 token（只报状态码/HTTP 错误）；超时用 AbortSignal.timeout。
- 云端仅做状态/控制，拍照不支持。

## 10. 测试要求

- 每个 lib 文件都有 `test/*.test.mjs` 覆盖：正常、边界、错误码、无秘密泄漏（断言输出字符串
  不含测试用 token / 安全码）。
- scrypt 在测试里用低 N（如 1024）保证速度；vault 构造函数接受 kdf 覆盖。
- MQTT 用编解码单测 + 假 Duplex/假客户端；不要连真打印机。
- 所有测试用 `node --test` 跑通：`cd modules/bambu-print && node --test test/*.test.mjs`。
- 测试文件不进入发布包。
