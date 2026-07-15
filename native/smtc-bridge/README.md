# ncm-cli SMTC bridge

Windows-only NDJSON bridge that publishes ncm-cli playback through System Media
Transport Controls. Protocol messages are written to stdout; diagnostics are
written to stderr.

Commands:

```json
{"v":1,"sessionId":"6df...","type":"initialize"}
{"v":1,"sessionId":"6df...","type":"metadata","title":"Title","artist":"Artist","album":"Album","coverPath":"C:\\cover.jpg","coverUri":"https://example.com/cover.jpg"}
{"v":1,"sessionId":"6df...","type":"playback","status":"playing","timeline":{"startMs":0,"endMs":240000,"minSeekMs":0,"maxSeekMs":240000,"positionMs":1000}}
{"v":1,"sessionId":"6df...","type":"shutdown"}
```

`coverPath` is preferred over `coverUri`. A remote cover URI must use HTTPS.
Invalid cover input is logged and ignored so it cannot break playback metadata.

Control events emitted by Windows use this shape:

```json
{"v":1,"sessionId":"6df...","type":"control","requestId":1,"action":"pause"}
{"v":1,"sessionId":"6df...","type":"control","requestId":2,"action":"seek_absolute","positionMs":120000}
```

Build or run the dependency-free self-test:

```powershell
dotnet build .\NcmCli.SmtcBridge.csproj
dotnet run --project .\NcmCli.SmtcBridge.csproj -- --self-test
dotnet run --project .\NcmCli.SmtcBridge.csproj -- --integration-test
.\build.ps1 -Configuration Release -Runtime win-x64 -SelfContained
```

The integration test registers a uniquely named SMTC session, then queries it
through `GlobalSystemMediaTransportControlsSessionManager` and verifies the
round-trip metadata, playback state, position, duration, and real Windows
previous/next requests (`TrySkipPreviousAsync` / `TrySkipNextAsync`).
