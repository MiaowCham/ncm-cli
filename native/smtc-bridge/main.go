//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"unsafe"

	"github.com/go-ole/go-ole"
	"github.com/saltosystems/winrt-go"
	"github.com/saltosystems/winrt-go/windows/foundation"
	"github.com/saltosystems/winrt-go/windows/media"
	"github.com/saltosystems/winrt-go/windows/media/core"
	"github.com/saltosystems/winrt-go/windows/media/playback"
	"github.com/saltosystems/winrt-go/windows/storage/streams"
)

const (
	protocolVersion      = 1
	ticksPerMillisecond  = int64(10_000)
	signatureInspectable = "cinterface(IInspectable)"
)

type command struct {
	Version   int             `json:"v"`
	SessionID string          `json:"sessionId"`
	Type      string          `json:"type"`
	CommandID int64           `json:"commandId"`
	Mode      string          `json:"mode"`
	URL       string          `json:"url"`
	Title     string          `json:"title"`
	Artist    string          `json:"artist"`
	Album     string          `json:"album"`
	CoverURI  string          `json:"coverUri"`
	Status    string          `json:"status"`
	Position  int64           `json:"positionMs"`
	Duration  int64           `json:"durationMs"`
	Volume    float64         `json:"volume"`
	Controls  json.RawMessage `json:"controls"`
	Previous  *bool           `json:"previous"`
	Next      *bool           `json:"next"`
}

type controlOptions struct {
	Play        *bool `json:"play"`
	Pause       *bool `json:"pause"`
	Stop        *bool `json:"stop"`
	FastForward *bool `json:"fastForward"`
	Rewind      *bool `json:"rewind"`
	Previous    *bool `json:"previous"`
	Next        *bool `json:"next"`
}

type bridge struct {
	mu               sync.Mutex
	outputMu         sync.Mutex
	player           *playback.MediaPlayer
	smtc             *media.SystemMediaTransportControls
	mode             string
	initialized      bool
	version          int
	sessionID        string
	requestID        atomic.Int64
	playerGeneration atomic.Int64
	buttonToken      foundation.EventRegistrationToken
	buttonEvent      *foundation.TypedEventHandler
	endedToken       foundation.EventRegistrationToken
	endedEvent       *foundation.TypedEventHandler
	failedToken      foundation.EventRegistrationToken
	failedEvent      *foundation.TypedEventHandler
	seekToken        foundation.EventRegistrationToken
	seekEvent        *foundation.TypedEventHandler
}

var buttonEventGUID = winrt.ParameterizedInstanceGUID(
	foundation.GUIDTypedEventHandler,
	media.SignatureSystemMediaTransportControls,
	media.SignatureSystemMediaTransportControlsButtonPressedEventArgs,
)

var playerEventGUID = winrt.ParameterizedInstanceGUID(
	foundation.GUIDTypedEventHandler,
	playback.SignatureMediaPlayer,
	signatureInspectable,
)

var playerFailedEventGUID = winrt.ParameterizedInstanceGUID(
	foundation.GUIDTypedEventHandler,
	playback.SignatureMediaPlayer,
	playback.SignatureMediaPlayerFailedEventArgs,
)

const (
	playbackPositionArgsGUID      = "b4493f88-eb28-4961-9c14-335e44f3e125"
	playbackPositionArgsSignature = "rc(Windows.Media.PlaybackPositionChangeRequestedEventArgs;{b4493f88-eb28-4961-9c14-335e44f3e125})"
)

var playbackPositionEventGUID = winrt.ParameterizedInstanceGUID(
	foundation.GUIDTypedEventHandler,
	media.SignatureSystemMediaTransportControls,
	playbackPositionArgsSignature,
)

type playbackPositionArgs struct{ ole.IInspectable }
type playbackPositionArgsInterface struct{ ole.IInspectable }
type playbackPositionArgsVTable struct {
	ole.IInspectableVtbl
	GetRequestedPlaybackPosition uintptr
}

func (args *playbackPositionArgs) requestedPosition() (foundation.TimeSpan, error) {
	inspectable := args.MustQueryInterface(ole.NewGUID(playbackPositionArgsGUID))
	defer inspectable.Release()
	value := (*playbackPositionArgsInterface)(unsafe.Pointer(inspectable))
	vtable := (*playbackPositionArgsVTable)(unsafe.Pointer(value.RawVTable))
	var result foundation.TimeSpan
	hr, _, _ := syscall.SyscallN(
		vtable.GetRequestedPlaybackPosition,
		uintptr(unsafe.Pointer(value)),
		uintptr(unsafe.Pointer(&result)),
	)
	if hr != 0 {
		return result, ole.NewError(hr)
	}
	return result, nil
}

func main() {
	if err := ole.RoInitialize(1); err != nil {
		fatal(err)
	}

	b := &bridge{}
	defer b.close()
	scanner := bufio.NewScanner(os.Stdin)
	buffer := make([]byte, 64*1024)
	scanner.Buffer(buffer, 64*1024)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}
		var cmd command
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			b.write(map[string]any{"type": "error", "command": "unknown", "message": err.Error()})
			continue
		}
		shutdown, err := b.handle(cmd)
		if err != nil {
			b.write(response(cmd, "error", map[string]any{"message": err.Error()}))
			continue
		}
		if shutdown {
			return
		}
	}
	if err := scanner.Err(); err != nil {
		fatal(err)
	}
}

func (b *bridge) handle(cmd command) (bool, error) {
	if cmd.Type == "initialize" {
		if cmd.Version != protocolVersion || cmd.SessionID == "" {
			return false, errors.New("initialize requires protocol v=1 and a non-empty sessionId")
		}
		if b.player != nil && cmd.SessionID != b.sessionID {
			return false, errors.New("bridge is already initialized for another sessionId")
		}
		mode := cmd.Mode
		if mode == "" {
			mode = "smtc-only"
		}
		if mode != "smtc-only" && mode != "media-player" {
			return false, fmt.Errorf("unsupported mode: %s", mode)
		}
		b.version, b.sessionID, b.mode = cmd.Version, cmd.SessionID, mode
		if err := b.initialize(cmd.Controls); err != nil {
			return false, err
		}
		b.initialized = true
		b.write(map[string]any{"type": "ready", "protocolVersion": protocolVersion, "mode": mode})
		return false, nil
	}
	if !b.initialized || cmd.Version != b.version || cmd.SessionID != b.sessionID {
		return false, errors.New("command protocol version or sessionId does not match the active session")
	}

	var err error
	switch cmd.Type {
	case "metadata":
		err = b.setMetadata(cmd)
	case "controls":
		raw := cmd.Controls
		if len(raw) == 0 {
			raw, _ = json.Marshal(controlOptions{Previous: cmd.Previous, Next: cmd.Next})
		}
		err = b.setControls(raw)
	case "playback":
		err = b.setPlayback(cmd)
	case "load":
		err = b.load(cmd)
	case "play":
		err = b.requirePlayerMode(b.player.Play)
	case "pause":
		err = b.requirePlayerMode(b.player.Pause)
	case "seek":
		err = b.seek(cmd.Position)
	case "volume":
		err = b.setVolume(cmd.Volume)
	case "stop":
		err = b.stop()
	case "shutdown":
		b.write(response(cmd, "ack", nil))
		return true, nil
	default:
		return false, fmt.Errorf("unknown command type: %s", cmd.Type)
	}
	if err != nil {
		return false, err
	}
	b.write(response(cmd, "ack", nil))
	return false, nil
}

func (b *bridge) initialize(raw json.RawMessage) error {
	player, err := playback.NewMediaPlayer()
	if err != nil {
		return err
	}
	b.player = player
	if err := player.SetAudioCategory(playback.MediaPlayerAudioCategoryMedia); err != nil {
		return err
	}
	manager, err := player.GetCommandManager()
	if err != nil {
		return err
	}
	defer manager.Release()
	if err := manager.SetIsEnabled(false); err != nil {
		return err
	}
	b.smtc, err = player.GetSystemMediaTransportControls()
	if err != nil {
		return err
	}
	if err := b.smtc.SetIsEnabled(true); err != nil {
		return err
	}
	if err := b.setControls(raw); err != nil {
		return err
	}
	b.buttonEvent = foundation.NewTypedEventHandler(ole.NewGUID(buttonEventGUID), b.onButton)
	b.buttonToken, err = b.smtc.AddButtonPressed(b.buttonEvent)
	if err != nil {
		return fmt.Errorf("register SMTC button event: %w", err)
	}
	b.seekEvent = foundation.NewTypedEventHandler(ole.NewGUID(playbackPositionEventGUID), b.onSeekRequested)
	b.seekToken, err = b.smtc.AddPlaybackPositionChangeRequested(b.seekEvent)
	if err != nil {
		return fmt.Errorf("register SMTC seek event: %w", err)
	}
	if b.mode == "media-player" {
		b.endedEvent = foundation.NewTypedEventHandler(ole.NewGUID(playerEventGUID), b.onMediaEnded)
		b.endedToken, err = b.player.AddMediaEnded(b.endedEvent)
		if err != nil {
			return fmt.Errorf("register MediaPlayer ended event: %w", err)
		}
		b.failedEvent = foundation.NewTypedEventHandler(ole.NewGUID(playerFailedEventGUID), b.onMediaFailed)
		b.failedToken, err = b.player.AddMediaFailed(b.failedEvent)
		if err != nil {
			return fmt.Errorf("register MediaPlayer failed event: %w", err)
		}
	}
	return err
}

func (b *bridge) setControls(raw json.RawMessage) error {
	options := controlOptions{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &options); err != nil {
			return err
		}
	}
	value := func(v *bool, fallback bool) bool {
		if v == nil {
			return fallback
		}
		return *v
	}
	setters := []struct {
		enabled bool
		set     func(bool) error
	}{
		{value(options.Play, true), b.smtc.SetIsPlayEnabled},
		{value(options.Pause, true), b.smtc.SetIsPauseEnabled},
		{value(options.Stop, true), b.smtc.SetIsStopEnabled},
		{value(options.FastForward, true), b.smtc.SetIsFastForwardEnabled},
		{value(options.Rewind, true), b.smtc.SetIsRewindEnabled},
		{value(options.Previous, false), b.smtc.SetIsPreviousEnabled},
		{value(options.Next, false), b.smtc.SetIsNextEnabled},
	}
	for _, item := range setters {
		if err := item.set(item.enabled); err != nil {
			return err
		}
	}
	return nil
}

func (b *bridge) setMetadata(cmd command) error {
	updater, err := b.smtc.GetDisplayUpdater()
	if err != nil {
		return err
	}
	defer updater.Release()
	if err := updater.SetType(media.MediaPlaybackTypeMusic); err != nil {
		return err
	}
	props, err := updater.GetMusicProperties()
	if err != nil {
		return err
	}
	defer props.Release()
	if err := props.SetTitle(cmd.Title); err != nil {
		return err
	}
	if err := props.SetArtist(cmd.Artist); err != nil {
		return err
	}
	if err := props.SetAlbumTitle(cmd.Album); err != nil {
		return err
	}
	if cmd.CoverURI != "" {
		uri, uriErr := foundation.UriCreateUri(cmd.CoverURI)
		if uriErr != nil {
			return uriErr
		}
		defer uri.Release()
		thumbnail, thumbnailErr := streams.RandomAccessStreamReferenceCreateFromUri(uri)
		if thumbnailErr != nil {
			return thumbnailErr
		}
		defer thumbnail.Release()
		if err := updater.SetThumbnail(thumbnail); err != nil {
			return err
		}
	}
	return updater.Update()
}

func (b *bridge) setPlayback(cmd command) error {
	status := map[string]media.MediaPlaybackStatus{
		"playing": media.MediaPlaybackStatusPlaying,
		"paused":  media.MediaPlaybackStatusPaused,
		"stopped": media.MediaPlaybackStatusStopped,
	}[strings.ToLower(cmd.Status)]
	if cmd.Status == "" || (status == media.MediaPlaybackStatusClosed && cmd.Status != "closed") {
		return fmt.Errorf("unsupported playback status: %s", cmd.Status)
	}
	if err := b.smtc.SetPlaybackStatus(status); err != nil {
		return err
	}
	timeline, err := media.NewSystemMediaTransportControlsTimelineProperties()
	if err != nil {
		return err
	}
	defer timeline.Release()
	duration, position := max(cmd.Duration, 0), max(cmd.Position, 0)
	position = min(position, duration)
	start := foundation.TimeSpan{}
	end := foundation.TimeSpan{Duration: duration * ticksPerMillisecond}
	pos := foundation.TimeSpan{Duration: position * ticksPerMillisecond}
	if err := timeline.SetStartTime(start); err != nil {
		return err
	}
	if err := timeline.SetEndTime(end); err != nil {
		return err
	}
	if err := timeline.SetMinSeekTime(start); err != nil {
		return err
	}
	if err := timeline.SetMaxSeekTime(end); err != nil {
		return err
	}
	if err := timeline.SetPosition(pos); err != nil {
		return err
	}
	return b.smtc.UpdateTimelineProperties(timeline)
}

func (b *bridge) load(cmd command) error {
	if b.mode != "media-player" {
		return errors.New("load requires media-player mode")
	}
	if cmd.URL == "" {
		return errors.New("load requires a URL")
	}
	b.playerGeneration.Add(1)
	uri, err := foundation.UriCreateUri(cmd.URL)
	if err != nil {
		return err
	}
	defer uri.Release()
	source, err := core.MediaSourceCreateFromUri(uri)
	if err != nil {
		return err
	}
	defer source.Release()
	if err := b.player.SetSource((*playback.IMediaPlaybackSource)(unsafe.Pointer(source))); err != nil {
		return err
	}
	if cmd.Volume >= 0 {
		if err := b.setVolume(cmd.Volume); err != nil {
			return err
		}
	}
	if cmd.Position > 0 {
		if err := b.seek(cmd.Position); err != nil {
			return err
		}
	}
	return b.player.Play()
}

func (b *bridge) seek(position int64) error {
	return b.requirePlayerMode(func() error {
		session, err := b.player.GetPlaybackSession()
		if err != nil {
			return err
		}
		defer session.Release()
		return session.SetPosition(foundation.TimeSpan{Duration: max(position, 0) * ticksPerMillisecond})
	})
}

func (b *bridge) setVolume(volume float64) error {
	return b.requirePlayerMode(func() error {
		if volume > 1 {
			volume /= 100
		}
		volume = max(0, min(volume, 1))
		return b.player.SetVolume(volume)
	})
}

func (b *bridge) stop() error {
	return b.requirePlayerMode(func() error {
		if err := b.player.Pause(); err != nil {
			return err
		}
		if err := b.seek(0); err != nil {
			return err
		}
		return b.player.SetSource(nil)
	})
}

func (b *bridge) requirePlayerMode(action func() error) error {
	if b.mode != "media-player" {
		return errors.New("player command requires media-player mode")
	}
	return action()
}

func (b *bridge) onButton(_ *foundation.TypedEventHandler, _ unsafe.Pointer, args unsafe.Pointer) {
	eventArgs := (*media.SystemMediaTransportControlsButtonPressedEventArgs)(args)
	button, err := eventArgs.GetButton()
	if err != nil {
		return
	}
	action := map[media.SystemMediaTransportControlsButton]string{
		media.SystemMediaTransportControlsButtonPlay:        "play",
		media.SystemMediaTransportControlsButtonPause:       "pause",
		media.SystemMediaTransportControlsButtonStop:        "stop",
		media.SystemMediaTransportControlsButtonFastForward: "fast_forward",
		media.SystemMediaTransportControlsButtonRewind:      "rewind",
		media.SystemMediaTransportControlsButtonPrevious:    "previous",
		media.SystemMediaTransportControlsButtonNext:        "next",
	}[button]
	if action != "" {
		b.write(map[string]any{"type": "control", "requestId": b.requestID.Add(1), "action": action})
	}
}

func (b *bridge) onMediaEnded(_ *foundation.TypedEventHandler, _ unsafe.Pointer, _ unsafe.Pointer) {
	b.write(map[string]any{"type": "player_event", "event": "ended", "generation": b.playerGeneration.Load()})
}

func (b *bridge) onSeekRequested(_ *foundation.TypedEventHandler, _ unsafe.Pointer, args unsafe.Pointer) {
	if args == nil {
		return
	}
	position, err := (*playbackPositionArgs)(args).requestedPosition()
	if err != nil {
		return
	}
	b.write(map[string]any{
		"type": "control", "requestId": b.requestID.Add(1),
		"action": "seek_absolute", "positionMs": max(position.Duration/ticksPerMillisecond, 0),
	})
}

func (b *bridge) onMediaFailed(_ *foundation.TypedEventHandler, _ unsafe.Pointer, args unsafe.Pointer) {
	message := "Windows MediaPlayer playback failed"
	if args != nil {
		failed := (*playback.MediaPlayerFailedEventArgs)(args)
		if value, err := failed.GetErrorMessage(); err == nil && value != "" {
			message = value
		}
	}
	b.write(map[string]any{
		"type": "player_event", "event": "error", "message": message,
		"generation": b.playerGeneration.Load(),
	})
}

func response(cmd command, kind string, extra map[string]any) map[string]any {
	result := map[string]any{"type": kind, "command": cmd.Type}
	if cmd.CommandID != 0 {
		result["commandId"] = cmd.CommandID
	}
	for key, value := range extra {
		result[key] = value
	}
	return result
}

func (b *bridge) write(message map[string]any) {
	b.outputMu.Lock()
	defer b.outputMu.Unlock()
	if b.version != 0 {
		message["v"] = b.version
	}
	if b.sessionID != "" {
		message["sessionId"] = b.sessionID
	}
	_ = json.NewEncoder(os.Stdout).Encode(message)
}

func (b *bridge) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.smtc != nil {
		if b.buttonEvent != nil {
			_ = b.smtc.RemoveButtonPressed(b.buttonToken)
		}
		if b.seekEvent != nil {
			_ = b.smtc.RemovePlaybackPositionChangeRequested(b.seekToken)
		}
		_ = b.smtc.SetPlaybackStatus(media.MediaPlaybackStatusClosed)
		_ = b.smtc.SetIsEnabled(false)
		b.smtc.Release()
	}
	if b.buttonEvent != nil {
		b.buttonEvent.Release()
	}
	if b.seekEvent != nil {
		b.seekEvent.Release()
	}
	if b.player != nil {
		if b.endedEvent != nil {
			_ = b.player.RemoveMediaEnded(b.endedToken)
		}
		if b.failedEvent != nil {
			_ = b.player.RemoveMediaFailed(b.failedToken)
		}
		_ = b.player.Close()
		b.player.Release()
	}
	if b.endedEvent != nil {
		b.endedEvent.Release()
	}
	if b.failedEvent != nil {
		b.failedEvent.Release()
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
