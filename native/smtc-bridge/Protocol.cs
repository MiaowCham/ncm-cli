using System.Text.Json;
using Windows.Media;

namespace NcmCli.SmtcBridge;

internal static class Protocol
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private static readonly object OutputLock = new();
    private static int? _version;
    private static string? _sessionId;
    private static long _requestId;

    public static void Configure(int version, string sessionId)
    {
        _version = version;
        _sessionId = sessionId;
    }

    public static void Write(object message)
    {
        lock (OutputLock)
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                if (_version is { } version)
                {
                    writer.WriteNumber("v", version);
                }
                if (_sessionId is { } sessionId)
                {
                    writer.WriteString("sessionId", sessionId);
                }

                foreach (var property in JsonSerializer.SerializeToElement(message, JsonOptions).EnumerateObject())
                {
                    property.WriteTo(writer);
                }
                writer.WriteEndObject();
            }

            Console.Out.WriteLine(System.Text.Encoding.UTF8.GetString(buffer.ToArray()));
            Console.Out.Flush();
        }
    }

    public static long NextRequestId() => Interlocked.Increment(ref _requestId);

    public static void Diagnostic(string message) =>
        Console.Error.WriteLine($"[{DateTimeOffset.Now:O}] {message}");

    public static string? MapButton(SystemMediaTransportControlsButton button) => button switch
    {
        SystemMediaTransportControlsButton.Play => "play",
        SystemMediaTransportControlsButton.Pause => "pause",
        SystemMediaTransportControlsButton.Stop => "stop",
        SystemMediaTransportControlsButton.FastForward => "fast_forward",
        SystemMediaTransportControlsButton.Rewind => "rewind",
        _ => null
    };

    public static long Clamp(long value, long minimum, long maximum)
    {
        if (maximum < minimum)
        {
            (minimum, maximum) = (maximum, minimum);
        }

        return Math.Clamp(value, minimum, maximum);
    }
}
