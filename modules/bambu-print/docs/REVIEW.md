# bambu-print 修复复查

复查日期：2026-11-13  
范围：前次审查记录的安全/功能问题，以及修复后的新增回归。  
方法：静态复核、Node 全量测试、定向测试及模块装配模拟；未连接真实打印机、Bambu 云服务或执行网络中间人测试。

## 结论

前次报告中的问题**已全部修复，并都有回归测试**：RTSPS :322 在 spawn 前核对证书、自定义库文件名透传、Range 响应体流式限长、暂停状态不再把 0 当 Unix epoch、README 的 LAN TLS 说明已改写。

这份文件留作记录：每节保留「当初是什么问题、后来怎么修、被哪条测试钉住」，供后续改动比对。**它不代表当前代码仍有这些缺陷**——下面每节都已标出修复位置。全量 `npm test` 通过 420 项，0 失败。

## 原始发现与修复对照

### P1（已修复）RTSPS (:322) 抓拍仍未验证 TLS 对端身份

位置：[camera.mjs](../lib/camera.mjs#L93)、[camera.mjs](../lib/camera.mjs#L397)、[printer.mjs](../lib/printer.mjs#L795)

前次发现的访问码 argv 暴露已修复：凭据现在通过 ffmpeg stdin 传递，不进入 argv。但 RTSPS 路径仍没有校验 peer certificate，也没有应用 CA/指纹 pin。模块明确注明 :322 路径不校验证书，而且 :6000 学到的锚点不适用于 :322。

影响：具备局域网主动中间人能力时，X1/H2/P2S/X2D 等 RTSPS 机型可能把访问码发送给冒充端，或收到伪造画面。应实现该端口的证书验证/pin；若做不到，应对 RTSPS 默认拒绝或把限制作为明确的安全边界。

**修复**：`captureRtspsSnapshot` 在 spawn ffmpeg **之前**先对 :322 握手取证书，用 `verifyRtspsPeerCert` / `verifyPinnedCert` 与 pin 比对；对不上、握手失败、没给 pin（默认 `requirePin: true`）一律返回 `RTSPS_CERT_UNPINNED` / `RTSPS_CERT_MISMATCH` / `RTSPS_CERT_UNVERIFIED`，**ffmpeg 根本不启动**，访问码连 stdin 都没进过。:6000 与 :322 的锚点分开存，不能互相顶替。

**测试**：[camera.test.mjs](../test/camera.test.mjs) 的 `verifyRtspsPeerCert` / `verifyPinnedCert` 一组用例覆盖 unpinned、unverified、mismatch 三种拒绝，以及 argv 不含凭据、凭据只走 stdin。

### P2（已修复）TUTK Range 响应体可能在验证前被完整缓冲

位置：[tutk-lib.mjs](../lib/tutk-lib.mjs#L286)

Range 单次请求长度会在调用前限额，但 `RemoteFile.read()` 对 HTTP 206 仍直接读取整个 `arrayBuffer()`；实际 body 字节数没有在读取过程中限制。服务端若声称总文件大小在上限内，却对小 Range 请求返回超长 206 body，超限数据会先全部进入内存。

**修复**：`RemoteFile.read()` 改走 `readBodyLimited()`——优先用 `body.getReader()` 流式读，累计超过请求长度或配置上限立即取消并抛错；只有实现没有流时才退回 `arrayBuffer()`，读完同样先卡上限。

**测试**：[tutk-lib.test.mjs](../test/tutk-lib.test.mjs) 有「声明正常、实际 206 body 超长」的伪造响应用例。

### P2（已修复）自定义 BambuSource 文件名未从下载路由传到下载器

位置：[index.mjs](../index.mjs#L1898)、[index.mjs](../index.mjs#L1904)、[index.mjs](../index.mjs#L1908)、[tutk-lib.mjs](../lib/tutk-lib.mjs#L431)

下载 helper 能把完整库文件路径拆成目录和自定义文件名；但 `/tutk/download` 路由只把 `resolved.dir` 作为 `destDir` 传给下载器，没有传 `resolved.fileName`。配置 `/tmp/libs/custom-source.so` 时，下载器会保存为标准名 `/tmp/libs/libBambuSource.so`，而运行时仍按自定义路径寻找库，导致该配置不能工作。**修复**：`/tutk/download` 现在把 `resolved.fileName` 一起传给下载器（[index.mjs](../index.mjs)），配置 `/tmp/libs/custom-source.so` 就按这个名字落盘，运行时按同一路径找得到。

**测试**：[index.test.mjs](../test/index.test.mjs) 断言下载器收到的是用户配置的完整文件名。

## 功能问题

### 功能（已修复）暂停等非 RUNNING 状态可能显示纪元级已打印时长

位置：[index.mjs](../index.mjs#L658)、[status.mjs](../lib/status.mjs#L206)

`startOf()` 对非 `RUNNING` 状态返回 `0`，`fetchStatus()` 把它作为 `observedStart` 传给归一化逻辑；归一化只检查有限数，于是将 0 当 Unix epoch。复现输入：`PAUSE`、无 `gcode_start_time`、进度 42%、剩余 30 分钟，格式化结果显示约“已打印 20770 天”。

**修复**：`normalizeStatus()` 只接受 `> 0` 且有限的 `observedStart`，其余一律当「没观测到」，退回按进度/剩余估算，不再把 0 当 Unix epoch。

**测试**：[status.test.mjs](../test/status.test.mjs) 有「observedStart 为 0 / 负数 / NaN 时当作没观测到」的用例，复现了 PAUSE + 无 `gcode_start_time` 的原始输入。

## 文档需对齐

### 文档（已更新）README 的 LAN TLS 描述

位置：[README.md](../README.md#L18)、[README.md](../README.md#L183)

README 仍写“默认接受自签名证书，可配置 tlsFingerprint”。当前 MQTT 路径在正式带凭据连接前要求 pin；未 pin 会 fail-closed。**修复**：README 已按链路分别说明——云端 MQTT 系统 CA + 主机名校验；局域网 MQTT(:8883) 与 MJPEG(:6000) 是 TOFU 锚点 + 指纹固定、没锚点就 fail-closed 不发访问码；RTSPS(:322) 在启动 ffmpeg **之前**核对证书指纹，不一致不启动。（本模块早先把 :322 写成「不验证」，那是旧的实现，现已改为 spawn 前核对。）

## 前次问题复核（历史，已全部关闭）

### 已修复并有回归测试

- **模型工具绕过群白名单**：`api.tool` / `api.context` 现在检查宿主群白名单。[index.mjs](../index.mjs#L1428)、[index.mjs](../index.mjs#L1482)；[index.test.mjs](../test/index.test.mjs#L976)。
- **云端 MQTT 未验证 broker**：云端使用系统 CA 和 Node 默认主机名校验；忽略 target 携带的 CA/pin 降级字段。[printer.mjs](../lib/printer.mjs#L368)、[mqtt.mjs](../lib/mqtt.mjs#L256)；[printer.test.mjs](../test/printer.test.mjs#L691)。
- **LAN MQTT 未 pin 时发送访问码**：状态/命令建连前执行 trust gate；未 pin 返回 `CERT_UNPINNED` 且不建 client。[printer.mjs](../lib/printer.mjs#L376)、[printer.mjs](../lib/printer.mjs#L464)；[printer.test.mjs](../test/printer.test.mjs#L648)。
- **MJPEG 无证书锚点仍抓拍**：相机连接前 fail-closed；纯 LAN 失败，云端绑定可回退 TUTK；授权证书存放在绑定者 vault。[camera.mjs](../lib/camera.mjs#L255)、[index.mjs](../index.mjs#L309)、[index.mjs](../index.mjs#L721)；[index.test.mjs](../test/index.test.mjs#L409)。此项不关闭上方 RTSPS TLS 风险。
- **模型工具可直接停止**：工具入口拒绝 stop，要求用聊天命令二次确认。[index.mjs](../index.mjs#L1465)；[index.test.mjs](../test/index.test.mjs#L1053)。
- **RTSPS 访问码暴露在 argv**：改经 stdin 匿名管道传入。[camera.mjs](../lib/camera.mjs#L395)、[camera.mjs](../lib/camera.mjs#L442)；[camera.test.mjs](../test/camera.test.mjs#L298)。
- **TUTK 集成测试没有实际走桥接**：新增纯云设备 TUTK 出图与 LAN 证书失败回退测试。[index.test.mjs](../test/index.test.mjs#L432)、[index.test.mjs](../test/index.test.mjs#L457)。
- **TUTK helper 功能边界**：库路径解析、旧桥协议、`BAMBU_SOURCE_LIB` 预检、平台+架构拒绝、声明尺寸/解压尺寸限制和 60 秒采集上限均有实现及测试。示例：[tutk-lib.test.mjs](../test/tutk-lib.test.mjs#L348)、[tutk-lib.test.mjs](../test/tutk-lib.test.mjs#L357)、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L126)、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L144)、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L202)。路由层自定义文件名和实际 Range body 字节数仍未闭环。
- **ROUTES.md 的 photo/grant/TUTK 契约过期**：已更新 LAN/TUTK 回退、立即生效 grant 与 TUTK 路由。[ROUTES.md](ROUTES.md#L108)。

## 固有风险与验证限制

- LAN 初次 TOFU 仍会信任首次接触到的证书；若初次连接本身遭主动中间人攻击，恶意证书可能被固定。这是 TOFU 的固有边界（不是上面任何一条缺陷）。要彻底排除只能带外核对指纹：私聊 `/打印机 证书` 能看到当前指纹。
- 全量测试：420 项通过，0 失败。
- 未使用真实打印机、生产 MQTT broker 或主动网络中间人进行验证；FFmpeg concat/RTSPS 互操作也未在真实打印机上测试。
