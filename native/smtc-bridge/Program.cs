using System.Text.Json;
using NcmCli.SmtcBridge;
using Windows.Media.Control;

if (args.Contains("--self-test", StringComparer.OrdinalIgnoreCase))
{
    RunSelfTest();
    return;
}

if (args.Contains("--integration-test", StringComparer.OrdinalIgnoreCase))
{
    Environment.ExitCode = await RunIntegrationTestAsync() ? 0 : 1;
    return;
}

using var bridge = new SmtcBridge();
var shouldExit = false;
int? activeVersion = null;
string? activeSessionId = null;

while (!shouldExit && await Console.In.ReadLineAsync() is { } line)
{
    if (string.IsNullOrWhiteSpace(line))
    {
        continue;
    }

    string commandType = "unknown";
    try
    {
        using var document = JsonDocument.Parse(line);
        var command = document.RootElement;
        commandType = command.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String
            ? type.GetString() ?? "unknown"
            : "unknown";
        var version = command.TryGetProperty("v", out var protocolVersion) && protocolVersion.TryGetInt32(out var parsedVersion)
            ? parsedVersion
            : 0;
        var sessionId = command.TryGetProperty("sessionId", out var session) && session.ValueKind == JsonValueKind.String
            ? session.GetString()
            : null;

        if (commandType != "initialize" &&
            (activeVersion is null || version != activeVersion || !string.Equals(sessionId, activeSessionId, StringComparison.Ordinal)))
        {
            throw new InvalidDataException("Command protocol version or sessionId does not match the active session.");
        }

        switch (commandType)
        {
            case "initialize":
                if (version != 1 || string.IsNullOrWhiteSpace(sessionId))
                {
                    throw new InvalidDataException("initialize requires protocol v=1 and a non-empty sessionId.");
                }
                if (activeSessionId is not null && !string.Equals(sessionId, activeSessionId, StringComparison.Ordinal))
                {
                    throw new InvalidDataException("The bridge is already initialized for another sessionId.");
                }
                activeVersion = version;
                activeSessionId = sessionId;
                Protocol.Configure(version, sessionId);
                bridge.Initialize(command);
                Protocol.Write(new { type = "ready", protocolVersion = 1 });
                break;
            case "metadata":
                await bridge.UpdateMetadataAsync(command);
                Protocol.Write(new { type = "ack", command = commandType });
                break;
            case "playback":
                bridge.UpdatePlayback(command);
                Protocol.Write(new { type = "ack", command = commandType });
                break;
            case "shutdown":
                Protocol.Write(new { type = "ack", command = commandType });
                shouldExit = true;
                break;
            default:
                throw new InvalidDataException($"Unknown command type: {commandType}");
        }
    }
    catch (Exception error)
    {
        Protocol.Diagnostic($"Command '{commandType}' failed: {error}");
        Protocol.Write(new { type = "error", command = commandType, message = error.Message });
    }
}

static void RunSelfTest()
{
    var failures = new List<string>();

    if (Protocol.Clamp(50, 0, 100) != 50 ||
        Protocol.Clamp(-1, 0, 100) != 0 ||
        Protocol.Clamp(101, 0, 100) != 100 ||
        Protocol.Clamp(25, 100, 0) != 25)
    {
        failures.Add("timeline clamping");
    }

    if (Protocol.MapButton(Windows.Media.SystemMediaTransportControlsButton.Play) != "play" ||
        Protocol.MapButton(Windows.Media.SystemMediaTransportControlsButton.FastForward) != "fast_forward" ||
        Protocol.MapButton(Windows.Media.SystemMediaTransportControlsButton.Record) is not null)
    {
        failures.Add("button mapping");
    }

    if (failures.Count > 0)
    {
        throw new InvalidOperationException($"Self-test failed: {string.Join(", ", failures)}");
    }

    Protocol.Write(new { type = "selfTest", ok = true });
}

static async Task<bool> RunIntegrationTestAsync()
{
    var uniqueTitle = $"ncm-cli SMTC integration {Guid.NewGuid():N}";
    const string expectedArtist = "ncm-cli integration artist";
    const string expectedAlbum = "ncm-cli integration album";
    const long expectedPositionMs = 12_000;
    const long expectedDurationMs = 180_000;
    var coverPath = Path.Combine(Path.GetTempPath(), $"ncm-cli-smtc-{Guid.NewGuid():N}.png");
    await File.WriteAllBytesAsync(coverPath, Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwKkAAAAAElFTkSuQmCC"));
    void CleanupCover()
    {
        try { File.Delete(coverPath); } catch { }
    }

    using var bridge = new SmtcBridge();
    using var initialize = JsonDocument.Parse("""
        {"controls":{"play":true,"pause":true,"stop":true,"seek":true,"rewind":true,"fastForward":true}}
        """);
    bridge.Initialize(initialize.RootElement);

    using var metadata = JsonDocument.Parse(JsonSerializer.Serialize(new
    {
        title = uniqueTitle,
        artist = expectedArtist,
        album = expectedAlbum,
        coverPath
    }));
    await bridge.UpdateMetadataAsync(metadata.RootElement);

    using var playback = JsonDocument.Parse(JsonSerializer.Serialize(new
    {
        status = "playing",
        positionMs = expectedPositionMs,
        durationMs = expectedDurationMs
    }));
    bridge.UpdatePlayback(playback.RootElement);

    try
    {
        var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        for (var attempt = 0; attempt < 20; attempt++)
        {
            foreach (var session in manager.GetSessions())
            {
                var media = await session.TryGetMediaPropertiesAsync();
                if (!string.Equals(media.Title, uniqueTitle, StringComparison.Ordinal))
                {
                    continue;
                }

                var timeline = session.GetTimelineProperties();
                var status = session.GetPlaybackInfo().PlaybackStatus.ToString();
                ulong thumbnailBytes = 0;
                if (media.Thumbnail is not null)
                {
                    using var thumbnail = await media.Thumbnail.OpenReadAsync();
                    thumbnailBytes = thumbnail.Size;
                }
                var result = new
                {
                    type = "integrationTest",
                    visible = true,
                    sourceAppUserModelId = session.SourceAppUserModelId,
                    title = media.Title,
                    artist = media.Artist,
                    album = media.AlbumTitle,
                    thumbnailBytes,
                    playbackStatus = status,
                    positionMs = (long)timeline.Position.TotalMilliseconds,
                    durationMs = (long)timeline.EndTime.TotalMilliseconds
                };
                Console.Out.WriteLine(JsonSerializer.Serialize(result));

                var passed = string.Equals(media.Artist, expectedArtist, StringComparison.Ordinal) &&
                    string.Equals(media.AlbumTitle, expectedAlbum, StringComparison.Ordinal) &&
                    thumbnailBytes > 0 &&
                    string.Equals(status, "Playing", StringComparison.OrdinalIgnoreCase) &&
                    Math.Abs(timeline.Position.TotalMilliseconds - expectedPositionMs) < 1_000 &&
                    Math.Abs(timeline.EndTime.TotalMilliseconds - expectedDurationMs) < 1_000;
                CleanupCover();
                return passed;
            }

            await Task.Delay(250);
        }

        Console.Out.WriteLine(JsonSerializer.Serialize(new
        {
            type = "integrationTest",
            visible = false,
            title = uniqueTitle,
            sessionCount = manager.GetSessions().Count
        }));
        CleanupCover();
        return false;
    }
    catch (Exception error)
    {
        Console.Error.WriteLine(error);
        Console.Out.WriteLine(JsonSerializer.Serialize(new
        {
            type = "integrationTest",
            visible = false,
            error = error.Message
        }));
        CleanupCover();
        return false;
    }
}
