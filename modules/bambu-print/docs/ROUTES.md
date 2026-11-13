# bambu-print 装配层契约（index.mjs / panel.js）

所有 `api.route` 路径都在 `/aurabot/api/ext/bambu-print/` 下；panel.js 用 `call(path, body?)`。
接口是**本机面板**（宿主主人）使用；任何涉及解密的操作都必须提供对应用户的安全码（unlock），
所以面板也不能在没有用户安全码的情况下读取秘密。所有响应 **绝不包含** accessCode / accessToken /
安全码明文，也不包含完整 IP / 序列号（用 maskIp / maskSerial）。

统一响应：`{ ok: boolean, message?: string, data?: any }`；失败用 `{ ok:false, code, message }`。

## 设置：一份规则表，三处共用

`lib/settings.mjs` 是设置的唯一真源：

- `SETTING_RULES`：每个设置项的 `kind`（bool / int / enum / enumAllowEmpty / text）、`def`、`min`/`max`、`values`、`label`、`hint`；
- `normalizeSettings(raw)`：把任意输入夹取 / 回落成合法值，只输出规则表里的键；
- `describeRules()`：给面板的纯数据副本（`/overview.rules`）；
- `effectiveEnabled(raw)`：总开关真值判定（`active` 优先，缺失时回落到老字段 `enabled`）。

三处共用同一份表：面板渲染字段与 min/max/hint、服务端 `settings()` 归一化、启动时的存量修正。
因此「按钮上写的范围」和「存进去、运行时用的值」不可能不一致。

## 开关与入口指示灯

模块定义里声明 `flag: 'active'`，`defaults.active` 是总开关的默认值。宿主据此：

1. 左侧「拓竹打印机」子标签页上画一个小圆点，读的是草稿里的 `ext.bambu-print.active`；
2. 不在页面标题栏额外画总开关（那是 `flag === 'enabled'` 或 settings 里出现 `enabled` 时才会有的），
   所以「一个开关、一个指示灯」不会打架。

设置保存走宿主的整份草稿（页面底部「设置已修改，点保存」），面板只调 `props.setSettings(patch)`，`props.save` 只用于非设置类的一次性动作。
启动时 `setup()` 会把 `active` 对齐成真实开关状态，并把越界的存量值归一化写回。

## GET /overview

```json
{
  "ok": true,
  "enabled": true,
  "settings": { "users": "…", "groups": "…", "groupMode": "status",
                "groupPhoto": true, "allowGroupName": false, "unlockDays": 7 },
  "owner": { "qqMasked": "123****456", "online": false, "lanAllowed": true, "unlockDays": 7 },
  "rules": { "unlockDays": { "kind": "int", "def": 7, "min": 1, "max": 30,
                            "label": "解锁有效期（天）", "hint": "…" } },
  "risk": "…风险提示原文…",
  "users": [ { "qqMasked": "123****456", "bindings": 2, "printers": 3, "unlocked": false,
               "lockedUntil": 0, "createdAt": 0, "lastSeenAt": 0,
               "bindingList": [ { "id": "b_x", "label": "我的 A1", "mode": "lan",
                                  "tokenMask": "…", "printers": [ { "serialMasked": "01S0****6789",
                                  "name": "A1", "model": "A1" } ] } ] } ],
  "grants": [ { "id": "g_x", "ownerMasked": "…", "granteeMasked": "…", "scopes": ["status"],
                "expiresAt": 0, "revoked": false } ],
  "audit": [ { "at": 0, "actorMasked": "…", "action": "unlock", "ok": true, "note": "" } ],
  "counts": { "users": 1, "boundUsers": 1, "printers": 2, "unlocked": 0, "activeGrants": 0 }
}
```

## 主人 / 局域网（面板用，不需要在页面里填 QQ）

主人身份只从 `api.config().ownerQQ` 取，面板不再需要（也不应该）知道主人的 QQ 号。

- `POST /owner/unlock` `{ code }` → `{ ok:true, until, unlockDays }`（有效期跟着设置里的「解锁有效期（天）」走，改了立即生效）。
  失败 `{ ok:false, code:'BAD_CODE'|'LOCKED_OUT'|'NO_OWNER', message }`。
- `POST /owner/lock` `{}` → `{ ok:true }`（不需要 body）。
- `GET /lan/status` → `{ ok, ownerQQ, ownerMasked, ownerOnline, unlockDays, lanAllowed,
  bindings:[{ id, label, tokenMask, printers:[{ serialMasked, name, model }] }] }`。
  只列 `mode === 'lan'` 的绑定；未解锁时绑定列表仍返回元数据（token / 访问码永不出现）。
- `POST /lan/bind` `{ label, accessCode, printers:[{ serial, ip, name }] }` →
  复用 `bindLan()`：只认主人、要求主人已解锁、校验序列号 /^[A-Za-z0-9._-]{4,40}$/ 与 IPv4，
  成功后固定打印机自签名证书（TOFU 第一次）并试连一次，返回
  `{ ok:true, binding:{ id, label, mode:'lan' }, count, probe:{ ok, message }, cert:{ fingerprint256?, learned?, error? } }`。
  失败 `{ ok:false, code:'OWNER_ONLY'|'LOCKED'|'BAD_INPUT'|'NO_OWNER', message }`。**从不回显访问码**。

## POST /unlock  { qq, code }

成功 `{ ok:true, until, unlockMinutes, unlockDays }`（有效期按设置里的「解锁有效期（天）」，
默认 7 天，最小 1 天、最大 30 天）；失败 `{ ok:false, code:'BAD_CODE'|'LOCKED_OUT'|'NO_USER', message }`。
面板拿到的只是「该用户已解锁」这一状态，拿不到秘密。

## POST /lock { qq } → `{ ok:true }`

## POST /bind  { qq, label, mode, accessCode?, accessToken?, uid?, region?, printers? }

- 必须已经 `/unlock` 该用户。
- lan: `printers` 为数组 `[{ serial, ip, name? }]`，至少 1 台；accessCode 必填；**同一条凭据下的
  打印机共用这个访问码**（不是每台单独填，除非用户分多条凭据绑定）。
- cloud: `accessToken` + `uid` + `region`(us/eu/cn)；成功后用 cloud.listDevices 发现打印机写入；
  发现失败时 binding 仍创建，返回警告。
- 返回 `{ ok:true, binding:{ id, label, mode, printers:[{serialMasked,name,model}] } }`。

## POST /unbind { qq, bindingId } → `{ ok:true }`（需解锁）

## POST /status { qq, selector? }

- 需解锁。selector 见 vault.resolve；为空且该用户只有一台打印机时直接查它；多台且无选择时返回
  `{ ok:true, needChoice:true, choices:[{ index, label, name, model, serialMasked }] }`。
- 成功 `{ ok:true, text, status, printer:{ label, name, model, serialMasked } }`，text 是私聊口径
  （不脱敏，因为面板是用户自己 / 主人界面，但**文件名是否显示**取决于 `reveal` 参数：
  `POST /status { qq, selector, reveal:false }` 时文件行显示「已脱敏」）。
- 默认 reveal=true（面板）；群聊路径在 index 内部用 reveal=false 规则。
- 失败 `{ ok:false, code:'LOCKED'|'OFFLINE'|'NO_PRINTER'|'AMBIGUOUS', message }`。

## POST /control { qq, selector?, action, value? }

- 需解锁。action ∈ pause/resume/stop/light/speed/temperature/gcode/home。
- stop 需要 `confirm: true`，否则 `{ ok:false, code:'NEED_CONFIRM' }`。
- 成功 `{ ok:true, message }`。

## POST /photo { qq, selector? }

- 需解锁。**LAN 优先、云端 TUTK 回退**（顺序见 `docs/TUTK.md` §2）：
  1. 打印机有局域网 IP + 访问码 → 先固定/校验摄像头证书，再抓 LAN 画面；
  2. 证书固定不了、或 LAN 连不上，且这是**云端绑定** → 用该用户的云端 token 铸 ttcode，走本机 TUTK 抓帧桥；
  3. 纯局域网绑定失败时**不**回退云端，直接如实报错；两条都不通时说清缺什么（token / BambuSource / ffmpeg / 超时）。
- 成功 `{ ok:true, image:"data:image/jpeg;base64,…", printer:{ name, serialMasked } }`
  （单张 <= 1.6MB，超过压缩不了就报错）。
- 失败 `{ ok:false, code:'LOCKED'|'NEED_CHOICE'|'NO_PRINTER'|'OFFLINE'|'CAMERA_UNPINNED'|'NO_LAN'|'NO_TOKEN'|'NO_BAMBUSOURCE'|'TIMEOUT'…, message }`。
- 多台且没 selector 时和 `/status` 一样返回 `{ ok:true, needChoice:true, choices:[…] }`。

## POST /grant { qq, grantee, bindingIds?, scopes?, minutes? }

- 需解锁；`qq` 是打印机所有者，`grantee` 是**要被授权**的 QQ（不需要事先加名单，也不能是自己）。
- 成功 `{ ok:true, grantId, expiresAt, scopes, count, message }`：授权**立即生效**（没有一次性 code，也没有兑换步骤）；
  对方下一次发命令就能用所有者的凭据操作选中的打印机。
  `scopes` ⊆ `status / control / photo`（默认 `['status']`）；`minutes` 默认 30、上限 1440；`bindingIds` 为空 = 全部绑定。
- 失败 `{ ok:false, code:'LOCKED'|'BAD_INPUT'|'NOT_FOUND', message }`（`bindingIds` 里有不存在的绑定时是 `NOT_FOUND`）。

## POST /revoke { qq, grantId } → `{ ok:true }`

- `qq` 必填且需已解锁（授权人本人才能撤销；授权对象也能撤销自己收到的授权）；失败 `{ ok:false, code:'BAD_INPUT'|'LOCKED'|'NOT_FOUND' }`。

## GET /audit?limit=50 → `{ ok:true, audit:[…] }`（limit 夹在 1~200）

## 云端画面 / TUTK 组件（面板自检与准备）

- `GET /tutk/status` → 只报「能不能用」，不回显任何凭据：
  ```json
  {
    "ok": true,
    "bridge": { "path": "…", "builtin": true, "customized": false, "ok": true, "code": "", "message": "" },
    "lib": { "path": "…", "ok": true, "message": "", "download": "https://github.com/ClusterM/open-bamboo-networking/releases", "file": "BambuSource.dll" },
    "cn": false, "timeoutMs": 20000, "note": "…"
  }
  ```
  `bridge.builtin` = 当前用的是模块自带的桥。`lib.ok` 和 C 桥运行时用同一套查找顺序：
  设置里的库路径 → `BAMBU_SOURCE_LIB` → 桥同目录；**显式配了库路径却找不到时直接报缺库**（C 桥拿到 `--lib`
  但文件不在也是硬失败，不会偷偷换一个），所以「只配环境变量」这种情形现在也会正确报 ok。
- `POST /tutk/download` `{ dir?, cn?, timeoutMs? }` → 下载 BambuSource 并放到该位置：
  ```json
  { "ok": true, "path": "…/libBambuSource.so", "bytes": 1048576, "version": "v2.3.0",
    "via": "githubproxy.cc", "proxy": true, "cn": false, "ready": true }
  ```
  `dir` 留空时用设置里的 `tutkLibPath`，再留空就用桥同目录。**`dir` 既可以是目录，也可以是库文件路径**：
  填 `/opt/libBambuSource.so` 会写到 `/opt/libBambuSource.so`（正是这个名字，不会再套一层 `libBambuSource.so/` 目录）；
  填目录则在该目录下用标准库名。判断由 `lib/tutk-lib.mjs` 的 `resolveDestDir(destDir, fileName)` 完成。
  `ready` = 桥本体 + 库都就绪。失败 `{ ok:false, code:'NO_DIR'|'UNSUPPORTED_PLATFORM'|'TOO_LARGE'|'ALL_SOURCES_FAILED'|'EXTRACT_FAILED', message }`：
  下载包超过 `MAX_ASSET_BYTES`（320MB）或解压后超过同一上限时是 `TOO_LARGE`，会在分配/解压前中止。
- `POST /tutk/mint` `{ qq, selector? }` → 用该用户的云端 token **铸一次 ttcode** 验证账号/设备支持云画面（不抓帧、不返回凭据）：
  成功 `{ ok:true, message, printer:{ name, serialMasked } }`；失败 `{ ok:false, code:'LOCKED'|'NO_CLOUD'|'NO_TOKEN'|'NEED_CHOICE'|<铸码错误码>, message }`。
  多台云端打印机且没 selector 时同样返回 `{ ok:true, needChoice:true, choices:[…] }`。

对应设置在 `SETTING_RULES` 里：`tutkBridgePath`（留空 = 自带桥）、`tutkLibPath`（库**文件**路径，留空 = 桥同目录自动找）、
`tutkTimeoutMs`（3000~60000ms）。非 Windows x64 / Linux x64 没有预编译桥，`/tutk/status` 与下载都会明确说不支持，需要自己编。

## 群聊脱敏 / 权限（index 内部，不经面板）

- 群聊任何状态输出使用 `redaction()`：默认文件/项目名隐藏（`文件：已脱敏`），只显示进度、
  已打印 / 剩余时间、层数、温度。
- `groupMode`：off 不回；status 只读；control 允许控制。群控制只作用于**发起人自己的**绑定，
  别人的打印机要由对方先授权给你。
- 群里不接受 `/打印机 绑定|解锁|授权` 等敏感操作——回复「请私聊」。
- 一次 token 多台打印机：`/打印机 状态` 无选择且多台时列编号并等待下一条「1」；选择状态
  per-chat 缓存 2 分钟（`selectedPrinter` 偏好仅私聊持久化）。
