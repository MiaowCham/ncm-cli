using System.Text.Json;
using Windows.Media;
using Windows.Media.Playback;
using Windows.Storage;
using Windows.Storage.Streams;

namespace NcmCli.SmtcBridge;

internal sealed class SmtcBridge : IDisposable
{
    private MediaPlayer? _player;
    private SystemMediaTransportControls? _smtc;
    private bool _seekEnabled = true;
    private bool _disposed;

    internal event Action<string>? ControlReceived;

    public void Initialize(JsonElement command)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_smtc is not null)
        {
            return;
        }

        _player = new MediaPlayer();
        _player.CommandManager.IsEnabled = false;

        _smtc = _player.SystemMediaTransportControls;
        var controls = command.TryGetProperty("controls", out var configuredControls) && configuredControls.ValueKind == JsonValueKind.Object
            ? configuredControls
            : default;
        bool Enabled(string name, bool fallback = true) =>
            controls.ValueKind == JsonValueKind.Object && controls.TryGetProperty(name, out var value) &&
            (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False)
                ? value.GetBoolean()
                : fallback;

        _seekEnabled = Enabled("seek");
        _smtc.IsEnabled = true;
        _smtc.IsPlayEnabled = Enabled("play");
        _smtc.IsPauseEnabled = Enabled("pause");
        _smtc.IsStopEnabled = Enabled("stop");
        _smtc.IsNextEnabled = Enabled("next", false);
        _smtc.IsPreviousEnabled = Enabled("previous", false);
        _smtc.IsFastForwardEnabled = Enabled("fastForward");
        _smtc.IsRewindEnabled = Enabled("rewind");
        _smtc.DisplayUpdater.Type = MediaPlaybackType.Music;
        _smtc.ButtonPressed += OnButtonPressed;
        _smtc.PlaybackPositionChangeRequested += OnPlaybackPositionChangeRequested;
    }

    public void UpdateControls(JsonElement command)
    {
        var smtc = RequireInitialized();
        var controls = command.TryGetProperty("controls", out var nested) && nested.ValueKind == JsonValueKind.Object
            ? nested
            : command;
        if (controls.TryGetProperty("previous", out var previous) &&
            (previous.ValueKind == JsonValueKind.True || previous.ValueKind == JsonValueKind.False))
        {
            smtc.IsPreviousEnabled = previous.GetBoolean();
        }
        if (controls.TryGetProperty("next", out var next) &&
            (next.ValueKind == JsonValueKind.True || next.ValueKind == JsonValueKind.False))
        {
            smtc.IsNextEnabled = next.GetBoolean();
        }
    }

    public async Task UpdateMetadataAsync(JsonElement command)
    {
        var smtc = RequireInitialized();
        var updater = smtc.DisplayUpdater;

        // Type must be assigned before MusicProperties is accessed. Otherwise WinRT
        // fails with ERROR_NOT_SUPPORTED in an unpackaged console process.
        updater.Type = MediaPlaybackType.Music;
        var music = updater.MusicProperties;
        music.Title = ReadString(command, "title") ?? string.Empty;
        music.Artist = ReadString(command, "artist") ?? string.Empty;
        music.AlbumTitle = ReadString(command, "album") ?? string.Empty;

        updater.Thumbnail = await ResolveThumbnailAsync(command);
        updater.Update();
    }

    public void UpdatePlayback(JsonElement command)
    {
        var smtc = RequireInitialized();
        var status = (ReadString(command, "status") ?? "stopped").ToLowerInvariant();
        smtc.PlaybackStatus = status switch
        {
            "playing" => MediaPlaybackStatus.Playing,
            "paused" => MediaPlaybackStatus.Paused,
            "stopped" => MediaPlaybackStatus.Stopped,
            _ => throw new InvalidDataException($"Unsupported playback status: {status}")
        };

        var timeline = command.TryGetProperty("timeline", out var nested) && nested.ValueKind == JsonValueKind.Object
            ? nested
            : command;

        var startMs = ReadLong(timeline, "startMs", 0);
        var endMs = Math.Max(startMs, ReadLong(timeline, "endMs", ReadLong(timeline, "durationMs", startMs)));
        var minSeekMs = Protocol.Clamp(ReadLong(timeline, "minSeekMs", startMs), startMs, endMs);
        var maxSeekMs = Protocol.Clamp(ReadLong(timeline, "maxSeekMs", endMs), minSeekMs, endMs);
        var positionMs = Protocol.Clamp(ReadLong(timeline, "positionMs", startMs), minSeekMs, maxSeekMs);

        smtc.UpdateTimelineProperties(new SystemMediaTransportControlsTimelineProperties
        {
            StartTime = TimeSpan.FromMilliseconds(startMs),
            EndTime = TimeSpan.FromMilliseconds(endMs),
            MinSeekTime = TimeSpan.FromMilliseconds(minSeekMs),
            MaxSeekTime = TimeSpan.FromMilliseconds(maxSeekMs),
            Position = TimeSpan.FromMilliseconds(positionMs)
        });
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        if (_smtc is not null)
        {
            _smtc.ButtonPressed -= OnButtonPressed;
            _smtc.PlaybackPositionChangeRequested -= OnPlaybackPositionChangeRequested;
            _smtc.PlaybackStatus = MediaPlaybackStatus.Closed;
            _smtc.IsEnabled = false;
        }

        _player?.Dispose();
        _smtc = null;
        _player = null;
    }

    private void OnButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        var action = Protocol.MapButton(args.Button);
        if (action is not null)
        {
            ControlReceived?.Invoke(action);
            Protocol.Write(new { type = "control", requestId = Protocol.NextRequestId(), action });
        }
    }

    private void OnPlaybackPositionChangeRequested(
        SystemMediaTransportControls sender,
        PlaybackPositionChangeRequestedEventArgs args)
    {
        if (!_seekEnabled)
        {
            return;
        }

        Protocol.Write(new
        {
            type = "control",
            requestId = Protocol.NextRequestId(),
            action = "seek_absolute",
            positionMs = (long)Math.Max(0, args.RequestedPlaybackPosition.TotalMilliseconds)
        });
    }

    private SystemMediaTransportControls RequireInitialized() =>
        _smtc ?? throw new InvalidOperationException("SMTC bridge has not been initialized.");

    private static async Task<RandomAccessStreamReference?> ResolveThumbnailAsync(JsonElement command)
    {
        var coverPath = ReadString(command, "coverPath");
        if (!string.IsNullOrWhiteSpace(coverPath))
        {
            try
            {
                var fullPath = Path.GetFullPath(coverPath);
                var file = await StorageFile.GetFileFromPathAsync(fullPath);
                return RandomAccessStreamReference.CreateFromFile(file);
            }
            catch (Exception error)
            {
                Protocol.Diagnostic($"Unable to load coverPath: {error.Message}");
            }
        }

        var coverUri = ReadString(command, "coverUri");
        if (!string.IsNullOrWhiteSpace(coverUri))
        {
            try
            {
                var uri = new Uri(coverUri, UriKind.Absolute);
                if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidDataException("coverUri must use HTTPS.");
                }

                return RandomAccessStreamReference.CreateFromUri(uri);
            }
            catch (Exception error)
            {
                Protocol.Diagnostic($"Unable to load coverUri: {error.Message}");
            }
        }

        return null;
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static long ReadLong(JsonElement element, string name, long fallback)
    {
        if (!element.TryGetProperty(name, out var property))
        {
            return fallback;
        }

        if (property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out var integer))
        {
            return integer;
        }

        if (property.ValueKind == JsonValueKind.Number && property.TryGetDouble(out var number) && double.IsFinite(number))
        {
            return (long)number;
        }

        return fallback;
    }
}
