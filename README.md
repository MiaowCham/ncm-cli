# NCM CLI 点歌台

一个基于 [NeteaseCloudMusicApi 服务](https://ncmapi.miaowcham.com/docs/#/) 的简单交互式点歌 CLI，支持歌曲搜索、歌词内容搜索、ID 直达、扫码登录或 Cookie 登录、歌词、播放链接、封面降级显示，以及带进度条和逐行歌词的本机播放。

## 安装与运行

要求 Node.js 22+，播放功能还需安装以下任一播放器并加入 `PATH`：`ffplay`、`mpv`、`vlc`。

Windows Terminal 与 GNOME Terminal 用户若希望获得更稳定的封面/二维码图像显示，可额外安装 `chafa`；程序会依次尝试 `chafa`、内置 ANSI 24-bit 半块字符和终端图片协议。

```bash
npm install
npm start
```

也可安装为全局命令：

```bash
npm install -g .
ncm
```

API 地址默认为 `https://ncmapi.miaowcham.com`，可通过 `NCM_API_BASE_URL` 覆盖。

## 操作

启动后直接输入歌曲名或“歌手 歌名”搜索，再输入结果序号。

```text
海阔天空
id:347230
ID=347230
id 347230
/id 347230
/lyrics 风雨里追赶
歌词:风雨里追赶
```

歌词命令分为两种：

```text
/lyrc 347230                         ID 直出，默认纯歌词
/lyrc 347230 lrc                     输出原始 LRC
/lyrc 347230 all > lyrics.lrc        合并原文/翻译并写入文件

/lyric 风雨里追赶                    按歌词内容搜索，再选择歌曲和格式
/lyric 风雨里追赶 trans              选择歌曲后直接输出翻译 LRC
/lyric 风雨里追赶 lrc > lyrics.lrc   选择歌曲后写入原始 LRC
```

歌词格式为 `plain`、`lrc`、`trans`、`all`。歌词搜索结果支持 `1 > output.lrc`；未在命令中指定格式时，会继续显示格式菜单，格式选项同样支持 `1 > output.lrc`。所有结果、详情和格式菜单均可输入 `q` 返回上一级。

登录：

```text
/login
/login MUSIC_U=你的值; __csrf=你的值
/login status
```

无参数 `/login` 始终打印登录链接，然后按“字符二维码 → 与封面相同的图像渲染 → 仅链接”降级。登录成功后 Cookie 会清理为标准 Cookie Header 格式并缓存到操作系统的用户配置目录；旧版缓存会在启动时自动迁移。后续每个 API 请求都会携带 Cookie header。可用 `/login status` 向服务端验证当前登录状态，可用 `NCM_CLI_CONFIG_DIR` 自定义缓存目录。

选中歌曲后可使用：

```text
p                       进入全屏播放页
l                       选择纯歌词、原始 LRC、翻译 LRC 或合并 LRC
l > lyrics.lrc          在格式菜单选择后写入文件
u                 打印播放链接
q                 返回上一级
```

封面依次通过 `chafa`、内置 ANSI 24-bit 半块字符和终端图片协议绘制，面向 Windows Terminal/GNOME Terminal，失败时静默跳过。目标文件已存在时程序会拒绝覆盖。播放链接可能因登录状态、会员、地区或版权限制为空，这是上游 API/网易云权限限制。

歌曲详情会先显示尺寸稍大的封面，再显示元数据；封面无法渲染时保持静默，不再打印链接。

播放页使用终端独立全屏缓冲区，只在进入时绘制一次封面和元数据，下方显示进度、快捷键与多行歌词。已播放歌词为白色，未播放歌词为淡灰色，可见行数会按终端高度裁剪：

```text
q       停止播放并返回歌曲详情
空格    暂停/继续
← / →   后退/前进 5 秒
Ctrl+C  退出程序
```

进度默认每秒刷新一次；如果下一行歌词将在一秒内开始，会在该时间点额外刷新。

也支持真正的 shell 管道/重定向；此模式只向标准输出写歌词正文：

```bash
ncm lyric 347230 > lyrics.txt
ncm lyric 347230 | Out-File -Encoding utf8 lyrics.txt
```

## 测试

```bash
npm test
npm run test:live
```

`npm test` 不访问网络；`npm run test:live` 会访问配置的 API 服务。

## 退出与日志

在主提示、登录轮询、网络请求或播放过程中按 `Ctrl+C`，程序会取消当前操作、终止播放器并以退出码 `130` 退出。

默认日志为脱敏 JSONL，不记录 Cookie、二维码数据、搜索词、歌词正文或完整媒体 URL：

- Windows：`%LOCALAPPDATA%\ncm-cli\logs\ncm-cli.log`
- 其他系统：位于用户配置目录下的 `ncm-cli/logs/ncm-cli.log`

日志按 `1 MiB × 5` 轮转。可用 `NCM_CLI_LOG_FILE` 自定义路径、`NCM_CLI_LOG_LEVEL=debug|info|warn|error` 调整级别。

## 安全说明

- Cookie 是账号凭证，请勿提交到 Git、粘贴到公开日志或发给他人。
- Cookie 文件按 `0600` 模式写入；Windows 上最终权限仍由用户目录 ACL 决定。
- 歌词文件输出由程序直接写入，不经 shell 执行。
- 本工具不绕过版权或会员限制，只使用 API 返回的播放地址。
