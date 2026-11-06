# 安装与接口验证记录

记录这次在真实 Aurabot 上装这个模块跑出来的结果，方便复核。日期 2026-11-06，环境：Windows，Aurabot 1.2.0，DSH Web 本机端口 3654。

模块版本 1.3.0。这一版把接入方式改成了「不依赖插件核心为模块开钩子」：模块自己在本机起一个 HTTP 语音服务，
再把面板「语音」页的引擎指到插件本来就有的「通用 HTTP」那一档（`voice.engine = 'http'`），
所以插件核心一行都不用改，别人装上也能直接生效。

## 1. 安装

把 `modules/breeze/` 放进 Aurabot 数据目录的 `modules/` 下，保存后模块自动加载，不用重启。

检查方式：

```
GET /aurabot/api/modules
```

返回里能找到：

```
id=breeze running=user builtin=false version=1.3.0
routes=/ext/breeze/login,/ext/breeze/logout,/ext/breeze/checkin,/ext/breeze/status
error=（空）
```

`running=user` 表示这份是装进去的版本、而不是内置模块；`error` 为空表示加载没错。

模块启动时日志里会有一行，说明本地语音服务已经起来：

```
[breeze] 本地语音服务已开：127.0.0.1:47653
```

同时面板「语音」页的引擎被写成：

```
engine = http
urlTemplate = http://127.0.0.1:47653/?text={text}
```

端口 47653 被别的程序占着时会依次试 47654、47655、47656（最多四个），开了哪个就把哪个写进配置。

## 2. 语音接口

先填好 API Key 和音色 ID（面板「语音」页最下面那张卡），再打插件的语音测试接口：

```
POST /aurabot/api/voice/test
{"text":"漪漪凛测试：今天也要好好吃饭。"}
```

实测返回：

```
status 200
ok true | engine http | mime audio/mpeg | bytes 54272
```

这里的 `engine = http` 就是本模块：插件把这活交给「通用 HTTP」引擎，地址被指到本机 47653 上的模块服务，
模块再去调 `https://api.breeze.blue/v1/text-to-speech/<音色 ID>` 拿到 mp3 并按插件要求的格式回给核心。
`mime` 为 `audio/mpeg`、字节数非零表示拿到的是真实 mp3（不是插件原来的 wav）。

## 3. 失败回落

把 API Key 临时换成一个无效值（`brz_invalid_key_for_fallback_test`，Breeze 对无效 key 返回 401），再打同一个语音接口：

```
坏 key  → engine windows | mime audio/wav  | bytes 92040
恢复后  → engine http    | mime audio/mpeg | bytes 21504
```

`engine` 变成 `windows`、`mime` 变成 wav，说明合成失败时没有把语音条发成空白，而是退回插件原来的系统语音。
测试完 Key 已还原（长度与改动前一致，36 字符，语音随即恢复成 `engine http`）。

注意：改完配置要让模块重新读一次，走面板的保存接口 `POST /aurabot/api/save`（body `{"ext":{"breeze":{"apiKey":"…"}}}`）；
直接改 `config.json` 再重载模块不生效，因为核心配置在内存里有缓存。

## 4. 签到

面板上点「手动签到」（对应 `POST /aurabot/api/ext/breeze/checkin`）。

改动前（模块还是 1.2.0、登录态存在文件里）实测过：

```
{"ok":true,"message":"领到 400 积分（余额 2159）"}
```

模块自己记的状态文件 `modules-data/breeze/checkin.json`：

```json
{
  "lastTry": "2026-11-06T02:48:53.371Z",
  "lastResult": "领到 400 积分（余额 2159）",
  "lastReason": "manual",
  "done": "2026-11-06",
  "day": "2026-11-06",
  "tries": 6
}
```

这一版把登录态从「明文文件」改成了「只在内存 + 需要时从专用浏览器配置里现读」，本地那份专用配置是新建的，
所以需要人工点一次「登录」把登录态建起来，签到才能复测；签到接口本身与上面同一个 `claim()`，没有改动。

现在的失败处理：到点领不到就隔 5 分钟再试，一天最多 3 次；碰到 401/403 会先把内存里那份丢掉、下次重新从配置里读；
三次都失败才私聊主人「可能登录过期了，去面板点『登录』」。

## 5. 单元测试与仓库检查

```
AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/breeze/test/breeze.test.mjs"
→ tests 9 / pass 9 / fail 0
```

覆盖时间解析、登录态判断、签到回包翻译、今天该不该签到；其中 `hm('abc')` 回归到 `[8,10]`、`hm('12')` 回归到 `[12,10]`，
对应这次修掉的「时间填错导致永远不签到」。

```
npm run catalog  → 写好了 modules/README.md
npm run check    → ✓ breeze
npm run pack -- --only breeze → breeze-v1.3.0.zip
```

## 说明

- 上面所有请求都发生在本机，模块不把 API Key、Cookie 写进任何日志或仓库文件。
- cookie 只在模块进程的内存里留一份，进程退出即消失；磁盘上只有 Chrome 自己加密保存的登录态。
- 签到成功与失败都会（可选）私聊通知主人，这里为免打扰没有逐条截图。
