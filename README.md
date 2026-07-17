# NCM CLI 点歌台

[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://github.com/search?q=repo%3AMiaowCham%2FCodex_Limit_Widget++language%3AC%23&type=code)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/MiaowCham/ncm-cli/blob/main/LICENSE)
[![GitHub last commit](https://img.shields.io/github/last-commit/MiaowCham/ncm-cli)](https://github.com/MiaowCham/ncm-cli/commits/main)

一个运行在终端中的网易云音乐播放器。支持歌曲与歌词搜索、歌单浏览、扫码或 Cookie 登录、逐行歌词、封面显示、播放列表，以及 mpv、VLC 和 ffplay 播放后端。

> [!NOTE]
> 本项目由 OpenAI Codex 制作  
> 依赖 [NeteaseCloudMusicApi Enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced)。首次启动时需要填写由该项目部署的 API 地址。

## 功能

- 搜索歌曲或歌词，支持歌曲 ID 直达
- 浏览歌曲与歌单详情，滚动选择并播放歌曲
- 显示逐行歌词、翻译歌词和歌词预览
- 支持 SIXEL、Kitty、iTerm2、字符画等终端图片协议
- 支持二维码登录、Cookie 登录和登录状态查询
- 登录后可在播放页收藏歌曲，再次按键可取消收藏
- 支持纯随机、打乱列表、列表循环和单曲循环
- 使用 mpv 或 VLC 时提供常驻播放器控制与系统媒体控制
- 导出歌词或歌单为文本、LRC、CSV 和 TSV

## 安装与运行

需要 Node.js 22 或更高版本，并安装以下任一播放器：

- `mpv`（推荐）
- `vlc`
- `ffplay`

播放器需要加入 `PATH`。自动选择顺序为 `mpv → VLC → ffplay`。

```bash
npm install
npm start
```

也可以安装为全局命令：

```bash
npm install -g .
ncm
```

> [!NOTE]
> Windows 下，`npm install` 会尝试使用 .NET 8 SDK 构建 SMTC helper。缺少 SDK 不会影响普通播放；安装 SDK 后可运行 `npm run build:smtc` 补充构建。

首次启动会要求填写 API 地址并保存至 `settings.json`。也可通过环境变量临时指定：

```bash
NCM_API_BASE_URL=https://your-api.example.com npm start
```

Windows PowerShell：

```powershell
$env:NCM_API_BASE_URL = 'https://your-api.example.com'
npm start
```

## 基本操作

启动后直接输入歌曲名、`歌手 歌名`，或使用歌曲 ID：

```text
海阔天空
id:347230
ID=347230
id 347230
/id 347230
```

交互列表支持：

| 按键 | 操作 |
|---|---|
| `↑` / `↓`、滚轮 | 移动选择 |
| `Enter` | 查看详情或确认 |
| `Space` | 直接播放歌曲 |
| `d` | 在歌单歌曲列表中查看歌曲详情 |
| `q` / `Esc` | 返回 |

输入斜杠命令或参数前缀后按 `Tab` 可以自动补全。

## 常用命令

| 命令 | 说明 |
|---|---|
| `/lspl` | 查看当前用户的歌单 |
| `/pl <id>` | 查看指定歌单 |
| `/lyric <内容>` | 按歌词内容搜索 |
| `/idlyric <id>` | 按歌曲 ID 获取歌词 |
| `/login` | 二维码登录 |
| `/login <Cookie>` | Cookie 登录 |
| `/login status` | 查看登录状态 |
| `/signout` | 退出登录 |
| `/quality [level]` | 查看或设置音质 |
| `/player [backend]` | 查看或设置播放器后端 |
| `/image [protocol]` | 查看或设置图片协议 |
| `/offset [毫秒]` | 查看或设置播放时间偏移 |
| `/smtcoffset [毫秒]` | 查看或设置 SMTC 额外偏移 |
| `/api [url]` | 查看或更换 API 地址 |
| `/clear` | 清空终端内容 |

播放器后端支持 `auto`、`mpv`、`vlc`、`ffplay`；图片协议支持 `auto`、`sixel`、`kitty`、`iterm2`、`symbols`、`ansi`、`none`。

音质可选值：

```text
standard  higher  exhigh  lossless  hires
jyeffect  sky     dolby   jymaster
```

实际可用音质取决于账号权限和歌曲资源。

## 歌单与歌曲详情

登录后使用 `/lspl` 查看自己的歌单，“喜欢的音乐”会置顶显示。歌单详情快捷键：

| 按键 | 操作 |
|---|---|
| `p` | 从第一首开始播放歌单 |
| `l` | 打开歌曲列表，按 `Enter` 或空格播放 |
| `e` | 导出完整歌曲列表 |
| `u` | 显示或隐藏歌单与封面链接 |
| `q` | 返回上一级 |

歌曲详情快捷键：

| 按键 | 操作 |
|---|---|
| `p` | 进入播放页 |
| `l` | 导出歌词 |
| `u` | 显示或隐藏播放与封面链接 |
| `q` | 返回上一级 |

详情页会根据终端尺寸自动调整封面、歌词和歌单预览长度。快捷键直接响应，无需按回车。

## 播放控制

| 按键 | 操作 |
|---|---|
| `Space` | 暂停或继续 |
| `←` / `→` | 后退或前进 5 秒 |
| `↑` / `↓` | 调整音量 |
| `Ctrl+↑` / `Ctrl+↓` | 以 50 ms 调整播放时间偏移 |
| `t` | 开关翻译歌词 |
| `f` | 收藏或取消收藏当前歌曲（仅登录后显示） |
| `r` | 刷新播放页面 |
| `q` | 停止播放并返回 |
| `Ctrl+C` | 退出程序 |

播放歌单时还有以下操作：

| 按键 | 操作 |
|---|---|
| `p` | 打开或关闭播放列表 |
| `Ctrl+←` / `Ctrl+→` | 上一首或下一首 |
| `s` | 切换不随机、纯随机、打乱列表 |
| `l` | 切换顺序播放、列表循环、单曲循环 |

mpv 和 VLC 会尽量复用常驻播放器，使暂停、跳转、音量和切歌无需重启进程；初始化失败时会安全降级。VLC RC 的跳转精度为整数秒。

Windows 下会向 SMTC 发布标题、歌手、专辑、封面、播放状态和时间线，并接受系统媒体面板的播放、暂停、停止、跳转及歌单切歌操作。

## 终端图片

封面显示会按环境尝试原生图片协议，并在失败时降级：

1. Windows Terminal 1.22+：通过 `chafa` 输出 SIXEL
2. Kitty / iTerm2：使用对应原生协议
3. `chafa` 字符图
4. 内置 ANSI 24-bit 半块字符

使用 `/image` 可以交互选择协议。此设置不影响登录二维码，二维码始终优先使用字符画。

> [!NOTE]
> Windows Terminal 若要直接显示图像，需要 Windows Terminal 1.22+，并确保 `chafa` 已安装且可从 `PATH` 调用。

## 导出歌词与歌单

歌词格式支持 `plain`、`lrc`、`trans` 和 `all`：

```text
/idlyric 347230
/idlyric 347230 lrc
/idlyric 347230 all > lyrics.lrc
/lyric 风雨里追赶 trans
```

歌单可导出为：

1. 仅歌曲名
2. 歌单信息与歌曲详情
3. CSV
4. TSV

输出目标既可以是文件，也可以是目录。省略目标、只输入 `>` 或 `|` 时，会在当前目录自动创建文件；目录不存在时会自动创建，自动生成的文件若重名会追加序号。

也支持真正的 Shell 管道和重定向：

```bash
ncm idlyric 347230 > lyrics.txt
ncm idlyric 347230 | Out-File -Encoding utf8 lyrics.txt
```

## 配置

默认配置存放在操作系统的用户配置目录，可通过 `NCM_CLI_CONFIG_DIR` 修改位置。

- `NCM_API_BASE_URL`：临时覆盖 API 地址
- `NCM_CLI_CONFIG_DIR`：自定义配置目录
- `NCM_CLI_LOG_FILE`：自定义日志路径
- `NCM_CLI_LOG_LEVEL`：`debug`、`info`、`warn` 或 `error`
- `NCM_SMTC_SELF_CONTAINED=1`：构建独立运行的 Windows SMTC helper

普通播放时间偏移默认是 `2000 ms`，同时作用于进度条、歌词和 SMTC 时间线。`/smtcoffset` 设置的额外偏移只影响 SMTC。两者范围均为 `-60000` 至 `60000 ms`。

## 测试

```bash
npm test
npm run test:live
```

`npm test` 不访问网络；`npm run test:live` 会连接已配置的 API 服务。

## 日志

日志采用脱敏 JSONL，不记录 Cookie、二维码数据、搜索词、歌词正文或完整媒体 URL。

- Windows：`%LOCALAPPDATA%\ncm-cli\logs\ncm-cli.log`
- 其他系统：用户配置目录下的 `ncm-cli/logs/ncm-cli.log`

日志按 `1 MiB × 5` 轮转。

## 安全说明

- Cookie 是账号凭证，请勿提交到 Git、公开日志或发送给他人。
- 歌词和歌单文件由程序直接写入，不会交给 Shell 执行。
- 本工具不会绕过版权、会员或地区限制，只使用 API 返回的播放地址。
- 播放链接可能因账号权限、会员、地区或版权限制而不可用。

## 致谢

- [NeteaseCloudMusicApi Enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced)
- [mpv](https://mpv.io/)
- [VLC](https://www.videolan.org/vlc/)
- [FFmpeg / ffplay](https://ffmpeg.org/)

## 许可证

本项目基于 [MIT License](https://github.com/MiaowCham/ncm-cli/blob/main/LICENSE) 发布。
