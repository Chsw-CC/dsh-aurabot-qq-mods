# 内置 TUTK 抓帧桥（bambu-tutk-bridge）

模块自带一个**单文件 C 程序**，把 OBN 的 TUTK 实现（`libBambuSource`）当库调用，抓一帧云端画面。
不需要 .NET、Node、npm 或任何第三方运行库：Windows 只用 `kernel32`，Linux 只用 `libdl`。

## 它做什么

```
Node（模块）→ 写 0600 临时文件（bambu:///tutk?…）→ 起 bambu-tutk-bridge
桥            → 加载 BambuSource → Bambu_Create/Open/StartStream/ReadSample → 写样本
Node          → MJPEG 直接用；H.264 交 ffmpeg 解一帧 → 删临时文件
```

凭据**从不进 argv**；库自己的日志默认关闭（`BAMBUSOURCE_LOG_LEVEL=off`，因为库会打印完整 URL）。

## 唯一的外部依赖：BambuSource

本模块**不打包**它（OBN 是 AGPL-3.0），需要你从 OBN 的 Releases 取一份：

| 平台 | 下载 | 取哪个文件 |
|---|---|---|
| Windows x64 | `obn-windows-x64.zip` | `lib/v02.09.01/BambuSource.dll` |
| Linux x64 | `obn-linux-x64.tar.gz` | `lib/libBambuSource.so` |

<https://github.com/ClusterM/open-bamboo-networking/releases>

**最省事的办法**：面板「设置 → 下载 BambuSource 库」按钮自动下载并解压到本目录
（国内自动走 GitHub 加速代理，实测国内约 5 秒；只拉需要的那几 MB，不是整包 88MB）。

**手动放到哪**：和桥程序放同一个目录（`modules/bambu-print/assets/tutk-bridge/`）就行，桥会自动找。
也可以：

- `--lib <路径>` 参数；
- `BAMBU_SOURCE_LIB` 环境变量；
- 面板「设置 → BambuSource 库路径」。

不指定时桥还会自动去切片器插件目录找最高版本：`%APPDATA%\\BambuStudio\\plugins\\v*\\`、
`~/.config/BambuStudio/plugins/v*/`、`~/.config/OrcaSlicer/plugins/v*/` 等。

**H.264 机型**（X1 / H2 / P2S / X2D）还需要 `ffmpeg` 在 `PATH` 里；A1 / A1 mini / P1P / P1S 是 MJPEG，不需要。

## 自带的可执行文件

| 平台 | 文件 | 大小 | 构建方式 |
|---|---|---|---|
| Windows x64 | `bambu-tutk-bridge.exe` | 226816 字节 | `zig cc -O2` |
| Linux x64 | `bambu-tutk-bridge-linux-x64` | 12936 字节 | `zig cc -O2 -s -target x86_64-linux-gnu … -ldl` |

模块按上面的文件名自动查找，所以默认**不需要配置任何路径**。

### 这两个二进制是什么、怎么核对

都由同目录的 `bambu-tutk-bridge.c`（单文件、MIT、约 18 KB）编译而来，编译器是 zig 0.17.1
（clang 22.1.8 / LLD 22.1.8）。源码和产物都在，谁都可以自己编一份比对：

- `SHA256SUMS` 记着两个产物与 .c 的 sha256。模块在启动桥之前会核对一次，对不上就拒绝执行
  （`BRIDGE_HASH_MISMATCH`），不会糊里糊涂跑一个被换过的二进制。
- Linux 那份可以**逐字节复现**：`./build.sh --repro`（或 `zig cc -O2 -s -target x86_64-linux-gnu
  -o bambu-tutk-bridge-linux-x64 bambu-tutk-bridge.c -ldl`）。`-s` 顺手去掉了调试信息——
  不放 `-s` 的话会把构建机的绝对路径写进 `.debug_str`。
- Windows 那份代码段可复现，但整文件差 20 字节（PE 时间戳 + PDB 签名，由 LLD 每次随机生成，
  连编两次也会差这么多）。比 `.text` / `.rdata` / `.data` 一致即可认定同源。

这个桥**不联网**（ELF 导入表没有 socket/connect，PE 导入表没有 ws2_32/wininet），
**不执行外部命令**（没有 system/popen/exec*/CreateProcess），只读 `--url-file`、写 `--dump`、
以及探测它自己目录找库。真正的 TUTK 流量在运行时加载的 BambuSource 里，不在这里。

## 自检

```bash
bambu-tutk-bridge --print-lib   # 打印它找到的 BambuSource 路径（找不到会列出已尝试的路径）
bambu-tutk-bridge --selftest    # 验证库能加载、导出函数齐全
```

面板「设置 → 检查 TUTK 组件」按钮走的是同一套检查（只读文件，不连打印机）。

## 调用约定（`lib/tutk-bridge.mjs` 就是这么调的）

```
bambu-tutk-bridge --url-file <tmp> --dump <tmp.bin> [--seconds N] [--lib <BambuSource>] [--verbose]
```

- `--url-file`：第一行是 `bambu:///tutk?uid=…&authkey=…&passwd=…&region=…`；
- `--dump`：输出原始样本（MJPEG 帧或 H.264 Annex-B 拼接）；
- 退出码：0 成功，2 参数/URL 错，**3 找不到或加载不了 BambuSource**，4/5/6 Create/Open/StartStream 失败，7 写文件失败，8 没拿到样本。

退出码 3 会被模块翻成一句人话：「没有找到 BambuSource 库……下载 OBN Releases……放到桥同目录」。

## 自己编译

```sh
# Linux：复现仓库里那份（逐字节相同）
ZIG=/path/to/zig ./build.sh --repro

# Linux：用自己的编译器出任意文件名
CC=gcc ./build.sh
OUT=my-bridge ./build.sh

# Windows
set ZIG=C:\path\to\zig.exe
build.bat
```

`build.bat` 依次找 `%ZIG%`、PATH 里的 `zig`、MSVC 的 `cl`、MinGW 的 `gcc`，
用哪个都会打印出来。没用 zig 也能编，只是产物不会和仓库里那份逐字节相同。

编译器只要支持 C99 就够。源码在开头自己定义了 `_POSIX_C_SOURCE` / `_DEFAULT_SOURCE`，
所以 `-std=c11 -Wall -Wextra` 严格模式在 glibc / musl 上也编得过（早期版本漏了这两行，
在严格模式下 `readlink` / `clock_gettime` / `setenv` 会报隐式声明）。

## 许可

本桥 MIT。它在运行时加载的 `libBambuSource` 属于 open-bamboo-networking（AGPL-3.0）——
本模块**不打包**该库，也不复制其代码，只调用你自己安装的副本。
