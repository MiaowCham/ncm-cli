# NCM CLI 点歌台

一个基于 [neteasecloudmusicapienhanced/api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) 的简单交互式点歌 CLI，支持歌曲搜索、歌词内容搜索、ID 直达、扫码登录或 Cookie 登录、歌词、播放链接、封面降级显示，以及带进度条和逐行歌词的本机播放。

## 安装与运行

要求 Node.js 22+，播放功能还需安装以下任一播放器并加入 `PATH`：`mpv`、`ffplay`、`vlc`。推荐安装 `mpv`：程序会通过 JSON IPC 复用常驻播放器，暂停、跳转、音量调整和切歌无需重启进程；未安装或无法初始化 mpv 时会自动回退到 ffplay/VLC 的兼容模式。

Windows 下会在 `npm install` 时尝试使用 .NET 8 SDK 构建 SMTC helper；未安装 SDK 时不会阻止安装或普通播放，但 SMTC 不可用。安装 SDK 后可随时执行 `npm run build:smtc`。如需生成不依赖目标机 .NET Runtime 的 helper，可在构建前设置 `NCM_SMTC_SELF_CONTAINED=1`。

Windows Terminal 1.22+ 用户若安装了 `chafa`，封面会优先通过原生 SIXEL 图形显示；Kitty/iTerm2 兼容终端则优先使用各自的原生图形协议。未确认协议支持或编码失败时，程序会安全降级到 `chafa` 字符图和内置 ANSI 24-bit 半块字符，不会盲发图形控制序列；无需另装 `img2sixel`。

```bash
npm install
npm start
```

也可安装为全局命令：

```bash
npm install -g .
ncm
```

首次启动且尚未保存设置时，程序会要求填写 API 地址并保存到 `settings.json`，不再使用硬编码的默认服务。程序仅兼容
[neteasecloudmusicapienhanced/api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced)
提供的 API，请填写由该项目部署的服务地址。

设置 `NCM_API_BASE_URL` 可仅对本次启动覆盖已保存地址；非交互式调用若尚未配置，则必须提供该环境变量。
交互界面可使用 `/api` 查看并输入新地址，或使用 `/api <url>` 直接保存并立即切换。切换后程序会重新验证当前
Cookie 在新服务上的登录状态；若服务暂时无法连接，用户明确保存的地址仍会保留。

## 操作

启动后直接输入歌曲名或“歌手 歌名”搜索，再输入结果序号。
输入斜杠命令或参数前缀后按 `Tab` 可自动补全；支持命令名、音质等级、歌词格式和 `/login status`。
普通歌曲搜索结果在交互式终端中使用 ↑/↓ 或滚轮选择，按 Enter 查看详情，按空格可跳过详情直接播放，按 `q`/`Esc` 返回主页。从歌曲详情退出后也会直接回到主页，不再重新显示上一次搜索结果。非交互模式仍支持数字选择。滚动列表的标题和操作提示使用高亮配色，便于在深色终端中阅读。
普通歌曲搜索和歌词搜索默认返回 30 条结果。该数量保存为 `settings.json` 中的 `searchLimit`（有效范围 1–100）；目前暂未提供对应命令，需要时可在程序退出后手动修改该设置。

```text
海阔天空
id:347230
ID=347230
id 347230
/id <id>
/lspl
/pl <id>
/api
/api https://your-api.example.com
/clear
/lyric 风雨里追赶
歌词:风雨里追赶
```

已登录用户可用 `/lspl` 列出自己的歌单，“喜欢的音乐”会置顶显示。在交互式终端中可用 ↑/↓ 或滚轮滚动选择，按 Enter 进入歌单详情，按 q 或 Esc 返回主页。歌单详情及歌单播放器中按 q 也会直接回到主页，不再返回 `/lspl` 列表。非交互式终端仍可输入序号选择。也可用 `/pl <id>` 直接预览指定歌单。歌单详情显示创建者、歌曲数、播放量、描述及前 15 首歌曲，并提供以下操作：

```text
p                       从第一首开始播放歌单
e                       选择格式并导出完整歌曲列表
e > playlist.txt        先指定文件，再选择导出格式（也支持 |）
u                       打印网易云歌单链接和封面链接
q                       返回上一级
```

导出时会显示格式菜单：`1` 仅歌曲（每行一个歌曲名）、`2` 当前方案（歌单信息和歌曲详情）、`3` CSV、`4` TSV。CSV/TSV 的字段为序号、歌曲、歌手、专辑、ID。格式选项也可直接追加输出文件，例如 `3 > playlist.csv`；如果 `e > 文件` 已指定目标，则格式选项中不要再次指定。导出不会覆盖已有文件。歌单播放会自动播放下一首，并跳过当前账号无法取得播放链接的歌曲。

歌词命令分为两种：

```text
/idlyric <id>                         ID 直出，默认纯歌词
/idlyric <id> lrc                     输出原始 LRC
/idlyric <id> all > lyrics.lrc        合并原文/翻译并写入文件

/lyric 风雨里追赶                    按歌词内容搜索，再选择歌曲和格式
/lyric 风雨里追赶 trans              选择歌曲后直接输出翻译 LRC
/lyric 风雨里追赶 lrc > lyrics.lrc   选择歌曲后写入原始 LRC
```

歌词格式为 `plain`、`lrc`、`trans`、`all`。歌词搜索结果支持 `1 > output.lrc` 或 `1 | output.lrc`；未在命令中指定格式时，会继续显示格式菜单，格式选项同样支持 `1 > output.lrc` 或 `1 | output.lrc`。所有结果、详情和格式菜单均可输入 `q` 返回上一级。

登录：

```text
/login
/login MUSIC_U=你的值; __csrf=你的值
/login status
/signout
```

无参数 `/login` 始终打印登录链接，然后按“字符二维码 → 与封面相同的图像渲染 → 仅链接”降级。登录成功后 Cookie 会清理为标准 Cookie Header 格式并缓存到操作系统的用户配置目录；旧版缓存会在启动时自动迁移。后续每个 API 请求都会携带 Cookie header。`/login status` 会向服务端验证状态，并在接口返回相应字段时显示昵称、用户 ID、账号 ID、等级、会员类型、累计听歌及关注信息，绝不显示 Cookie。`/signout` 会尝试通知服务端退出，并可靠地清除内存及磁盘 Cookie；重复执行也是安全的。可用 `NCM_CLI_CONFIG_DIR` 自定义缓存目录。

播放音质可交互选择或直接设置，并单独持久化到 `settings.json`，不会覆盖 Cookie：

```text
/quality
/quality lossless
```

播放展示时间默认向后偏移 `2000` 毫秒，以补偿播放输出与界面时间之间的延迟。偏移会统一作用于进度条、歌词和 SMTC 时间线；SMTC 进度跳转会自动换算回真实音频位置。使用 `/offset`
查看当前值并交互设置，或直接提供整数毫秒；负数会让展示时间提前。允许范围为
`-60000` 到 `60000` 毫秒，设置会与音质一起保存到 `settings.json`：

```text
/offset
/offset 2500
/offset -500
```

SMTC 还可以单独叠加一个额外偏移，默认 `0` 毫秒，只影响系统媒体控制的时间线与跳转换算，
不会改变终端进度和歌词。它会在普通 `/offset` 的基础上叠加，允许范围同样为 `-60000`
到 `60000` 毫秒，并持久化到 `settings.json`：

```text
/smtcoffset
/smtcoffset 250
/smtcoffset -100
```

输入 `/clear` 可清空当前终端内容并回到主搜索提示，不会退出程序或清除登录状态。

方向键历史记录只保存主页中的搜索和命令；歌曲详情、歌单详情、歌词格式、登录及设置子界面的选择不会写入历史。

支持 `standard`（标准）、`higher`（较高）、`exhigh`（极高）、`lossless`（无损）、`hires`（Hi-Res）、`jyeffect`（高清环绕声）、`sky`（沉浸环绕声）、`dolby`（杜比全景声）、`jymaster`（超清母带）。实际可用音质仍取决于账号会员权限和歌曲资源。

选中歌曲后可使用：

```text
p                       进入全屏播放页
l                       选择纯歌词、原始 LRC、翻译 LRC 或合并 LRC
l > lyrics.lrc          在格式菜单选择后写入文件（也支持 l | lyrics.lrc）
u                       打印播放链接和封面链接
q                       返回上一级
```

封面依次尝试已确认支持的原生终端图形协议（Windows Terminal 1.22+ 使用 `chafa` 编码 SIXEL，Kitty/iTerm2 使用对应协议）、`chafa` 字符图和内置 ANSI 24-bit 半块字符，失败时静默跳过。目标文件已存在时程序会拒绝覆盖。播放链接可能因登录状态、会员、地区或版权限制为空，这是上游 API/网易云权限限制。

歌曲详情会先显示尺寸稍大的封面，再显示元数据；封面无法渲染时保持静默，不再打印链接。

播放页使用终端独立全屏缓冲区，只在进入时绘制一次封面和元数据，下方显示进度、快捷键与多行歌词。快捷键提示在窄窗口中会以完整操作项为单位分段换行，不会从操作项中间断开。已播放歌词为白色，未播放歌词为淡灰色，可见行数会按终端高度裁剪：

播放控制会先立即更新状态和快捷键指示，再异步处理外部播放器；连续音量或跳转输入会合并后应用，避免为每次按键累计播放器重启。

```text
q       停止播放并返回歌曲详情
空格    暂停/继续
← / →   后退/前进 5 秒
↑ / ↓   提高/降低音量
Ctrl+↑/↓ 每次增加/减少 50ms 播放时间偏移，并立即保存
t       开关翻译歌词
r       刷新播放页面（不改变播放状态）
Ctrl+C  退出程序
```

播放歌单时按 `p` 可打开/关闭播放列表，以歌词区域浏览歌曲并用 `↑ / ↓` 或鼠标滚轮移动选择、`Enter` 跳转播放；`Ctrl+← / Ctrl+→` 切换上一首或下一首。关闭播放列表后，仅键盘上下键调整音量，滚轮不会改变音量。

进度默认每秒刷新一次；如果下一行歌词将在一秒内开始，会在该时间点额外刷新。

Windows 播放时会向 SMTC 发布标题、艺术家、专辑、封面、播放状态和应用普通偏移及 SMTC 额外偏移后的时间线，并接受系统的播放、暂停、停止、快进、后退与进度条跳转控制。歌单播放会在同一 SMTC 会话内原地切歌，并按当前位置启用系统上一首/下一首按钮。歌曲自然结束后会保留最后的媒体信息和时间线；单曲不再响应系统控制，歌单仍可通过上一首/下一首继续播放。helper 缺失或初始化失败时会自动降级，不影响终端播放控制。

也支持真正的 shell 管道/重定向；此模式只向标准输出写歌词正文：

```bash
ncm idlyric 347230 > lyrics.txt
ncm idlyric 347230 | Out-File -Encoding utf8 lyrics.txt
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
