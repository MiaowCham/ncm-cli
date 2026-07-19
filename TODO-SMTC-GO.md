# Go SMTC 与 MediaPlayer 后端实施记录

## 当前目标

- 用 Go 重写 Windows SMTC helper，降低分发体积。
- helper 支持 `smtc-only` 和 `media-player` 两种互斥模式。
- 将 `media-player` 与 MPV、VLC、ffplay 一同接入播放器后端选择。

## 状态

- 已完成：联网验证 WinRT MediaPlayer、SMTC、编解码能力与 go-musicfox 实现。
- 已完成：从干净且与 `origin/main` 同步的 `main` 创建 `codex/go-smtc-mediaplayer`。
- 已完成：Go 1.26.5 下构建并运行 WinRT helper 的 `smtc-only` 协议探针。
- 已完成：helper 已具备 `smtc-only` / `media-player` 初始化，以及 load、play、pause、seek、volume、stop 命令。
- 已完成：Node controller 与 SMTC 复用同一 helper，MediaPlayer 模式只产生一个会话。
- 已完成：播放器设置、CLI、Windows 自动选择顺序和 MPV 初始化失败后的 MediaPlayer 回退。
- 已完成：Go 构建脚本、x64/arm64 构建、系统 seek ABI、自然结束/失败事件和命令 ACK。
- 已完成：公开 HTTPS MP3 的 load、pause、seek、volume、stop 实际 WinRT 探针。
- 待处理：使用真实网易云签名 URL 做人工长时间播放与网络恢复验证。

## 关键决策

- 保留 NDJSON v1 的会话校验与现有 SMTC 命令，降低迁移风险。
- `smtc-only` 模式由 MPV/VLC/ffplay 播放，helper 只创建 SMTC 会话。
- `media-player` 模式由同一个 WinRT MediaPlayer 同时播放并承载 SMTC，禁止创建第二个会话。
- Windows `auto` 顺序采用 MPV、VLC、MediaPlayer、ffplay；非 Windows 不提供 MediaPlayer。
- 播放列表和自动切歌仍由 Node 管理；helper 只负责单曲播放与系统控制事件。

## 风险或阻塞

- 系统 PATH 没有 Go；验证使用经 SHA-256 校验的用户目录 Go 1.26.5，正式构建脚本仍要求 PATH 中存在 `go`。
- WinRT Go 绑定需验证 Windows SDK 兼容性、事件回调生命周期和异步操作错误传播。
- MediaPlayer 对网易云 URL 的 Header、Cookie、代理和错误恢复能力需实际播放验证。
- `winrt-go v0.1.4` 没有生成 seek 请求事件参数类型；已按 Windows SDK IID 补最小 ABI 包装。
- 当前播放流程使用 HTTPS `coverUri` 写入封面；协议仍接受但 Go helper 尚未消费本地 `coverPath`。
- 当前 `-trimpath -ldflags="-s -w"` 实测：win-x64 2,731,008 字节，win-arm64 2,528,768 字节。

## 相关文件与命令

- `native/smtc-bridge/`（Go module）
- `scripts/build-smtc.js`
- `src/smtc.js`
- `src/media.js`
- `src/parsers.js`
- `src/cli.js`
- `npm test`
- `npm run build:smtc`

## 下一步行动

1. 使用真实网易云签名 URL 做长时间播放、切歌和网络错误恢复验证。
2. 视实际需要补充本地 `coverPath` 的 WinRT 异步文件读取。
