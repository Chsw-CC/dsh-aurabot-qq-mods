# 云端画面（TUTK）实现说明

> 协议侧对应 OBN 仓库的 `src/camera/tutk/`（IOTC 打洞/中继、DTLS-PSK、AV 层、H.264 重组）。
> 本模块 **不复制也不链接** OBN 的 AGPL 代码：它自带一个 MIT 的单文件 C 抓帧桥，
> 运行时用 `LoadLibrary` / `dlopen` 加载你自己安装的 `BambuSource` 库，调它的 C ABI。

## 1. 为什么不能纯 Node 实现

云端画面链路（见 OBN `research/06.07-tutk.md`）：

```
UDP（32761 局域网广播 / :3478 rendezvous / 中继）
  └─ IOTC 数据报（TransCodePartial 混淆，16 字节头）
       └─ DTLS 1.2 PSK（12 字节子头）
            └─ AV 包（8 字节头）：login、stream、IOCtrl、心跳
                 ├─ 视频帧（H.264，FEC 分组，1024 字节切片）
                 └─ IOCtrl 0x3001 JSON RPC（文件浏览器 / ft_*）
```

- Node 的 `tls` 只做 TLS 1.2/1.3 主模式，**不支持 DTLS**；
- DTLS-PSK 的套件、epoch/序号 AAD、CBC 的 Encrypt-then-MAC 都要自己拼；
- AV 层还要做 FEC 重组与 H.264 分片合并；
- 再加上 IOTC 的 TransCodePartial 混淆、打洞/中继、master JOIN。

这些都是 OBN `src/camera/tutk/` 已经做好、并被真实打印机验证过的（P2S / X2D，1080p30）。

## 2. 本模块怎么接

`lib/tutk.mjs`（只负责拿凭据）
- `mintTutcode()`：`POST {region.api}/v1/iot-service/api/user/ttcode`（Bearer token + 切片器指纹头），
  解析 `ttcode / authkey / passwd / region`，拼成 `bambu:///tutk?…`。
- 全程 token/ttcode/passwd 不进日志、不进错误文本；返回值里只有 URL（交给抓帧桥即弃）。

`lib/tutk-bridge.mjs` + `assets/tutk-bridge/bambu-tutk-bridge`（抓帧）
- 把带凭据的 URL 写进权限 0600 的临时文件；
- 运行模块自带的桥（已预编译，纯 C，不依赖 .NET / Node / npm）：
  ```
  bambu-tutk-bridge --url-file <tmp> --dump <tmp.bin> --seconds N
  ```
  URL 从不进入 argv（`ps` / 进程列表看不到），stderr 里出现的凭据会被擦成 `••••`；
  桥加载 `BambuSource` 后按 `Bambu_Create → Open → StartStream → ReadSample` 取样本；
  `--seconds` 取 `tutkTimeoutMs / 1000`，范围 **2~60 秒**（`tutkTimeoutMs` 是 3000~60000ms，一一对应；
  桥的 C 端也是 2~60，两边上限一致，不会出现「设了 45 秒实际只抓 30 秒」）；
- 输出样本是 MJPEG 就直接用；是 H.264 Annex-B 就用本机 `ffmpeg -f h264 … -frames:v 1` 解一帧；
- 临时目录递归删除（含 URL 文件与样本）。

`index.mjs` 的 `snapshotOf()` 顺序（`/photo` 和私聊「拍照」走的都是它）：
1. 有局域网 IP + 访问码 → 先固定/校验摄像头证书，再走局域网（:6000 MJPEG 或 :322 RTSPS+ffmpeg）；
2. 局域网这条路不通（证书学不到、连不上、超时）且这台是**云端绑定** → 用**该打印机所属用户**的云端 token 铸码 → 交给自带抓帧桥；
   纯局域网绑定（`mode !== 'cloud'`）**不**回退云端，直接如实报 `NO_LAN`；
3. 缺东西 → 明确说是缺 token、缺 BambuSource、ttcode 被拒，还是超时（不假装拍到）。

也就是说：**`/photo` 是 LAN 优先、云端 TUTK 回退**，不是「只支持 LAN」。

## 3. 用户怎么准备

只需要两样东西：**一份 BambuSource 库** 和（H.264 机型）**ffmpeg**。桥程序已经随模块预编译好了。

### BambuSource

面板「设置 → 下载 BambuSource 库」按钮会自动完成：查最新 Release → 下载压缩包 → 只抽出那一个
库文件 → 放到桥同目录。国内网络先走 GitHub 加速代理（`githubproxy.cc` / `ghfast.top` /
`ghproxy.net` / `gh-proxy.com`），全挂再回退直连；用的是 HTTP Range 分段读取，
国内实测约 5 秒（只拉需要的几 MB，不是整包 88MB）。

背后的实现是 `lib/tutk-lib.mjs`：

- `isCnLikely()` 按本地时区/语言判断国内外；
- `orderUrls()` 排出直连/代理的尝试顺序；
- `downloadBambuSource()` 用 Range 读 zip 的中央目录 → 定位 `lib/vX/BambuSource.dll`
  的本地头 → 只下这一段 → `inflateRaw` 解出来；Linux 的 tar.gz 走 `gunzip` + tar 头扫描；
- 服务器不支持 Range 时退化成整包流式下载到临时文件，仍在临时目录里解、解完即删；
- **大小上限**（`MAX_ASSET_BYTES` = 320MB）：整包、Range 的 `content-range` 总大小、单次读取、
  ZIP 条目声明的 `uncompressedSize`、以及解压后的输出，全都在分配 / 解压**之前**卡住；超限一律返回
  `{ ok:false, code:'TOO_LARGE' }`，不会先把 buffer 撑大；
- 文件太小（<64KB）或压缩包里找不到目标文件 → 明确报错，不写半个文件。

`destDir` 既可以是目录，也可以是**库文件路径**（面板的「BambuSource 库路径」填的就是后者）：
`/opt/libBambuSource.so` 会原样写成这个名字，不会变成 `/opt/libBambuSource.so/libBambuSource.so`。
判定由导出的纯函数 `resolveDestDir(destDir, fileName) -> { dir, fileName }` 完成，有单测。

也可以手动下载再放进去：

```bash
# Windows: obn-windows-x64.zip → lib/v02.09.01/BambuSource.dll
# Linux:   obn-linux-x64.tar.gz → lib/libBambuSource.so
```

把库放在桥程序同目录（`assets/tutk-bridge/`），或用面板「BambuSource 库路径」/环境变量 `BAMBU_SOURCE_LIB` 指定。
这三个位置**面板自检和 C 桥用的是同一套查找顺序**（设置路径 → `BAMBU_SOURCE_LIB` → 桥同目录），
所以只配环境变量时面板也会说库找到了，不会误报缺库。
想自己编译 OBN 的话：`./configure && make -j"$(nproc)"`，产物在 `build/`。

### 桥程序

仓库已经带了两个预编译产物（纯 C，无 .NET 依赖）：

| 平台 | 文件 |
|---|---|
| Windows x64 | `assets/tutk-bridge/bambu-tutk-bridge.exe` |
| Linux x64 | `assets/tutk-bridge/bambu-tutk-bridge-linux-x64` |

模块**只带这两个平台的产物**。平台选择按 `platform + arch` 判定（`platformAsset()` / `targetFor()`）：
`win32+x64`、`linux+x64` 之外的组合（**macOS（darwin）、linux arm64、win32 arm64 等**）不再被
悄悄当成 Linux x64 —— `defaultBridgePath()` 返回空、`downloadBambuSource()` 直接回
`UNSUPPORTED_PLATFORM`，面板会说「没有预编译桥，请自己编」。

其它架构 / macOS 自己编（仍然不需要 .NET），编完在设置里填桥的绝对路径，BambuSource 也要自己编一份：

```sh
cc -O2 -o bambu-tutk-bridge bambu-tutk-bridge.c -ldl     # Linux/macOS
gcc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c     # Windows MinGW
zig cc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c  # 任意平台交叉编译
```

### 想换别的抓帧程序？

面板「设置 → TUTK 抓帧桥」可以填一个自定义桥；留空就用模块自带的。**两种协议都真的能用**：

1. **新协议（首选）**：`--url-file <tmp> --dump <tmp.bin> --seconds N [--lib <BambuSource>]`。
   URL 只在临时文件里，不进 argv。
2. **旧协议（回退）**：不带参数启动，stdin 写一行 JSON `{"url","serial","format":"jpeg"}`，
   stdout 输出一张 JPEG。

调用器先试新协议；如果桥**看起来不认识这些参数**（退出码 1/2/64/70/78，或 stderr 里有 usage / unknown option），
或者新协议退出 0 却根本没写 `--dump` 文件，就自动改用旧协议再跑一次。所以老的自定义桥不用改。
两种情况下 URL 都**不**进 argv（旧协议走 stdin）；但旧桥的 stdout 大小上限、错误脱敏由旧桥自己负责，
本模块只做 16MB 上限和退出码归类。

## 4. 生成图片的边界

- 只抓一帧，不持续录像。
- 单帧 <= 8MB（桥返回）/ 样本 <= 16MB（`lib/tutk-bridge.mjs`，旧协议 stdout 同样卡这个上限）。
- 超时：默认 20s（`tutkTimeoutMs`，3~60s 可调），桥的采集时长 `--seconds` 也取 2~60s，两者上限一致；
  桥还额外留 20s 连接预算（`captureViaBridge` 的总超时 = `tutkTimeoutMs + 20000`）。
- ttcode 服务窗口约 9 分钟，**每次拍照都重新铸码**，不复用。
- 云端账号没绑打印机、或打印机离线 → 铸码失败，界面显示原因，不会返回旧图。

## 5. 隐私

- 画面只发给**发起拍照的那个人**所在的聊天（群里要绑定者自己开了群拍照）。
- 临时文件在同一目录写完即删；不落持久盘。
- 面板接口返回的是 `data:image/jpeg;base64,…`，不写盘。