# ncm-cli Windows media bridge

Windows-only Go helper for System Media Transport Controls (SMTC) and the
optional WinRT `MediaPlayer` backend. It communicates with Node over NDJSON;
stdout is reserved for protocol messages and diagnostics go to stderr.

Modes sent in the `initialize` command:

- `smtc-only`: MPV, VLC, or ffplay owns playback; this process only publishes SMTC.
- `media-player`: one WinRT `MediaPlayer` instance owns both playback and SMTC.

Build an optimized executable:

```powershell
go build -trimpath -ldflags="-s -w" -o ncm-cli-smtc-bridge.exe .
```

The repository build writes the architecture-specific binary to
`publish/win-x64/` or `publish/win-arm64/`:

```powershell
npm run build:smtc
```

The protocol retains v1 session validation and the existing `metadata`,
`controls`, `playback`, and `shutdown` commands. MediaPlayer mode additionally
accepts `load`, `play`, `pause`, `seek`, `volume`, and `stop`. Player commands
use `commandId`; the helper echoes it in `ack` or `error` responses.
