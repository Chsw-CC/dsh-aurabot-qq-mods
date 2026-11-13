# 口袋aurabot（pocket）

把她的对话流接进你自己的手机 app。app 不是外挂，是她的第二个平台。

- **消息走原生流程**：app 发来的话会模拟成主人的私聊消息进入她原本的对话流——记忆召回、心情、表情包、语音、love-mode、其他模组全部照常生效。
- **记忆共用一套**：app 的聊天和 QQ 端落在同一条私聊流水（chatlog），每天的记忆整理照常把它提炼成长期记忆。换手机、卸载 app 都不丢记录。
- **主动搭话也能到手机**：speakup / autonomy 在 app 轮询在线时照常推过来。
- **手机宠物**：饱食度 / 心情 / 亲密度。装了「喂食」模组时直接读它的真实数值（饱食 = 100-饥饿、亲密度 = 好感度），你在 app 里喂她等于在面板上喂她；没装才用自己那套独立数值。
- **她的形象可换**：设置页「她的形象」从相册选一张图就能替换小窝头像（`/api/avatar`），随时一键恢复默认。
- **八套界面色调**：深海蓝 / 樱粉 / 薄荷绿 / 葡萄紫 / 落日橙 / 月白 / 深海夜 / 陈玫，面板里预设，手机端也能改；只换界面颜色，图标不动。

## 为什么模组自己开一个端口

DSH 面板那个端口要登录态，手机拿不到。所以模组自带一个局域网 HTTP 服务（默认 `7788`），同时托管 app 界面和 `/api/*` 接口。端口可在设置里改（改完重启插件）。

## 怎么装

1. 这个文件夹放进 `~/.dsh/plugins-data/aurabot/modules/`，面板「已安装」出现「口袋aurabot」即加载成功
2. 面板里点开「口袋aurabot」：先把「启用手机接口」打开（**默认是关的**），能看到配对链接、各条地址（每条都标了用途）、配对密钥、两种外网方案的开关，以及八套色调
3. 手机装 `口袋aurabot.apk`（或手机浏览器直接打开 `http://电脑IP:7788`），填地址 + 密钥

在家同一个 WiFi 最省事；人在外面按下面的「在外面用」选一条路（面板上写得很全，照着点就行）。

安卓壳首次进 App 会申请**麦克风**和**相机**权限，点「📷 发图」/「从相册选」会直接弹系统选图（含拍照）。手机的页面跑在 `http://192.168.x.x` 这种非安全上下文里，浏览器不给用 `getUserMedia`，所以语音条走的是壳里的原生录音（`PocketMic` 桥），录完转 AAC 交给 `/api/voice-note` 识别；但走隧道（https）时浏览器有 `getUserMedia`，用手机浏览器直接开网页也能录音。

## 接口

界面走 `/`，接口走 `/api/*`，除 `/api/health` 外全部要配对密钥（请求头 `x-pocket-token`，或 URL 上带 `?token=`）。

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 探活（配对用，不要密钥） |
| `/api/state` | POST/GET | 人格、心情、QQ 状态、宠物数值、当前色调 |
| `/api/message` | POST | `{ text }` 注入一条主人私聊消息；回复异步出现在 `/api/events` |
| `/api/events` | GET | `?after=<seq>` 增量拉她的回复、主动搭话、QQ 上下线 |
| `/api/history` | GET | `?days=3` 读她自己的 chatlog（只含主人私聊） |
| `/api/moments` | GET | 她的日记（diary 模组）+ 心情曲线（mood 历史） |
| `/api/pet` | POST | `{ action: feed/pet/play, food }` 投喂互动，返回反应和数值 |
| `/api/voice` | GET | `?text=…` 用她的语音模组合成一段 wav（音频直接回二进制） |
| `/api/skin` | GET | 当前人格对应的皮肤 |
| `/api/tone` | GET/POST | 读/换界面色调 |
| `/api/avatar` | GET/POST/DELETE | 小窝头像：GET 看当前、POST `{ image: dataURL }` 从相册换图、DELETE 恢复默认 |

面板侧同名接口挂在 `/aurabot/api/ext/pocket/` 下（要面板登录态），给面板自己读状态用。

## 在外面用（4G / 5G）

服务跑在家里电脑上，人在外面要有一条回家的路。面板「口袋aurabot」页会列出当前可用的地址并逐条标注用途，**两种外网方案都能在面板上直接操作**：

1. **公网 IPv6 直连（地址固定，但门槛在手机侧）**
   - 现在三大运营商家宽基本都下发公网 IPv6，但**手机的流量不一定有 IPv6**（先在手机浏览器开 test-ipv6.com 确认；显示 0/10 就是纯 IPv4，这条路走不通）
   - 光猫 / 路由器里：开启 IPv6，防火墙放行 `7788`（Windows 侧也要放行入站，见下）
   - 手机填：`[240e:xxxx:xxxx::xxxx]:7788`（方括号不能少，这是 IPv6 的写法，不是可选装饰）
   - 建议把 IPv6 地址配成固定的（路由器里做 DHCPv6 静态分配），否则重启光猫可能会变
   - Windows 放行（管理员 PowerShell）：`New-NetFirewallRule -DisplayName "Pocket 7788" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7788 -Profile Any`
2. **隧道（面板一键启动，任何网络都能连）**
   - 电脑装 [cloudflared](https://github.com/cloudflare/cloudflared/releases/latest)（下载 `cloudflared-windows-amd64.exe` 放到任意位置，如 `C:\Users\你\auratools\bin\`；面板会自动找到，找不到就在模块设置里把完整路径填进「cloudflaredPath」）
   - 面板「口袋aurabot」页点「启动隧道」，几秒后得到一个 `https://xxx.trycloudflare.com`，点「复制隧道地址」填进 app
   - https 是真安全上下文：手机浏览器直接开这个网址也能用，且 `getUserMedia` 可用（语音条不依赖 app 原生录音）
   - 临时域名每次重启会变，重启后重新点一次「启动隧道」、把新地址更新到 app；固定域名要绑自己的域名到 Cloudflare（免费）
3. **Tailscale（公司网络封端口、上面两条都走不通时的兜底）**
   - 电脑和手机都装，登同一账号，电脑会多出 `100.x.x.x`（模组会自动识别这个网段）
   - 填 `192.168.x.x:7788,100.x.x.x:7788`
4. **公网 IPv4 + 端口映射**：需要运营商给公网 IPv4（多数家宽默认没有，要打电话要）

**多地址一起填，逗号隔开**，比如 `192.168.1.5:7788, [240e::1]:7788`。
app 的地址解析认这几种写法：`192.168.1.5` / `host:7788` / `[240e::1]:7788` / `https://域名`，
启动和请求失败时会挨个探活，谁通自动用谁 —— 在家走局域网、出门切 IPv6、回来再切回来，不用手动改。

> 无论哪种，接口都有配对密钥门禁。把服务暴露到公网时密钥务必保留、别太短。

## 安全边界

- **默认关闭**：手机接口默认是关的，要在面板里手动开；关掉立即全部 401/403，QQ 端不受影响
- **密钥门禁**：所有数据接口都要配对密钥（`x-pocket-token`），密钥在面板显示/重置，留空自动生成；比较用常量时间算法（防时序侧信道），同一来源 60 秒内错 10 次直接 429 限流；启动日志里密钥脱敏（只露前两位）
- **探活接口最小化**：`/api/health` 只返回 ok/版本/端口/色调，不含人格名、主人名等信息
- **范围收死**：消息只能注入 `private:<主人QQ>` 这一个会话，接口发不了别人、发不了群、动不了 OneBot
- **只读她的数据**：历史只读 chatlog；写路径只有两条——走她正常对话流程、宠物互动写一条 `addEvent`
- **CSRF**：POST 必须 `application/json` + 自定义头
- **路径穿越**：静态文件只允许 `app/` 目录内的文件
- **子进程声明**：`capabilities` 含 `process`，只用来拉起 cloudflared 隧道（面板一键启停），不执行其他外部程序
- **联网声明**：只在局域网监听，不主动外联；`capabilities` 含 `filesystem`（读写自身 dataDir 与 chatlog）、`plugin-config`（读人格/主人配置）、`plugin-internals`（hub / mood / diary / memory / voice 模组导出）、`network`（开自己的局域网服务）

## 已知取舍

- 她的回复在 QQ 网关在线时会同时发到 QQ（同一个她，两块屏幕）。想只走手机，把 QQ 网关退出登录
- 语音识别依赖 DSH 的语音输入配置或 voicecall 配的 ASR（本地 whisper 等）；两边都没配时她会如实说听不清
- 投喂/摸头的数值属于 app 端，不改她在 QQ 那边的真实心情；但「被喂了白米饭」会作为事件进记忆

## 数据位置

- 宠物数值 / 自定义皮肤：`plugins-data/aurabot/modules-data/pocket/`
- 自定义头像：模组目录 `icons/avatar.png`（删掉这个文件 = 恢复默认头像）
- 隧道进程：cloudflared 独立运行，pid 写在 `plugins-data/aurabot/modules-data/pocket/`，模组热重载不影响它
- 聊天记录：不在本模块存——直接读她自己的 `chatlog/`（唯一事实来源）

## 测试

```bash
node --test test/index.test.mjs
```

21 条：密钥门禁、CSRF 防线、注入字段、事件环过滤、宠物数值与冷却（含喂食模组联动）、history 过滤、语音缺失兜底、色调校验、头像读写与恢复默认、自带服务的鉴权与路径穿越、地址归一化。

## 许可

MIT
