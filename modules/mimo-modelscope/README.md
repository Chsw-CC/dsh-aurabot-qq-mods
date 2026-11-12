# MiMo 语音与魔搭生图

小米 MiMo TTS 和 ModelScope 魔搭生图可以分别启用。要求 Aurabot 1.3.0 系列，包含 1.3.0-beta.1。

## 安装与配置

把整个 `mimo-modelscope` 文件夹放入 Aurabot 数据目录的 `modules/`，在「已安装」里启用，再打开「MiMo 语音与魔搭生图」设置页。

1. **MiMo** — 打开语音开关，保存小米 MiMo API Key 和语速。上传一段有使用权的 WAV 或 MP3 参考音频，最大 7 MB。点「生成试听」在面板播放。
2. **魔搭** — 打开生图开关，保存魔搭 Token。每行填写一个模型 ID，可以另选列表中的默认模型。点「试画」确认模型和尺寸能用。

两个功能默认关闭。试听和试画会发起真实服务请求，结果在面板显示。

## 在 QQ 里使用

| 入口 | 用法 |
| --- | --- |
| `/语音 晚安` | 用 MiMo 念出文字，别名 `/说话`、`/say` |
| `/画图 雨中的橘猫` | 用魔搭默认模型画图 |
| `/画图 --model 组织/模型 雨中的橘猫` | 为本次指定已配置的模型 |

命令限主人。主人私聊里的会话还可调用 `mimo_say` 和 `modelscope_draw`。生图工具可选当前聊天最近图片或引用图片作为参考，模型本身需支持参考图。

## 接入 Aurabot 内置语音与生图

在模块设置页可分别点「启用接管」。语音用官方 `tts.mjs` 本地接口合成平时的语音回复，语音识别继续使用 Aurabot 原功能。内置生图通过 `image.mjs` 走魔搭默认模型，临时指定模型可用 `/画图` 或模块工具。

使用内置入口时，也要在 Aurabot「语音」或「生图」页打开相应的功能开关。

接管时会检查目标脚本，有同名文件会提示冲突。点「关闭接管」或停用模块会清理本模块自己安装的脚本。遇到异常关机后留下的旧接管，也可在 Aurabot「本地接口」页关闭对应项。

## 数据与联网

- 小米接口接收朗读文字、语速提示和参考音频。魔搭接口接收画面描述、模型、尺寸，以及该次明确选用的参考图。生成的图片经 Aurabot 的公网下载检查后读取。
- API Key 和 Token 保存在 Aurabot 的模块设置，面板按密码字段处理。参考音频保存在 `modules-data/mimo-modelscope/reference/`。发布包只包含代码和说明。

[小米 MiMo TTS 文档](https://mimo.mi.com/docs/en-US/api/audio/tts-post) · [ModelScope](https://modelscope.cn/) · [Aurabot 模块 API](https://github.com/aureth-labs/dsh-aurabot-qq/blob/beta/src/modules/API.md)

模块源自 [Aurabot 的 MiMo、魔搭接入](https://github.com/oligeeklaphake/dsh-aurabot-qq/commit/4798526)和[魔搭多模型定制](https://github.com/oligeeklaphake/dsh-aurabot-qq/commit/243a080)，遵循 MIT 许可。
