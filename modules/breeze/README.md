# Breeze 语音（breeze）

把 QQ 里她的语音条换成 [Breeze Blue](https://breezeblue.ai/zh/app/voice-library) 的在线语音，音色可以自己挑。
顺带每天自动领一次免费积分，免得哪天没额度了才发现。

合成失败会自动退回插件原来的 edge / Windows 语音，不会把语音条变成空白。

## 用法

装好以后打开面板「语音」页，最下面就是这张卡：

| 设置 | 说明 |
| --- | --- |
| 登录 | 点「登录」开一次浏览器窗口，登完自动抓登录态并关窗口；换号先「退出登录」 |
| API Key / 音色 ID | Breeze 后台拿的两个值，形如 `brz_…` 和 `voc_…` |
| 模型 / 语言 | `breeze-tts-2`（中英）或 `breeze-tts-2-multilingual`（多语言），两个价格一样 |
| 风格指令 | 可留空，比如「语气活泼一点」 |
| 每天自动签到领积分 | 到点试一次；失败隔 5 分钟重试，一天最多 3 次；DSH 当时没开就在下次启动时补一次 |
| 领到积分就私聊告诉我 | 关掉就只记日志 |

卡里的改动和面板其它设置一样，改完点底部「保存设置」才生效。

## 会访问哪些网址

- `https://api.breeze.blue/v1/text-to-speech/<音色 ID>` —— 合成语音（带你的 API Key）
- `https://breezeblue.ai/api/credits/daily-claim` —— 每日签到领积分（带登录 Cookie）
- `https://breezeblue.ai/zh/auth/login` —— 登录窗口打开的页面

## 会写什么文件

都在模块自己的数据目录（`~/.dsh/plugins-data/aurabot/modules-data/breeze/`）：

- `cookie.txt` —— 登录 Cookie，只有签到用；退出登录会删掉
- `checkin.json` —— 上次签到时间、结果、当天试了几次
- `browser/` —— 登录用的那个 Chrome 配置目录，退出登录会清空

## 登录为什么要开浏览器

Breeze 的登录态是 HttpOnly Cookie，网页脚本读不到，只能让浏览器自己带着它。
所以「登录」会用 Chrome 或 Edge 起一个专用配置目录（带调试端口），从调试接口里读 Cookie，
抓到就写进 `cookie.txt` 并把窗口关掉。不需要一直开着浏览器，只有第一次登录、掉登录、换号时才用得上。

找不到 Chrome / Edge 时可以手动填浏览器路径（支持 Windows、macOS、Linux 常见位置）。

## 计费参考

按字符计费，中日韩字算 2 个单位，约 0.2 积分/汉字；免费额度每天 400 积分（约 2000 汉字），
在官网签到领取。具体价格以 Breeze 官方为准。

## 许可

MIT，见 LICENSE。
