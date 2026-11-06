# 安装与接口验证记录

记录这次在真实 Aurabot 上装这个模块跑出来的结果，方便复核。日期 2026-11-06，环境：Windows，Aurabot 1.2.0，DSH Web 本机 127.0.0.1 端口。

## 1. 安装

把 `modules/breeze/` 放进 Aurabot 数据目录的 `modules/` 下，保存后模块自动加载，不用重启。

检查方式：

```
GET /aurabot/api/modules
```

返回里能找到：

```
id=breeze running=user builtin=false version=1.2.0
routes=/ext/breeze/login,/ext/breeze/logout,/ext/breeze/checkin,/ext/breeze/status
error=（空）
```

`running=user` 表示这份是仓库里安装的版本、而不是内置模块；`error` 为空表示加载没错。

## 2. 语音接口

先填好 API Key 和音色 ID（面板「语音」页最下面那张卡），再打插件的语音测试接口：

```
POST /aurabot/api/voice/test
{"text":"漪漪凛测试：今天也要好好吃饭。"}
```

实测返回：

```
status 200
ok true | engine breeze | mime audio/mpeg | bytes 43008
```

`engine` 是 `breeze` 就说明这条音频由本模块合成（不是插件原来的 edge / Windows 语音）；`mime` 为 `audio/mpeg`、字节数非零表示拿到的是真实 mp3。

## 3. 签到

面板上点「手动签到」（对应 `POST /aurabot/api/ext/breeze/checkin`），实测返回：

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

自动签到走的是同一个 `claim()`，区别只是触发时机（到点、启动补领、失败重试）。

## 4. 失败回落

把 API Key 临时换成一个无效值（`brz_invalid_key_for_fallback_test`，Breeze 对无效 key 返回 401），再打同一个语音接口：

```
坏 key  → engine windows | bytes 182092
恢复后  → engine breeze  | bytes 35328
```

`engine` 变成 `windows`、字节数变大且是 wav，说明合成失败时没有把语音条发成空白，而是退回插件原来的系统语音。测试完 Key 已还原（与改动前逐字相同）。

## 5. 单元测试与仓库检查

```
AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/breeze/test/breeze.test.mjs"
→ tests 9 / pass 9 / fail 0
```

覆盖时间解析、登录态判断、签到回包翻译、今天该不该签到；其中 `hm('abc')` 回归到 `[8,10]`、`hm('12')` 回归到 `[12,10]`，对应这次修掉的「时间填错导致永远不签到」。

```
npm run catalog  → 写好了 modules/README.md
npm run check    → ✓ breeze
npm run pack -- --only breeze → breeze-v1.2.0.zip
```

## 说明

- 上面所有请求都发生在本机，没有把 API Key、Cookie 写进任何日志或仓库文件。
- 签到成功与失败都会（可选）私聊通知主人，这里为免打扰没有逐条截图。
