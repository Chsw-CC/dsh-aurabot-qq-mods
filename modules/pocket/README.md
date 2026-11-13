# 口袋（pocket）

把她的对话流接进你自己的手机 app。app 不是外挂，是她的第二个平台。

- **消息走原生流程**：app 发来的话会模拟成主人的私聊消息进入她原本的对话流——记忆召回、心情、表情包、语音、love-mode、其他模组全部照常生效。
- **记忆共用一套**：app 的聊天和 QQ 端落在同一条私聊流水（chatlog），每天的记忆整理照常把它提炼成长期记忆。换手机、卸载 app 都不丢记录。
- **主动搭话也能到手机**：speakup / autonomy 在 app 轮询在线时照常推过来。
- **手机宠物**：独立数值（饱食度 / 心情 / 亲密度），投喂会写进她的记忆（`memory.addEvent`），她聊天时会自然提到。
- **八套界面色调**：深海蓝 / 樱粉 / 薄荷绿 / 葡萄紫 / 落日橙 / 月白 / 深海夜 / 陈玫，面板里预设，手机端也能改；只换界面颜色，图标不动。

## 为什么模组自己开一个端口

DSH 面板那个端口要登录态，手机拿不到。所以模组自带一个局域网 HTTP 服务（默认 `7788`），同时托管 app 界面和 `/api/*` 接口。端口可在设置里改（改完重启插件）。

## 怎么装

1. 这个文件夹放进 `~/.dsh/plugins-data/aurabot/modules/`，面板「已安装」出现「口袋」即加载成功
2. 面板里点开「口袋」，能看到配对链接、局域网地址、配对密钥，以及八套色调
3. 手机装 `口袋.apk`（或手机浏览器直接打开 `http://电脑IP:7788`），填地址 + 密钥

同一个 WiFi 最省事；人不在家就装 Tailscale，填穿透地址。

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

面板侧同名接口挂在 `/aurabot/api/ext/pocket/` 下（要面板登录态），给面板自己读状态用。

## 安全边界

- **密钥门禁**：所有数据接口都要配对密钥（`x-pocket-token`），密钥在面板显示/重置，留空自动生成
- **范围收死**：消息只能注入 `private:<主人QQ>` 这一个会话，接口发不了别人、发不了群、动不了 OneBot
- **只读她的数据**：历史只读 chatlog；写路径只有两条——走她正常对话流程、宠物互动写一条 `addEvent`
- **CSRF**：POST 必须 `application/json` + 自定义头
- **路径穿越**：静态文件只允许 `app/` 目录内的文件
- **关掉开关**：立即全部 401/403，QQ 端不受影响
- **联网声明**：只在局域网监听，不主动外联；`capabilities` 含 `filesystem`（读写自身 dataDir 与 chatlog）、`plugin-config`（读人格/主人配置）、`plugin-internals`（hub / mood / diary / memory / voice 模组导出）、`network`（开自己的局域网服务）

## 已知取舍

- 她的回复在 QQ 网关在线时会同时发到 QQ（同一个她，两块屏幕）。想只走手机，把 QQ 网关退出登录
- 手机和电脑要在同一网络（或 Tailscale 之类的穿透网络）
- 投喂/摸头的数值属于 app 端，不改她在 QQ 那边的真实心情；但「被喂了白米饭」会作为事件进记忆

## 数据位置

- 宠物数值 / 自定义皮肤：`plugins-data/aurabot/modules-data/pocket/`
- 聊天记录：不在本模块存——直接读她自己的 `chatlog/`（唯一事实来源）

## 测试

```bash
node --test test/index.test.mjs
```

16 条：密钥门禁、CSRF 防线、注入字段、事件环过滤、宠物数值与冷却、history 过滤、语音缺失兜底、色调校验、自带服务的鉴权与路径穿越。

## 许可

MIT
