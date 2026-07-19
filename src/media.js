import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import chalk from 'chalk';
import stringWidth from 'string-width';
import supportsTerminalGraphics from 'supports-terminal-graphics';
import { parseLrc } from './lyrics.js';
import { loadCachedImage, peekCachedImage } from './image-cache.js';
import { createMpvController } from './mpv-controller.js';
import { createSmtcBridge } from './smtc.js';
import { createVlcController } from './vlc-controller.js';
import { hasProcessExited } from './process-state.js';
import { guardPlayerProcess } from './process-guardian.js';
import { acquireTerminalScreen } from './terminal-screen.js';
import { primaryText, secondaryBackground, secondaryText } from './terminal-theme.js';
import {
  CREDITS_FONT_HINT_DURATION_MS,
  creditsEasterEggFrame,
  creditsEasterEggShowsFrame,
  creditsEasterEggTimelineForSong,
  creditsFontRecommendation,
  easterEggForSong
} from './credits-csf.js';
import {
  CREDITS_PLAYER_TRANSITION_REFRESH_MS,
  composeCreditsPlayerTransitionRows,
  playCreditsPageRevealTransition,
  playCreditsPlayerTransition
} from './credits-player-transition.js';

let cachedWindowsTerminalVersion;
let retainedSmtcBridge = null;

export function createLatestDebounce(callback, delayMs = 80) {
  let timer = null;
  let pendingValue;
  return {
    schedule(value) {
      pendingValue = value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        callback(pendingValue);
      }, Math.max(0, Number(delayMs) || 0));
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

export function waitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

/** 关闭单曲自然结束后为系统媒体面板保留的最后一个 SMTC 会话。 */
export async function closeRetainedSmtc() {
  const bridge = retainedSmtcBridge;
  retainedSmtcBridge = null;
  await bridge?.close();
}

export function resolveCommandExecutable(command, {
  platform = process.platform, probe = spawnSync
} = {}) {
  const requested = platform === 'win32' && !/\.(?:exe|com|cmd|bat)$/i.test(command)
    ? `${command}.exe`
    : command;
  const locator = platform === 'win32' ? 'where.exe' : 'which';
  const result = probe(locator, [requested], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function commandExists(command) {
  return Boolean(resolveCommandExecutable(command));
}

function compareVersions(left, right) {
  const leftParts = String(left || '').split('.').map(Number);
  const rightParts = String(right || '').split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function detectWindowsTerminalVersion() {
  if (cachedWindowsTerminalVersion !== undefined) return cachedWindowsTerminalVersion;
  if (process.platform !== 'win32' || !process.env.WT_SESSION) return '';
  if (process.env.WT_VERSION) return process.env.WT_VERSION;
  const command = [
    "$versions = Get-Process -Name WindowsTerminal -ErrorAction SilentlyContinue | ForEach-Object { $_.MainModule.FileVersionInfo.ProductVersion }",
    "$versions | Where-Object { $_ }"
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000
  });
  const versions = result.status === 0 ? result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
  cachedWindowsTerminalVersion = versions.sort(compareVersions).at(-1) || '';
  return cachedWindowsTerminalVersion;
}

export function supportsSixelEnvironment({
  env = process.env,
  platform = process.platform,
  windowsTerminalVersion = platform === 'win32' ? detectWindowsTerminalVersion() : '',
  detectedSixel = supportsTerminalGraphics.stdout.sixel
} = {}) {
  if (platform === 'win32') {
    return Boolean(env.WT_SESSION) && compareVersions(windowsTerminalVersion, '1.22.0') >= 0;
  }
  return Boolean(detectedSixel);
}

export function imageProtocolOrder({ preference = 'auto', kitty = false, iterm2 = false, sixel = false, chafa = false } = {}) {
  if (preference === 'none') return [];
  if (preference !== 'auto') {
    if (preference === 'kitty') return kitty ? ['kitty', 'ansi'] : ['ansi'];
    if (preference === 'iterm2') return iterm2 ? ['iterm2', 'ansi'] : ['ansi'];
    // 显式选择 SIXEL 时直接尝试编码。Windows Terminal 的版本探测可能因
    // 进程权限或商店安装方式失败，用户选择不应再被自动探测结果否决。
    if (preference === 'sixel') return chafa ? ['sixel', 'ansi'] : ['ansi'];
    if (preference === 'symbols') return chafa ? ['symbols', 'ansi'] : ['ansi'];
    if (preference === 'ansi256') return ['ansi256'];
    return ['ansi'];
  }
  const order = [];
  if (kitty) order.push('kitty');
  if (iterm2) order.push('iterm2');
  if (sixel && chafa) order.push('sixel');
  if (chafa) order.push('symbols');
  order.push('ansi');
  return order;
}

export function findPlayer(commands = ['mpv', 'vlc', 'cvlc', 'ffplay']) {
  const candidates = commands.map((command) => ({
    command,
    executable: resolveCommandExecutable(command),
    args: (url, seconds, volume) => playerArguments(command, url, seconds, volume)
  }));
  return candidates.find((item) => item.executable) || null;
}

export function playerBackendLabel(command, { persistent = ['mpv', 'vlc', 'cvlc'].includes(command) } = {}) {
  if (!command) return '未找到';
  if (command === 'mpv') return persistent ? 'mpv（JSON IPC）' : 'mpv（兼容模式）';
  if (command === 'vlc' || command === 'cvlc') return persistent ? 'VLC（oldrc）' : 'VLC（兼容模式）';
  if (command === 'ffplay') return 'ffplay（兼容模式）';
  return String(command);
}

export function playerCommandsForBackend(backend = 'auto') {
  if (backend === 'mpv') return ['mpv'];
  if (backend === 'vlc') return ['vlc', 'cvlc'];
  if (backend === 'ffplay') return ['ffplay'];
  return ['mpv', 'vlc', 'cvlc', 'ffplay'];
}

export function playerArguments(command, url, seconds, volume = 100) {
  const safeVolume = clamp(Math.round(volume), 0, 100);
  if (command === 'ffplay') return ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', String(seconds), '-volume', String(safeVolume), url];
  if (command === 'mpv') return ['--no-video', '--really-quiet', `--start=${seconds}`, `--volume=${safeVolume}`, url];
  // VLC 的 100% 音量对应内部刻度 256。
  const vlcVolume = Math.round(safeVolume * 2.56);
  if (command === 'vlc') return ['--intf', 'dummy', '--play-and-exit', `--start-time=${seconds}`, `--volume=${vlcVolume}`, url];
  if (command === 'cvlc') return ['--play-and-exit', `--start-time=${seconds}`, `--volume=${vlcVolume}`, url];
  throw new Error(`不支持的播放器：${command}`);
}

export function playbackAction(buffer, { playlistOpen = false, playlistSelection = 0 } = {}) {
  const key = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  if (key.includes('\u0003')) return { type: 'interrupt' };
  if (playlistOpen && (key.toLowerCase() === 'q' || key === '\u001b')) return { type: 'close_playlist' };
  if (key.toLowerCase() === 'q') return { type: 'quit' };
  if (key.toLowerCase() === 'r') return { type: 'refresh' };
  if (key.includes('\u001b[1;5D') || key.includes('\u001b[5D')) return { type: 'playlist_previous' };
  if (key.includes('\u001b[1;5C') || key.includes('\u001b[5C')) return { type: 'playlist_next' };
  // Ctrl+方向键必须先于普通方向键和鼠标序列判断，避免被识别为音量或歌单滚动。
  if (key.includes('\u001b[1;5A') || key.includes('\u001b[5A')) return { type: 'offset', deltaMs: 50 };
  if (key.includes('\u001b[1;5B') || key.includes('\u001b[5B')) return { type: 'offset', deltaMs: -50 };
  const sgrMouse = key.match(/\u001b\[<(\d+);\d+;\d+([Mm])/);
  if (sgrMouse) {
    const button = Number(sgrMouse[1]);
    if (sgrMouse[2] === 'M' && (button & 64) === 64 && (button & 128) === 0) {
      if (!playlistOpen) return { type: 'ignore' };
      return { type: 'playlist_move', delta: (button & 1) === 0 ? -1 : 1 };
    }
    return { type: 'ignore' };
  }
  if (key.toLowerCase() === 'p') return { type: 'toggle_playlist' };
  if (key.toLowerCase() === 's') return { type: 'cycle_random_mode' };
  if (key.toLowerCase() === 'l') return { type: 'cycle_loop_mode' };
  if (key.toLowerCase() === 'f') return { type: 'favorite' };
  if (playlistOpen && (key === '\r' || key === '\n')) return { type: 'playlist_select', index: playlistSelection };
  if (key === ' ') return { type: 'toggle_pause' };
  if (key.includes('\u001b[D')) return { type: 'seek', deltaMs: -5000 };
  if (key.includes('\u001b[C')) return { type: 'seek', deltaMs: 5000 };
  if (playlistOpen && key.includes('\u001b[A')) return { type: 'playlist_move', delta: -1 };
  if (playlistOpen && key.includes('\u001b[B')) return { type: 'playlist_move', delta: 1 };
  if (key.includes('\u001b[A')) return { type: 'volume', delta: 5 };
  if (key.includes('\u001b[B')) return { type: 'volume', delta: -5 };
  if (key.toLowerCase() === 't') return { type: 'toggle_translation' };
  return { type: 'ignore' };
}

export function playbackTerminalModeSequence(entering) {
  return entering
    ? '\u001b[?1007l\u001b[?1000h\u001b[?1006h'
    : '\u001b[?1000l\u001b[?1006l\u001b[?1007h';
}

export function playbackEntrySequence(directAnimation = false) {
  return `${playbackTerminalModeSequence(true)}\x1b[?25l${directAnimation ? '' : '\x1b[2J\x1b[H'}`;
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function createPlaybackClock(durationMs, now = () => performance.now()) {
  let basePositionMs = 0;
  let startedAt = now();
  let paused = false;
  const position = () => clamp(paused ? basePositionMs : basePositionMs + now() - startedAt, 0, durationMs);
  return {
    get paused() { return paused; },
    position,
    pause() {
      if (!paused) {
        basePositionMs = position();
        paused = true;
      }
      return basePositionMs;
    },
    resume() {
      if (paused) {
        startedAt = now();
        paused = false;
      }
      return basePositionMs;
    },
    seek(deltaMs) {
      basePositionMs = clamp(position() + deltaMs, 0, durationMs);
      startedAt = now();
      return basePositionMs;
    },
    seekTo(positionMs) {
      basePositionMs = clamp(Number(positionMs) || 0, 0, durationMs);
      startedAt = now();
      return basePositionMs;
    }
  };
}

export function displayPosition(rawMs, offsetMs = 0) {
  const raw = Number(rawMs);
  const offset = Number(offsetMs);
  return (Number.isFinite(raw) ? raw : 0) - (Number.isFinite(offset) ? offset : 0);
}

export function rawPosition(displayMs, offsetMs = 0, durationMs = Infinity) {
  const display = Number(displayMs);
  const offset = Number(offsetMs);
  const duration = Number(durationMs);
  const maximum = Number.isFinite(duration) ? Math.max(0, duration) : Infinity;
  const safeDisplay = Number.isFinite(display) ? display : 0;
  if (safeDisplay <= 0) return 0;
  return clamp(safeDisplay + (Number.isFinite(offset) ? offset : 0), 0, maximum);
}

export function adjustPlaybackOffset(offsetMs, deltaMs) {
  const current = Number(offsetMs);
  const delta = Number(deltaMs);
  return clamp(
    (Number.isFinite(current) ? current : 0) + (Number.isFinite(delta) ? delta : 0),
    -60000,
    60000
  );
}

export function createTrackOffsetSession(configuredOffsetMs = 0) {
  const configured = adjustPlaybackOffset(configuredOffsetMs, 0);
  let current = configured;
  return {
    get value() { return current; },
    adjust(deltaMs) {
      current = adjustPlaybackOffset(current, deltaMs);
      return current;
    },
    reset() {
      current = configured;
      return current;
    }
  };
}

export function lyricPosition(elapsedMs, lyricOffsetMs = 0) {
  const offset = Number(lyricOffsetMs);
  return displayPosition(elapsedMs, Number.isFinite(offset) ? offset : 0);
}

export function nextRefreshDelay(elapsedMs, lyricLines, paused = false, lyricOffsetMs = 0, animationIntervalMs = Infinity) {
  if (paused) return 1000;
  const toNextSecond = 1000 - (Math.floor(elapsedMs) % 1000 || 0);
  const lyricElapsedMs = lyricPosition(elapsedMs, lyricOffsetMs);
  const nextLyric = lyricLines.find((line) => line.timeMs > lyricElapsedMs);
  const toNextLyric = nextLyric ? nextLyric.timeMs - lyricElapsedMs : Infinity;
  const animationDelay = Number.isFinite(Number(animationIntervalMs))
    ? Math.max(16, Number(animationIntervalMs))
    : Infinity;
  return clamp(Math.min(toNextSecond, toNextLyric, animationDelay), 16, 1000);
}

function truncateText(text, width) {
  if (stringWidth(text) <= width) return text;
  let output = '';
  for (const character of text) {
    if (stringWidth(`${output}${character}…`) > width) break;
    output += character;
  }
  return `${output}…`;
}

/** 按终端显示宽度换行；英文优先保持完整单词，中文与超长单词按字符宽度拆分。 */
export function wrapTerminalText(text, width) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const rows = [];
  const appendLongToken = (token) => {
    let chunk = '';
    for (const character of token) {
      if (chunk && stringWidth(chunk) + stringWidth(character) > safeWidth) {
        rows.push(chunk);
        chunk = '';
      }
      chunk += character;
    }
    return chunk;
  };
  const paragraphs = String(text ?? '').split('\n');
  for (const paragraph of paragraphs) {
    let row = '';
    let pendingSpace = false;
    const tokens = paragraph.match(/\s+|[^\s]+/gu) || [];
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        pendingSpace = Boolean(row);
        continue;
      }
      const prefix = row && pendingSpace ? ' ' : '';
      if (stringWidth(`${row}${prefix}${token}`) <= safeWidth) {
        row += `${prefix}${token}`;
      } else {
        if (row) rows.push(row);
        row = stringWidth(token) <= safeWidth ? token : appendLongToken(token);
      }
      pendingSpace = false;
    }
    rows.push(row);
  }
  if (!rows.length) rows.push('');
  return rows;
}

export function playbackShortcutRows(options = {}, width = 80) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const segments = playbackShortcutText(options).split(/\s{2,}/).filter(Boolean);
  const rows = [];
  let row = '';
  for (const segment of segments) {
    if (stringWidth(segment) > safeWidth) {
      if (row) rows.push(row);
      rows.push(...wrapTerminalText(segment, safeWidth));
      row = '';
      continue;
    }
    const candidate = row ? `${row}  ${segment}` : segment;
    if (stringWidth(candidate) <= safeWidth) row = candidate;
    else {
      if (row) rows.push(row);
      row = segment;
    }
  }
  if (row || !rows.length) rows.push(row);
  return rows;
}

/** SMTC 使用物理歌曲时长；offset 只修正对外报告的位置。 */
export function smtcTimeline(rawPositionMs, durationMs, offsetMs = 0) {
  const duration = Math.max(0, Number.isFinite(Number(durationMs)) ? Number(durationMs) : 0);
  const raw = clamp(Number.isFinite(Number(rawPositionMs)) ? Number(rawPositionMs) : 0, 0, duration);
  return {
    // 物理媒体已经到达终点时必须报告完整结束位置，
    // 避免正偏移让系统媒体面板误以为尾部被截断。
    positionMs: raw >= duration ? duration : clamp(displayPosition(raw, offsetMs), 0, duration),
    durationMs: duration
  };
}

export function lyricViewport(lines, elapsedMs, capacity) {
  if (!lines.length || capacity <= 0) return [];
  let currentIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs > elapsedMs) break;
    currentIndex = index;
  }
  // 播放页只显示当前歌词和之后的歌词，不再保留历史行。
  const start = Math.max(0, currentIndex);
  return lines.slice(start, start + capacity).map((line, offset) => ({
    ...line,
    played: start + offset <= currentIndex,
    current: start + offset === currentIndex
  }));
}

export function attachLyricTranslations(originalLines, translatedLines, romanizedLines = []) {
  const translations = new Map();
  for (const line of translatedLines) {
    const texts = translations.get(line.timeMs) || [];
    if (!texts.includes(line.text)) texts.push(line.text);
    translations.set(line.timeMs, texts);
  }
  const romanized = new Map();
  for (const line of romanizedLines) romanized.set(line.timeMs, line.text);
  return originalLines.map((line) => {
    const value = {
      ...line,
      translation: (translations.get(line.timeMs) || []).filter((text) => text !== line.text).join(' / ')
    };
    const romanizedText = romanized.get(line.timeMs);
    if (romanizedText) value.romanized = romanizedText;
    return value;
  });
}

export function playbackLyricRows(lines, elapsedMs, capacity, showTranslation, width = Infinity, currentOnly = false) {
  if (capacity <= 0) return [];
  const viewport = lyricViewport(lines, elapsedMs, capacity);
  const visible = currentOnly ? viewport.filter((line) => line.current) : viewport;
  const rowsFor = (line, includeTranslation = true) => {
    const wrap = (text, translation) => (Number.isFinite(width) ? wrapTerminalText(text, width) : [text])
      .map((part, index) => ({
        text: part, played: line.played, current: line.current, translation, continuation: index > 0
      }));
    const rows = wrap(line.text, false);
    if (includeTranslation && showTranslation && line.translation) {
      rows.push(...wrap(line.translation, true));
    }
    return rows;
  };
  const currentIndex = visible.findIndex((line) => line.current);
  if (currentIndex < 0) return visible.flatMap((line) => rowsFor(line)).slice(0, capacity);

  const output = [...rowsFor(visible[currentIndex])];
  for (const line of visible.slice(currentIndex + 1)) output.push(...rowsFor(line));
  return output.slice(0, capacity);
}

export function toggleTranslationState(showTranslation, hasTranslation) {
  if (!hasTranslation) return { showTranslation: false, indicator: '暂无翻译' };
  const next = !showTranslation;
  return { showTranslation: next, indicator: `翻译 ${next ? '已开启' : '已关闭'}` };
}

export function lyricTone(line) {
  if (line.current) return 'current';
  if (line.played) return 'played';
  return 'future';
}

export function playlistViewport(tracks, selectedIndex, currentIndex, capacity) {
  const items = Array.isArray(tracks) ? tracks : [];
  const count = items.length;
  const safeCapacity = Math.max(0, Math.floor(Number(capacity) || 0));
  if (!count || !safeCapacity) return { start: 0, selectedIndex: -1, rows: [] };
  const selected = clamp(Math.floor(Number(selectedIndex) || 0), 0, count - 1);
  const current = clamp(Math.floor(Number(currentIndex) || 0), 0, count - 1);
  const maximumStart = Math.max(0, count - safeCapacity);
  const start = clamp(selected - Math.floor(safeCapacity / 2), 0, maximumStart);
  return {
    start,
    selectedIndex: selected,
    rows: items.slice(start, start + safeCapacity).map((track, offset) => ({
      track,
      index: start + offset,
      selected: start + offset === selected,
      current: start + offset === current
    }))
  };
}

export const RANDOM_MODES = ['off', 'random', 'shuffle'];
export const LOOP_MODES = ['sequence', 'list', 'single'];

export function shuffledPlaylistOrder(length, currentIndex, random = Math.random) {
  const rest = Array.from({ length }, (_, index) => index).filter((index) => index !== currentIndex);
  for (let index = rest.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [rest[index], rest[swap]] = [rest[swap], rest[index]];
  }
  return length ? [currentIndex, ...rest] : [];
}

export function playbackShortcutText({ canFavorite = false, favorited = false, canToggleTranslation = true } = {}) {
  const base = `q 返回  空格 暂停/继续  ←/→ 快退/快进  ↑/↓ 音量  Ctrl+↑/↓ 偏移${canToggleTranslation ? '  t 译/音' : ''}  r 刷新`;
  return canFavorite ? `${base}  f ${favorited ? '取消收藏' : '收藏'}` : base;
}

export function playbackPlaylistModeText({ randomLabel, loopLabel, playlistOpen = false } = {}) {
  const modes = `[s 随机：${randomLabel || '不随机'}]  [l 循环：${loopLabel || '顺序播放'}]`;
  return playlistOpen
    ? `${modes}  [p/Esc 关闭]  [↑/↓ 选择]  [Enter 播放]  [Ctrl+←/→ 切歌]`
    : `${modes}  [p 歌单]  [Ctrl+←/→ 切歌]`;
}

export function playbackPlaylistModeRows(options = {}, width = 80) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const segments = playbackPlaylistModeText(options).split(/\s{2,}/).filter(Boolean);
  const rows = [];
  let row = '';
  for (const segment of segments) {
    const candidate = row ? `${row}  ${segment}` : segment;
    if (stringWidth(candidate) <= safeWidth) {
      row = candidate;
      continue;
    }
    if (row) rows.push(row);
    if (stringWidth(segment) <= safeWidth) row = segment;
    else {
      rows.push(...wrapTerminalText(segment, safeWidth));
      row = '';
    }
  }
  if (row || !rows.length) rows.push(row);
  return rows;
}

export function playbackProgressText({
  bar = '', timeText = '', paused = false, columns = 80, colorizePaused = chalk.yellow
} = {}) {
  const width = Math.max(1, columns);
  const rawTime = String(timeText);
  const styleTime = (value) => paused ? colorizePaused(value) : value;
  const full = `${bar} ${rawTime}`;
  if (stringWidth(full) <= width) return `${bar} ${styleTime(rawTime)}`;
  const barWidth = stringWidth(bar);
  if (barWidth >= width) return bar;
  const timeWidth = Math.max(0, width - barWidth - 1);
  return timeWidth > 0 ? `${bar} ${styleTime(truncateText(rawTime, timeWidth))}` : bar;
}

export async function runPlaybackExitSequence({ stop, transition, onError = () => {} } = {}) {
  for (const [stage, operation] of [['stop', stop], ['transition', transition]]) {
    if (typeof operation !== 'function') continue;
    try {
      await operation();
    } catch (error) {
      await onError(error, stage);
    }
  }
}

export async function startTrackWithPreparedHeader({
  directAnimation = false,
  drawHeader,
  startPlayback,
  signal,
  onHeaderError = () => {}
} = {}) {
  if (directAnimation) {
    try {
      if (signal) {
        if (signal.aborted) return false;
        let removeAbortListener = () => {};
        const aborted = new Promise((_, reject) => {
          const onAbort = () => reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener('abort', onAbort);
        });
        try {
          await Promise.race([Promise.resolve(drawHeader?.(signal)), aborted]);
        } finally {
          removeAbortListener();
        }
      } else {
        await drawHeader?.();
      }
    } catch (error) {
      if (signal?.aborted) return false;
      await onHeaderError(error);
    }
    if (signal?.aborted) return false;
    await startPlayback?.();
    return true;
  }
  if (signal?.aborted) return false;
  await startPlayback?.();
  void Promise.resolve().then(() => drawHeader?.()).catch(onHeaderError);
  return true;
}

const PROGRESS_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

export function playbackProgressSegments(ratio, width) {
  const cells = Math.max(1, Math.floor(Number(width) || 1));
  const eighths = Math.round(clamp(Number(ratio) || 0, 0, 1) * cells * 8);
  const fullCells = Math.floor(eighths / 8);
  const partial = PROGRESS_BLOCKS[eighths % 8];
  const unplayedCells = Math.max(0, cells - fullCells - (partial ? 1 : 0));
  return {
    played: '█'.repeat(fullCells),
    partial,
    unplayed: ' '.repeat(unplayedCells)
  };
}

export function playbackPlaylistOverlayRows({
  playlist,
  selectedIndex = 0,
  currentIndex = 0,
  availableRows = 0,
  columns = 80
} = {}) {
  const capacity = Math.max(0, Math.floor(Number(availableRows) || 0));
  const width = Math.max(1, Math.floor(Number(columns) || 1));
  if (!capacity) return [];
  const title = chalk.cyanBright.bold(truncateText(`歌单：${playlist?.name || '当前播放队列'}`, width));
  // 极矮窗口优先保留可操作的选中歌曲；空间足够时再加入标题及其上方空行。
  const headerRows = capacity >= 3 ? ['', title] : capacity >= 2 ? [title] : [];
  const viewport = playlistViewport(
    playlist?.tracks,
    selectedIndex,
    currentIndex,
    Math.max(0, capacity - headerRows.length)
  );
  const trackRows = viewport.rows.map((item) => {
    const prefix = item.selected ? '› ' : '  ';
    const text = truncateText(`${prefix}${playlistTrackText(item.track, item.index)}`, width);
    if (item.selected) return chalk.bgWhite.black(text);
    return item.current ? chalk.whiteBright.bold(text) : secondaryText(text);
  });
  return [
    ...headerRows,
    ...trackRows,
    ...Array(Math.max(0, capacity - headerRows.length - trackRows.length)).fill('')
  ];
}

export function shouldSyncPlayerPosition(localMs, playerSeconds, thresholdMs = 750) {
  const remoteMs = Number(playerSeconds) * 1000;
  return Number.isFinite(remoteMs) && remoteMs >= 0
    && Math.abs(remoteMs - Number(localMs || 0)) >= Math.max(0, thresholdMs);
}

async function waitForExit(child, timeoutMs = 1500) {
  if (hasProcessExited(child)) return;
  await Promise.race([
    once(child, 'exit').catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

export async function terminatePlayer(child) {
  if (hasProcessExited(child)) return;
  if (process.platform === 'win32' && child.pid) {
    // 大多数播放器可由 TerminateProcess 立即结束；先走快速路径，避免每次按键
    // 都等待额外 taskkill 进程启动。仅在播放器仍未退出时清理进程树。
    try { child.kill(); } catch {}
    await waitForExit(child, 75);
    if (hasProcessExited(child)) return;
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit').catch(() => {});
    if (!hasProcessExited(child)) child.kill();
    await waitForExit(child);
    return;
  }
  child.kill('SIGTERM');
  await waitForExit(child, 1000);
  if (!hasProcessExited(child)) {
    child.kill('SIGKILL');
    await waitForExit(child, 500);
  }
}

function setupRawInput(rl, onData) {
  const stream = process.stdin;
  if (!process.stdin.isTTY || typeof stream.setRawMode !== 'function') return () => {};
  const wasRaw = Boolean(stream.isRaw);
  const wasPaused = stream.isPaused();
  const previousDataListeners = stream.listeners('data');
  let attached = false;
  try {
    rl?.pause();
    for (const listener of previousDataListeners) stream.removeListener('data', listener);
    stream.on('data', onData);
    attached = true;
    stream.setRawMode(true);
    stream.resume();
  } catch (error) {
    if (attached) stream.removeListener('data', onData);
    for (const listener of previousDataListeners) stream.on('data', listener);
    try { stream.setRawMode(wasRaw); } catch {}
    if (!wasPaused) {
      try { stream.resume(); } catch {}
      try { rl?.resume(); } catch {}
    }
    throw error;
  }
  return () => {
    stream.pause();
    stream.removeListener('data', onData);
    for (const listener of previousDataListeners) stream.on('data', listener);
    stream.setRawMode(wasRaw);
    try { rl?.write(null, { ctrl: true, name: 'u' }); } catch {}
    if (!wasPaused) {
      stream.resume();
      rl?.resume();
    }
  };
}

function playlistTrackText(track, index) {
  const title = track?.name ?? track?.title ?? `歌曲 ${index + 1}`;
  const artists = Array.isArray(track?.artists) ? track.artists.join('/') : track?.artist;
  return `${index + 1}. ${title}${artists ? ` - ${artists}` : ''}`;
}

export function playbackDynamicRows({ progress, modeRows, shortcutRows, indicatorRow, contentRows, availableRows = Infinity }) {
  const controls = [indicatorRow, progress, ...modeRows, ...shortcutRows];
  if (!Number.isFinite(availableRows)) return [...contentRows, ...controls];
  const capacity = Math.max(0, Math.floor(Number(availableRows) || 0));
  const visibleControls = controls.slice(0, capacity);
  const contentCapacity = Math.max(0, capacity - visibleControls.length);
  const visibleContent = contentRows.slice(0, contentCapacity);
  const padding = Array(Math.max(0, contentCapacity - visibleContent.length)).fill('');
  return [...visibleContent, ...padding, ...visibleControls];
}

export function planPlaybackVerticalLayout({
  rows,
  coverRows = 0,
  metadataRows = 0,
  metadataSpacerRows = 0,
  futureLyricRows = 0,
  modeRows = 0,
  shortcutRows = 0,
  statusRows = 0,
  currentLyricRows = 1,
  progressRows = 1
} = {}) {
  const capacity = Math.max(0, Math.floor(Number(rows) || 0));
  const visible = {
    coverRows: Math.max(0, Math.floor(Number(coverRows) || 0)),
    metadataRows: Math.max(0, Math.floor(Number(metadataRows) || 0)),
    metadataSpacerRows: Math.max(0, Math.floor(Number(metadataSpacerRows) || 0)),
    futureLyricRows: Math.max(0, Math.floor(Number(futureLyricRows) || 0)),
    modeRows: Math.max(0, Math.floor(Number(modeRows) || 0)),
    shortcutRows: Math.max(0, Math.floor(Number(shortcutRows) || 0)),
    statusRows: Math.max(0, Math.floor(Number(statusRows) || 0)),
    currentLyricRows: Math.max(0, Math.floor(Number(currentLyricRows) || 0)),
    progressRows: Math.max(0, Math.floor(Number(progressRows) || 0)),
    compactRequired: false
  };
  const used = () => visible.coverRows + visible.metadataRows + visible.metadataSpacerRows + visible.futureLyricRows
    + visible.modeRows + visible.shortcutRows + visible.statusRows
    + visible.currentLyricRows + visible.progressRows;
  let overflow = Math.max(0, used() - capacity);
  const removeRows = (key, maximum = visible[key]) => {
    const removed = Math.min(overflow, visible[key], maximum);
    visible[key] -= removed;
    overflow -= removed;
  };
  // 先把未来歌词压到两行；歌曲信息仍存在时，其下方留白不可提前挤掉。
  removeRows('futureLyricRows', Math.max(0, visible.futureLyricRows - 2));
  removeRows('metadataRows', Math.max(0, visible.metadataRows - 1));
  // 封面可以逐行缩小，但绝不显示低于七行的残缺图像。
  removeRows('coverRows', Math.max(0, visible.coverRows - 7));
  if (overflow > 0 && visible.coverRows > 0) {
    overflow = Math.max(0, overflow - visible.coverRows);
    visible.coverRows = 0;
  }
  if (overflow > 0 && visible.metadataRows > 0) {
    const headerRemainder = visible.metadataRows + visible.metadataSpacerRows;
    overflow = Math.max(0, overflow - headerRemainder);
    visible.metadataRows = 0;
    visible.metadataSpacerRows = 0;
  }
  removeRows('futureLyricRows');
  if (overflow > 0 && visible.modeRows > 0) {
    overflow = Math.max(0, overflow - visible.modeRows);
    visible.modeRows = 0;
  }
  if (overflow > 0 && visible.shortcutRows > 0) {
    overflow = Math.max(0, overflow - visible.shortcutRows);
    visible.shortcutRows = 0;
  }
  removeRows('statusRows');
  if (overflow > 0) removeRows('currentLyricRows');
  if (overflow > 0) removeRows('progressRows');
  return Object.freeze({ ...visible, capacity, unusedRows: Math.max(0, capacity - (used() - (visible.compactRequired ? 1 : 0))) });
}

export function playbackCoverRowBudget(rows) {
  const height = Math.max(0, Math.floor(Number(rows) || 0));
  return height > 1 ? Math.max(7, Math.min(20, Math.floor(height * 0.36))) : 0;
}

export function compactPlaybackRequiredRow(currentLyric, progress, columns) {
  const width = Math.max(1, Math.floor(Number(columns) || 1));
  if (width === 1) return truncateText(currentLyric || progress, 1);
  const lyricWidth = Math.max(1, Math.floor((width - 1) / 2));
  const lyric = truncateText(currentLyric, lyricWidth);
  const remaining = Math.max(1, width - stringWidth(lyric) - (width > 2 ? 1 : 0));
  const separator = width > 2 ? ' ' : '';
  return `${lyric}${separator}${truncateText(progress, remaining)}`;
}

export function playbackPrioritizedRows({
  progress,
  modeRows = [],
  shortcutRows = [],
  indicatorRow = '',
  requiredContentRows = [],
  optionalPrefixRows = [],
  optionalSuffixRows = [],
  availableRows = Infinity,
  columns = 80,
  paused = false,
  replacePausedContent = false,
  compactPausedRow = '',
  layout: plannedLayout = null
} = {}) {
  if (!Number.isFinite(availableRows)) {
    return [
      ...optionalPrefixRows, ...requiredContentRows, ...optionalSuffixRows,
      indicatorRow, progress, ...modeRows, ...shortcutRows
    ];
  }
  const capacity = Math.max(0, Math.floor(Number(availableRows) || 0));
  const layout = plannedLayout ?? planPlaybackVerticalLayout({
    rows: capacity,
    futureLyricRows: optionalPrefixRows.length + optionalSuffixRows.length,
    modeRows: modeRows.length,
    shortcutRows: shortcutRows.length,
    statusRows: 1,
    currentLyricRows: requiredContentRows.length ? 1 : 0,
    progressRows: 1
  });
  const visibleRequiredContentRows = paused && replacePausedContent && compactPausedRow
    ? [compactPausedRow]
    : requiredContentRows;
  const prefixCount = plannedLayout
    ? Math.min(optionalPrefixRows.length, layout.metadataSpacerRows ?? 0)
    : Math.min(optionalPrefixRows.length, layout.futureLyricRows);
  const suffixCount = Math.min(
    optionalSuffixRows.length,
    Math.max(0, layout.futureLyricRows - (plannedLayout ? 0 : prefixCount))
  );
  const content = [
    ...optionalPrefixRows.slice(0, prefixCount),
    ...visibleRequiredContentRows.slice(0, layout.currentLyricRows),
    ...optionalSuffixRows.slice(0, suffixCount)
  ];
  const visibleControls = [
    ...(layout.statusRows ? [indicatorRow] : []),
    ...(layout.progressRows ? [progress] : []),
    ...modeRows.slice(0, layout.modeRows),
    ...shortcutRows.slice(0, layout.shortcutRows)
  ];
  // 以动态区域的实际剩余高度补齐，而不是只依赖整屏布局快照。
  // 封面文本的实际行数可能与预估相差一行；只显示当前歌词时没有未来歌词
  // 吸收这段差额，若不在这里补齐，底部控制区会整体上浮。
  const padding = Array(Math.max(0, capacity - content.length - visibleControls.length)).fill('');
  return [
    ...content,
    ...padding,
    ...visibleControls
  ];
}

export function playbackRowsWithTopSpacer(rows, capacity) {
  const limit = Math.max(0, Math.floor(Number(capacity) || 0));
  if (limit <= 1) return rows.slice(0, limit);
  return ['', ...rows].slice(0, limit);
}

function renderDynamic({
  elapsedMs,
  lyricElapsedMs,
  durationMs,
  paused,
  lyrics,
  dynamicRow,
  dynamicAnchored,
  showTranslation,
  showRomanized = false,
  indicator,
  playlist,
  playlistOpen,
  playlistSelection,
  playbackModeText,
  currentLyricOnly = false,
  easterEgg = null,
  canFavorite = false,
  favorited = false,
  translationMode = 'off',
  canToggleTranslation = true,
  replacePausedContent = false,
  compactPausedRow = '',
  compactPausedArtist = '',
  verticalLayout = null,
  captureOnly = false,
  writeOutput = (output) => process.stdout.write(output)
}) {
  const columns = Math.max(1, process.stdout.columns || 80);
  const rows = Math.max(1, process.stdout.rows || 24);
  const startRow = clamp(dynamicRow, 1, rows);
  const availableRows = rows - startRow + 1;
  const timeText = `${formatTime(elapsedMs)} / ${formatTime(durationMs)}`;
  const barWidth = clamp(columns - stringWidth(timeText) - 3, 1, 50);
  const ratio = durationMs ? clamp(elapsedMs / durationMs, 0, 1) : 0;
  const segments = playbackProgressSegments(ratio, barWidth);
  const partial = segments.partial
    ? secondaryBackground(primaryText(segments.partial))
    : '';
  const bar = `${primaryText(segments.played)}${partial}${secondaryBackground(segments.unplayed)}`;
  const progress = playbackProgressText({
    bar,
    timeText,
    paused,
    columns
  });
  const modeRows = playbackModeText
    ? playbackPlaylistModeRows({
        randomLabel: playbackModeText.randomLabel,
        loopLabel: playbackModeText.loopLabel,
        playlistOpen: playbackModeText.playlistOpen
      }, columns).map((row) => chalk.magentaBright(row))
    : [];
  const shortcutRows = playbackShortcutRows({ canFavorite, favorited, canToggleTranslation }, columns).map((row) => {
    const label = translationMode === 'off'
      ? chalk.gray('译/音')
      : translationMode === 'translated'
        ? `${chalk.cyanBright('译')}${chalk.gray('/音')}`
        : `${chalk.gray('译/')}\x1b[1m${chalk.cyanBright('音')}`;
    return chalk.cyanBright(row.replace('t 译/音', `t ${label}`));
  });
  if (playlistOpen) {
    const outputRows = playbackPlaylistOverlayRows({
      playlist,
      selectedIndex: playlistSelection,
      currentIndex: playlist?.currentIndex,
      availableRows,
      columns
    });
    const position = dynamicAnchored ? '\x1b[u' : `\x1b[${startRow};1H`;
    if (captureOnly) return outputRows;
    writeOutput(`${position}\x1b[0J${outputRows.join('\n')}`);
    return;
  }
  let requiredContentRows = [];
  let optionalPrefixRows = [];
  let optionalSuffixRows = [];
  if (easterEgg?.mode === 'credits-csf' && creditsEasterEggShowsFrame(easterEgg)) {
    // 原始 CSF 使用终端默认色，不对上游分镜追加自定义样式。
    const frameRows = creditsEasterEggFrame(easterEgg.frameElapsedMs, columns, rows);
    requiredContentRows = frameRows.slice(0, 1);
    optionalSuffixRows = frameRows.slice(1);
  } else {
    const displayLyrics = showRomanized
      ? lyrics.map((line) => ({ ...line, translation: line.romanized || '' }))
      : lyrics;
    const displayRows = playbackLyricRows(
      displayLyrics, lyricElapsedMs, rows, showTranslation || showRomanized, columns, currentLyricOnly
    );
    const lyricRows = displayRows.length
      ? displayRows.map((line) => {
          const text = truncateText(line.text, columns);
          const tone = lyricTone(line);
          const rendered = tone === 'future'
            ? secondaryText(text)
            : line.translation
              ? tone === 'current' ? chalk.cyan(text) : chalk.white.dim(text)
              : tone === 'current' ? primaryText(text) : chalk.white(text);
          return { line, tone, rendered };
        })
      : [{ line: null, tone: 'current', rendered: currentLyricOnly ? '' : secondaryText(truncateText('暂无逐行歌词', columns)) }];
    const current = lyricRows.find((item) => item.tone === 'current' && !item.line?.translation) ?? lyricRows[0];
    requiredContentRows = [current.rendered];
    optionalPrefixRows = [''];
    optionalSuffixRows = lyricRows.filter((item) => item !== current).map((item) => item.rendered);
  }
  const outputRows = playbackPrioritizedRows({
    progress,
    modeRows,
    shortcutRows,
    indicatorRow: indicator ? chalk.yellow(truncateText(indicator, columns)) : '',
    requiredContentRows,
    optionalPrefixRows,
    optionalSuffixRows,
    availableRows,
    columns,
    paused,
    replacePausedContent,
    compactPausedRow: chalk.bold(compactSongArtistText(
      compactPausedRow, compactPausedArtist || '未知', columns
    )),
    layout: verticalLayout
  });
  const position = dynamicAnchored ? '\x1b[u' : `\x1b[${startRow};1H`;
  if (captureOnly) return outputRows;
  writeOutput(`${position}\x1b[0J${outputRows.join('\n')}`);
}

function imageBufferFromDataUri(source) {
  if (typeof source !== 'string') return null;
  const match = source.match(/^data:image\/[^;,]+;base64,(.+)$/i);
  return match ? Buffer.from(match[1], 'base64') : null;
}

async function loadImage(source, signal, { imageCacheMaxBytes, logger, imageIdentity } = {}) {
  const inline = imageBufferFromDataUri(source);
  if (inline) return inline;
  return loadCachedImage(source, {
    signal, maxBytes: imageCacheMaxBytes, logger, identity: imageIdentity
  });
}

export function isTermuxEnvironment(env = process.env) {
  return Boolean(env.TERMUX_VERSION
    || /(?:^|\/)com\.termux(?:\/|$)/i.test(env.PREFIX || '')
    || /^termux$/i.test(env.TERM_PROGRAM || ''));
}

export function ansiImageLimits(maxWidth, maxRows, compactColor = false) {
  const width = Math.max(1, Math.floor(Number(maxWidth) || 1));
  const rows = Math.max(1, Math.floor(Number(maxRows) || 1));
  return compactColor
    ? { width: Math.min(32, width), rows: Math.min(12, rows), compactColor: true }
    : { width, rows, compactColor: false };
}

function rgbToAnsi256({ r, g, b }) {
  const level = (value) => Math.max(0, Math.min(5, Math.round(value / 51)));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

async function renderAnsiBlocks(buffer, maxWidth, maxRows, { compactColor = false } = {}) {
  const { Jimp, intToRGBA } = await import('jimp');
  const image = await Jimp.read(buffer);
  const limits = ansiImageLimits(maxWidth, maxRows, compactColor);
  const scale = Math.min(limits.width / image.bitmap.width, (limits.rows * 2) / image.bitmap.height);
  const width = Math.max(1, Math.round(image.bitmap.width * scale));
  const pixelHeight = Math.max(2, Math.round(image.bitmap.height * scale));
  image.resize({ w: width, h: pixelHeight });
  const composite = ({ r, g, b, a }) => {
    const alpha = a / 255;
    const base = 24;
    return {
      r: Math.round(r * alpha + base * (1 - alpha)),
      g: Math.round(g * alpha + base * (1 - alpha)),
      b: Math.round(b * alpha + base * (1 - alpha))
    };
  };
  const rows = [];
  for (let y = 0; y < pixelHeight; y += 2) {
    let row = '';
    for (let x = 0; x < width; x += 1) {
      const top = intToRGBA(image.getPixelColor(x, y));
      const bottom = intToRGBA(image.getPixelColor(x, Math.min(y + 1, pixelHeight - 1)));
      const topColor = composite(top);
      const bottomColor = composite(bottom);
      row += limits.compactColor
        ? `\x1b[38;5;${rgbToAnsi256(topColor)};48;5;${rgbToAnsi256(bottomColor)}m▀`
        : `\x1b[38;2;${topColor.r};${topColor.g};${topColor.b};48;2;${bottomColor.r};${bottomColor.g};${bottomColor.b}m▀`;
    }
    rows.push(`${row}\x1b[0m`);
  }
  return rows.join('\n');
}

function songArtistsText(song) {
  const artists = Array.isArray(song?.artists) ? song.artists.join('/') : song?.artist;
  return artists || '未知';
}

function compactSongArtistText(title, artist, columns) {
  const width = Math.max(1, Math.floor(Number(columns) || 1));
  const separator = ' - ';
  const full = `${title}${separator}${artist}`;
  if (stringWidth(full) <= width || width <= stringWidth(separator) + 2) {
    return truncateText(full, width);
  }
  const contentWidth = width - stringWidth(separator);
  // 优先完整保留歌名；空间不够时先把歌手压缩到最小标记。
  const minimumArtistWidth = Math.min(1, stringWidth(artist));
  const titleWidth = Math.min(stringWidth(title), Math.max(1, contentWidth - minimumArtistWidth));
  const artistWidth = Math.max(1, contentWidth - titleWidth);
  return `${truncateText(title, titleWidth)}${separator}${truncateText(artist, artistWidth)}`;
}

export function playbackMetadataRows(song, backendLabel, columns, visibleRows = Infinity) {
  const artists = songArtistsText(song);
  const title = song.name || song.title || '';
  const rows = [
    chalk.bold(truncateText(title, columns)),
    truncateText(`歌手：${artists}`, columns),
    truncateText(`专辑：${song.album || '未知'}`, columns),
    truncateText(`播放器：${backendLabel}`, columns),
    truncateText(`ID：${song.id ?? ''}`, columns)
  ];
  if (!Number.isFinite(visibleRows)) return rows;
  const count = Math.max(0, Math.floor(Number(visibleRows) || 0));
  if (count === 1) {
    return [chalk.bold(compactSongArtistText(title, artists, columns))];
  }
  return rows.slice(0, count);
}

async function buildTextPlaybackHeaderRows(song, {
  signal, columns, layout, protocol = 'ansi', imageCacheMaxBytes, logger,
  preloadedBuffer = null
}) {
  const coverRows = [];
  let coverBuffer = null;
  if (song.cover && layout.coverRows > 0) {
    try {
      coverBuffer = preloadedBuffer
        ?? await loadImage(song.cover, signal, {
          imageCacheMaxBytes, logger, imageIdentity: { type: 'track-cover', id: song.id }
        });
      const width = Math.max(1, Math.min(52, columns - 2));
      const text = await renderAnsiBlocks(coverBuffer, width, layout.coverRows, {
        compactColor: protocol === 'ansi256'
      });
      coverRows.push(...text.split(/\r?\n/));
    } catch { coverBuffer = null; }
  }
  return { coverRows, coverBuffer };
}

function writeCreditsTransitionRows(entries, writeOutput = (output) => process.stdout.write(output)) {
  const output = entries.map(({ state, text }) => {
    const rendered = state === 'flash-target'
      ? chalk.inverse(chalk.whiteBright(text))
      : state === 'target-preview' ? chalk.whiteBright(text) : text;
    return `${rendered}\x1b[0m\x1b[K`;
  }).join('\n');
  writeOutput(`\x1b[H${output}`);

}

function refreshCreditsTargetPage(rows, rowCount) {
  const height = Math.max(1, Math.ceil(Number(rowCount) || 1));
  const stableRows = Array.from({ length: height }, (_, index) => rows[index] ?? '');
  const output = stableRows.map((row) => `${row}\x1b[0m\x1b[K`).join('\n');
  process.stdout.write(`\x1b[2J\x1b[H${output}\x1b[H`);
}

function writeCreditsPageRevealRows(entries) {
  const output = entries.map(({ index, state, text }) => {
    const rendered = state === 'flash-target'
      ? chalk.inverse(chalk.whiteBright(text))
      : state === 'target-preview' ? chalk.whiteBright(text) : text;
    return `\x1b[${index + 1};1H${rendered}\x1b[0m\x1b[K`;
  }).join('');
  process.stdout.write(output);
}
function writeTerminalOutput(output) {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
  });
}

function mediaLog(logger, level, event, data = {}) {
  try { void logger?.[level]?.(event, data); } catch {}
}

export function sixelCursorBox(output, height) {
  const rows = Math.max(1, Math.floor(Number(height) || 1));
  const payload = Buffer.isBuffer(output) ? output : Buffer.from(output);
  return Buffer.concat([
    Buffer.from('\x1b7'),
    payload,
    Buffer.from(`\x1b8\x1b[${rows}E`)
  ]);
}

export function createLatestTerminalWriter(stream, {
  onDiagnostic = () => {},
  now = Date.now,
  diagnosticThresholdMs = 250
} = {}) {
  let writing = false;
  let waitingDrain = false;
  let pending = null;
  let closed = false;
  let episode = null;
  const totals = {
    writeCount: 0,
    outputBytes: 0,
    queuedFrames: 0,
    droppedFrames: 0,
    backpressureCount: 0,
    maxFrameBytes: 0,
    maxBlockedDurationMs: 0
  };

  const notify = (diagnostic) => {
    try { onDiagnostic(diagnostic); } catch {}
  };
  const frameBytes = (output) => Buffer.isBuffer(output)
    ? output.length
    : Buffer.byteLength(String(output));
  const beginEpisode = (reason, bytes) => {
    if (!episode) {
      episode = {
        startedAt: now(), reason, queuedFrames: 0, droppedFrames: 0,
        maxFrameBytes: bytes
      };
    } else {
      episode.maxFrameBytes = Math.max(episode.maxFrameBytes, bytes);
    }
  };
  const completeEpisode = (closedWhileBlocked = false) => {
    if (!episode || (!closedWhileBlocked && (writing || waitingDrain || pending !== null))) return;
    const durationMs = Math.max(0, now() - episode.startedAt);
    totals.maxBlockedDurationMs = Math.max(totals.maxBlockedDurationMs, durationMs);
    if (durationMs >= diagnosticThresholdMs || episode.droppedFrames > 0) {
      notify({
        type: 'backpressure', durationMs, reason: episode.reason,
        queuedFrames: episode.queuedFrames, droppedFrames: episode.droppedFrames,
        maxFrameBytes: episode.maxFrameBytes, closedWhileBlocked
      });
    }
    episode = null;
  };

  const flushPending = () => {
    if (closed || writing || waitingDrain || pending === null) return;
    const output = pending;
    pending = null;
    write(output);
  };
  const onDrain = () => {
    waitingDrain = false;
    flushPending();
    completeEpisode();
  };
  const onWritten = () => {
    writing = false;
    flushPending();
    completeEpisode();
  };
  const write = (output) => {
    if (closed) return false;
    const bytes = frameBytes(output);
    totals.maxFrameBytes = Math.max(totals.maxFrameBytes, bytes);
    if (writing || waitingDrain) {
      beginEpisode(waitingDrain ? 'stdout_backpressure' : 'write_in_flight', bytes);
      totals.queuedFrames += 1;
      episode.queuedFrames += 1;
      if (pending !== null) {
        totals.droppedFrames += 1;
        episode.droppedFrames += 1;
      }
      pending = output;
      return false;
    }
    writing = true;
    totals.writeCount += 1;
    totals.outputBytes += bytes;
    const accepted = stream.write(output, onWritten);
    if (!accepted) {
      beginEpisode('stdout_backpressure', bytes);
      totals.backpressureCount += 1;
      waitingDrain = true;
      stream.once('drain', onDrain);
    }
    return accepted;
  };
  return Object.freeze({
    write,
    dropPending() { pending = null; },
    close() {
      closed = true;
      pending = null;
      stream.removeListener('drain', onDrain);
      completeEpisode(true);
      notify({ type: 'summary', ...totals });
    },
    get blocked() { return writing || waitingDrain; }
  });
}

async function tryNativeGraphics(buffer, width, height, protocol) {
  const kitty = supportsTerminalGraphics.stdout.kitty && process.env.TERM_PROGRAM !== 'iTerm.app';
  const iterm2 = supportsTerminalGraphics.stdout.iterm2;
  if ((protocol === 'kitty' && !kitty) || (protocol === 'iterm2' && !iterm2)) return false;
  const { default: terminalImage } = await import('terminal-image');
  const text = await terminalImage.buffer(buffer, { width, height, preserveAspectRatio: true });
  const usedNativeProtocol = (protocol === 'kitty' && text === '')
    || (protocol === 'iterm2' && typeof text === 'string' && text.includes('\x1b]1337;File='));
  if (!usedNativeProtocol) return false;
  if (text) await writeTerminalOutput(text);
  // Kitty/iTerm 图像本身不会可靠地下移文本光标，显式预留单元格行。
  await writeTerminalOutput('\n'.repeat(height));
  return true;
}

export async function tryRenderImage(source, {
  signal, size = 'detail', shouldRender, protocol = 'auto', maxRows, onTextRows,
  allowNativeGraphics = false, preloadedBuffer = null, logger = null,
  diagnosticContext = 'unknown', imageCacheMaxBytes,
  deferLoad = false, onDeferredReady = null, imageIdentity = null
} = {}) {
  const renderStartedAt = Date.now();
  const common = { context: diagnosticContext, size, requestedProtocol: protocol };
  const finish = (resultRows, status, data = {}) => {
    mediaLog(logger, 'info', 'image_render_completed', {
      ...common, status, resultRows, durationMs: Date.now() - renderStartedAt, ...data
    });
    return resultRows;
  };
  if (!source && !preloadedBuffer) return finish(0, 'skipped', { reason: 'no_source' });
  if (!process.stdout.isTTY) return finish(0, 'skipped', { reason: 'not_tty' });
  if (protocol === 'none') return finish(0, 'skipped', { reason: 'disabled' });
  const guarded = typeof shouldRender === 'function';
  const current = () => !signal?.aborted && (!guarded || shouldRender());
  const columns = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const width = Math.max(1, Math.min(size === 'playback' ? 52 : 56, columns - 2));
  const plannedRows = Number.isFinite(Number(maxRows))
    ? Math.max(1, Math.floor(Number(maxRows)))
    : Math.max(1, rows - 8);
  const height = size === 'playback'
    ? Math.max(1, Math.min(20, plannedRows))
    : Math.max(1, Math.min(22, Math.floor(rows * 0.36), plannedRows));
  mediaLog(logger, 'info', 'image_render_started', {
    ...common,
    preloaded: Boolean(preloadedBuffer),
    terminalRows: process.stdout.rows || 24,
    terminalColumns: process.stdout.columns || 80,
    termux: isTermuxEnvironment()
  });
  try {
    const immediateBuffer = preloadedBuffer
      ?? imageBufferFromDataUri(source)
      ?? peekCachedImage(source, { identity: imageIdentity });
    if (deferLoad && !immediateBuffer && typeof onDeferredReady === 'function') {
      void loadImage(source, signal, { imageCacheMaxBytes, logger, imageIdentity }).then((buffer) => {
        if (current()) onDeferredReady(buffer);
      }).catch((error) => {
        if (error?.name !== 'AbortError') {
          mediaLog(logger, 'warn', 'image_deferred_load_failed', { ...common, error });
        }
      });
      await writeTerminalOutput('\n'.repeat(height));
      return finish(height, 'deferred', { width, height });
    }
    const loadStartedAt = Date.now();
    const buffer = immediateBuffer
      ?? await loadImage(source, signal, { imageCacheMaxBytes, logger, imageIdentity });
    mediaLog(logger, 'info', 'image_source_loaded', {
      ...common, durationMs: Date.now() - loadStartedAt, bytes: buffer.length,
      preloaded: Boolean(preloadedBuffer)
    });
    if (!current()) return finish(0, 'cancelled', { stage: 'source_loaded' });
    if (typeof onTextRows === 'function') {
      const snapshotStartedAt = Date.now();
      try {
        const text = await renderAnsiBlocks(buffer, width, height, {
          compactColor: protocol === 'ansi256'
        });
        const snapshotRows = text.split(/\r?\n/);
        if (current()) onTextRows(snapshotRows);
        mediaLog(logger, 'info', 'image_text_snapshot_completed', {
          ...common, status: current() ? 'success' : 'cancelled',
          durationMs: Date.now() - snapshotStartedAt,
          outputBytes: Buffer.byteLength(text), resultRows: snapshotRows.length
        });
      } catch (error) {
        mediaLog(logger, 'warn', 'image_text_snapshot_completed', {
          ...common, status: 'failed', durationMs: Date.now() - snapshotStartedAt, error
        });
      }
    }
    const hasChafa = commandExists('chafa');
    const protocols = imageProtocolOrder({
      preference: protocol,
      kitty: supportsTerminalGraphics.stdout.kitty && process.env.TERM_PROGRAM !== 'iTerm.app',
      iterm2: supportsTerminalGraphics.stdout.iterm2,
      sixel: supportsSixelEnvironment(),
      chafa: hasChafa
    });

    mediaLog(logger, 'info', 'image_protocol_candidates', { ...common, protocols, width, height });

    for (const selectedProtocol of protocols) {
      if (!current()) return finish(0, 'cancelled', { stage: 'protocol_selection' });
      const attemptStartedAt = Date.now();
      if (selectedProtocol === 'kitty' || selectedProtocol === 'iterm2') {
        // terminal-image 的 Kitty 路径可能在 Promise 返回前直接写 stdout，
        // 无法为连续切歌做 generation 校验；可取消的后台封面任务跳过该路径。
        if (guarded && !allowNativeGraphics) {
          mediaLog(logger, 'info', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'skipped', reason: 'guarded_native_graphics',
            durationMs: Date.now() - attemptStartedAt
          });
          continue;
        }
        try {
          const success = await tryNativeGraphics(buffer, width, height, selectedProtocol);
          mediaLog(logger, 'info', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: success ? 'success' : 'unsupported',
            durationMs: Date.now() - attemptStartedAt, resultRows: success ? height : 0
          });
          if (success) return finish(height, 'success', { selectedProtocol, width, height });
        } catch (error) {
          mediaLog(logger, 'warn', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'failed',
            durationMs: Date.now() - attemptStartedAt, error
          });
        }
      }

      if (selectedProtocol === 'sixel') {
        try {
          const encodeStartedAt = Date.now();
          const rendered = spawnSync('chafa', ['--format=sixels', `--size=${width}x${height}`, '-'], {
            input: buffer,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024
          });
          const encodeMs = Date.now() - encodeStartedAt;
          if (rendered.status === 0 && rendered.stdout?.includes(Buffer.from('\x1bP'))) {
            if (!current()) return finish(0, 'cancelled', { stage: 'sixel_encoded' });
            // chafa 1.14 等版本只输出 SIXEL DCS，且各终端在 DCS 结束后的
            // 光标位置并不一致。恢复到图片起点后按布局高度显式定位，确保
            // 详情页、播放器的行预算与真实文本光标始终一致。
            const output = sixelCursorBox(rendered.stdout, height);
            const writeStartedAt = Date.now();
            await writeTerminalOutput(output);
            const writeMs = Date.now() - writeStartedAt;
            mediaLog(logger, 'info', 'image_protocol_attempt_completed', {
              ...common, selectedProtocol, status: 'success', encodeMs, writeMs,
              durationMs: Date.now() - attemptStartedAt, outputBytes: output.length,
              resultRows: height
            });
            return finish(height, 'success', { selectedProtocol, width, height, encodeMs, writeMs });
          }
          mediaLog(logger, 'warn', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'failed', encodeMs,
            durationMs: Date.now() - attemptStartedAt, exitStatus: rendered.status,
            outputBytes: rendered.stdout?.length || 0
          });
        } catch (error) {
          mediaLog(logger, 'warn', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'failed',
            durationMs: Date.now() - attemptStartedAt, error
          });
        }
      }

      if (selectedProtocol === 'symbols') {
        try {
          const encodeStartedAt = Date.now();
          const rendered = spawnSync('chafa', ['--format=symbols', `--size=${width}x${height}`, '-'], {
            input: buffer,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024
          });
          const encodeMs = Date.now() - encodeStartedAt;
          if (rendered.status === 0 && rendered.stdout?.trim()) {
            const text = rendered.stdout.replace(/\s+$/, '');
            if (!current()) return finish(0, 'cancelled', { stage: 'symbols_encoded' });
            const output = `${text}\n`;
            const writeStartedAt = Date.now();
            await writeTerminalOutput(output);
            const writeMs = Date.now() - writeStartedAt;
            const resultRows = text.split(/\r?\n/).length;
            mediaLog(logger, 'info', 'image_protocol_attempt_completed', {
              ...common, selectedProtocol, status: 'success', encodeMs, writeMs,
              durationMs: Date.now() - attemptStartedAt,
              outputBytes: Buffer.byteLength(output), resultRows
            });
            return finish(resultRows, 'success', { selectedProtocol, width, height, encodeMs, writeMs });
          }
          mediaLog(logger, 'warn', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'failed', encodeMs,
            durationMs: Date.now() - attemptStartedAt, exitStatus: rendered.status,
            outputBytes: Buffer.byteLength(rendered.stdout || '')
          });
        } catch (error) {
          mediaLog(logger, 'warn', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'failed',
            durationMs: Date.now() - attemptStartedAt, error
          });
        }
      }

      if (selectedProtocol === 'ansi' || selectedProtocol === 'ansi256') {
        try {
          const encodeStartedAt = Date.now();
          const text = await renderAnsiBlocks(buffer, width, height, {
            compactColor: selectedProtocol === 'ansi256'
          });
          const encodeMs = Date.now() - encodeStartedAt;
          if (!current()) return finish(0, 'cancelled', { stage: 'ansi_encoded' });
          const output = `${text}\n`;
          const writeStartedAt = Date.now();
          await writeTerminalOutput(output);
          const writeMs = Date.now() - writeStartedAt;
          const resultRows = text.split(/\r?\n/).length;
          mediaLog(logger, 'info', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'success', encodeMs, writeMs,
            durationMs: Date.now() - attemptStartedAt,
            outputBytes: Buffer.byteLength(output), resultRows
          });
          return finish(resultRows, 'success', { selectedProtocol, width, height, encodeMs, writeMs });
        } catch (error) {
          mediaLog(logger, 'warn', 'image_protocol_attempt_completed', {
            ...common, selectedProtocol, status: 'failed',
            durationMs: Date.now() - attemptStartedAt, error
          });
        }
      }
    }
    return finish(0, 'unsupported', { protocols, width, height });
  } catch (error) {
    mediaLog(logger, 'warn', 'image_render_failed', {
      ...common, durationMs: Date.now() - renderStartedAt, error
    });
    return finish(0, signal?.aborted ? 'cancelled' : 'failed');
  }
}

export async function playWithProgress({
  song,
  url,
  durationMs,
  lyricSource = '',
  translatedLyricSource = '',
  romanizedLyricSource = '',
  lyricOffsetMs = 0,
  smtcOffsetMs = 0,
  playerBackend = 'auto',
  imageProtocol = 'auto',
  imageCacheMaxBytes = 100 * 1024 * 1024,
  playlist = { name: '', tracks: [], currentIndex: 0 },
  signal,
  logger,
  rl,
  onInterrupt,
  onTrackChange,
  onFavorite,
  favorited = false,
  returnPageRows = []
}) {
  let releaseScreen = () => {};
  await closeRetainedSmtc();
  let player = findPlayer(playerCommandsForBackend(playerBackend));
  if (!player) throw new Error('未找到播放器。请安装 ffplay、mpv 或 VLC 后重试。');
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const dynamicWriter = tty ? createLatestTerminalWriter(process.stdout, {
    onDiagnostic: ({ type, ...diagnostic }) => mediaLog(
      logger,
      type === 'backpressure' ? 'warn' : 'info',
      type === 'backpressure' ? 'terminal_writer_backpressure' : 'terminal_writer_summary',
      {
        ...diagnostic,
        terminalRows: process.stdout.rows || 24,
        terminalColumns: process.stdout.columns || 80
      }
    )
  }) : null;
  let activeSong = song;
  let activeUrl = url;
  let activeDurationMs = durationMs;
  let lyrics = attachLyricTranslations(parseLrc(lyricSource), parseLrc(translatedLyricSource), parseLrc(romanizedLyricSource));
  let clock = createPlaybackClock(activeDurationMs);
  // 创建 bridge、下载封面等准备工作不应计入真实播放位置。
  clock.pause();
  const trackOffset = createTrackOffsetSession(lyricOffsetMs);
  let activeOffsetMs = trackOffset.value;
  const activeSmtcOffsetMs = Number.isFinite(Number(smtcOffsetMs)) ? Number(smtcOffsetMs) : 0;
  let volume = 100;
  let userPaused = false;
  let hasTranslation = lyrics.some((line) => Boolean(line.translation));
  let showTranslation = false;
  let showRomanized = false;
  let indicator = '';
  let indicatorUntil = 0;
  let favoritePending = false;
  const favoritedSongIds = new Set(favorited && activeSong?.id != null ? [String(activeSong.id)] : []);
  const playlistTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  let playlistCurrentIndex = playlistTracks.length
    ? clamp(Math.floor(Number(playlist?.currentIndex) || 0), 0, playlistTracks.length - 1)
    : -1;
  const playbackPlaylist = { name: playlist?.name || '', tracks: playlistTracks, currentIndex: playlistCurrentIndex };
  let playlistOpen = false;
  let playlistSelection = playlistCurrentIndex >= 0 ? playlistCurrentIndex : 0;
  let randomMode = 'off';
  let loopMode = 'sequence';
  let randomRemaining = Math.max(0, playlistTracks.length - 1);
  let shuffleOrder = shuffledPlaylistOrder(playlistTracks.length, playlistCurrentIndex);
  const playHistory = playlistCurrentIndex >= 0 ? [playlistCurrentIndex] : [];
  const randomLabels = { off: '不随机', random: '纯随机', shuffle: '打乱列表' };
  const loopLabels = { sequence: '顺序播放', list: '列表循环', single: '单曲循环' };
  let child = null;
  let persistentController = null;
  let persistentLoaded = false;
  let backendLabel = playerBackendLabel(player.command);
  let finished = false;
  let closing = false;
  let trackTransitioning = false;
  let trackTransitionController = null;
  let initialEntryTransitionController = null;
  const transitionCancelled = Symbol('transition_cancelled');
  let refreshTimer = null;
  let smtcTimer = null;
  let restartTargetMs = null;
  let restartGeneration = 0;
  let dynamicRow = 1;
  let dynamicAnchored = false;
  let headerRendering = false;
  let headerRenderId = 0;
  let headerAbortController = null;
  let creditsPlayerHeaderRows = [];
  let creditsTransitionHeaderRows = null;
  let creditsFullPlayerActive = false;
  let pageTransitionDepth = 0;
  let activeVerticalLayout = null;
  let activeHeaderMetadataVisible = false;
  let creditsPlayerVerticalLayout = null;
  let dispatchPlaybackAction = () => {};
  let sessionControlsEnabled = true;
  let sessionEnded = false;
  let retainSmtc = false;
  const smtc = await createSmtcBridge({
    song: activeSong,
    durationMs: activeDurationMs,
    playlistControls: playlistTracks.length > 0,
    canPrevious: playlistCurrentIndex > 0,
    canNext: playlistCurrentIndex >= 0 && playlistCurrentIndex < playlistTracks.length - 1,
    logger,
    onControl: (action) => dispatchPlaybackAction(action)
  });
  const intentionalStops = new WeakSet();
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const updateSmtcControls = () => smtc.updateControls({
    canPrevious: playHistory.length > 1 || playlistCurrentIndex > 0,
    canNext: playlistTracks.length > 1 && (loopMode !== 'sequence' || randomMode !== 'off' || playlistCurrentIndex < playlistTracks.length - 1)
  });

  const resetRandomCycle = () => {
    randomRemaining = Math.max(0, playlistTracks.length - 1);
    shuffleOrder = shuffledPlaylistOrder(playlistTracks.length, playlistCurrentIndex);
  };

  const nextModeTarget = ({ natural = false } = {}) => {
    const count = playlistTracks.length;
    if (!count) return null;
    if (natural && loopMode === 'single') return playlistCurrentIndex;
    if (randomMode === 'off') {
      if (playlistCurrentIndex + 1 < count) return playlistCurrentIndex + 1;
      return loopMode === 'list' ? 0 : null;
    }
    if (count === 1) return loopMode === 'list' ? 0 : null;
    if (randomRemaining <= 0) {
      if (loopMode !== 'list') return null;
      resetRandomCycle();
    }
    randomRemaining -= 1;
    if (randomMode === 'random') {
      let target = playlistCurrentIndex;
      while (target === playlistCurrentIndex) target = Math.floor(Math.random() * count);
      return target;
    }
    let position = shuffleOrder.indexOf(playlistCurrentIndex);
    if (position < 0 || position + 1 >= shuffleOrder.length) {
      shuffleOrder = shuffledPlaylistOrder(count, playlistCurrentIndex);
      position = 0;
    }
    return shuffleOrder[position + 1] ?? null;
  };

  const updateSmtc = (status, rawPositionMs = clock.position()) => {
    const timeline = smtcTimeline(rawPositionMs, activeDurationMs, activeOffsetMs + activeSmtcOffsetMs);
    return smtc.updatePlayback({ status, ...timeline });
  };

  const spawnAt = async (positionMs) => {
    if (persistentController) {
      await persistentController.load(activeUrl, { positionMs, volume, durationMs: activeDurationMs, metadata: activeSong });
      await persistentController.resume();
      persistentLoaded = true;
      sessionEnded = false;
      updateSmtc('playing', positionMs);
      void logger?.info('player_load', { player: player.command, positionMs });
      return;
    }
    const args = player.args(activeUrl, positionMs / 1000, volume);
    const marker = `ncm-cli-${randomUUID()}`;
    if (player.command === 'ffplay') args.splice(Math.max(0, args.length - 1), 0, '-window_title', marker);
    else if (player.command === 'mpv') args.splice(Math.max(0, args.length - 1), 0, `--user-agent=${marker}`);
    else if (player.command === 'vlc' || player.command === 'cvlc') {
      args.splice(Math.max(0, args.length - 1), 0, `--http-user-agent=${marker}`);
    }
    const instance = spawn(player.executable, args, { stdio: 'ignore', windowsHide: true });
    guardPlayerProcess(instance, { command: player.executable, marker });
    child = instance;
    sessionEnded = false;
    updateSmtc('playing', positionMs);
    void logger?.info('player_spawn', { player: player.command, pid: instance.pid, positionMs });
    instance.once('error', (error) => {
      if (!finished && !intentionalStops.has(instance)) rejectCompletion(error);
    });
    instance.once('exit', (code, exitSignal) => {
      void logger?.info('player_exit', { player: player.command, code, signal: exitSignal });
      if (!finished && child === instance && !intentionalStops.has(instance)) {
        child = null;
        if (code === 0 && !exitSignal) enqueue(() => handleNaturalEnd());
        else rejectCompletion(new Error(`${player.command} 异常退出（code=${code}, signal=${exitSignal || 'none'}）`));
      }
    });
  };

  const stopCurrent = async () => {
    if (persistentController) {
      if (persistentLoaded && persistentController.available) await persistentController.stop();
      persistentLoaded = false;
      return;
    }
    const instance = child;
    child = null;
    if (hasProcessExited(instance)) return;
    intentionalStops.add(instance);
    await terminatePlayer(instance);
  };

  const restartAt = async (positionMs, generation) => {
    if (generation !== restartGeneration) return;
    if (!clock.paused) clock.pause();
    await stopCurrent();
    if (generation !== restartGeneration) return;
    const finalPosition = restartTargetMs ?? positionMs;
    restartTargetMs = null;
    restartDebounce.cancel();
    clock.seekTo(finalPosition);
    if (!userPaused) {
      await spawnAt(finalPosition);
      clock.resume();
    }
  };

  const creditsPlayerTransitionActive = () => Boolean(
    easterEggForSong(activeSong)
    && creditsEasterEggTimelineForSong(
      activeSong,
      clock.position(),
      displayPosition(clock.position(), activeOffsetMs),
      Math.max(1, process.stdout.rows || 24)
    ).phase.endsWith('-transition')
  );

  let renderDiagnostics = {
    startedAt: performance.now(), count: 0, totalDurationMs: 0, maxDurationMs: 0,
    lastPhase: 'normal'
  };
  const flushRenderDiagnostics = (reason = 'interval') => {
    if (!renderDiagnostics.count) return;
    const windowMs = Math.max(0, performance.now() - renderDiagnostics.startedAt);
    mediaLog(logger, 'info', 'playback_render_summary', {
      reason,
      windowMs: Math.round(windowMs),
      renderCount: renderDiagnostics.count,
      averageDurationMs: Number(
        (renderDiagnostics.totalDurationMs / renderDiagnostics.count).toFixed(2)
      ),
      maxDurationMs: Number(renderDiagnostics.maxDurationMs.toFixed(2)),
      phase: renderDiagnostics.lastPhase,
      writerBlocked: Boolean(dynamicWriter?.blocked),
      terminalRows: process.stdout.rows || 24,
      terminalColumns: process.stdout.columns || 80
    });
    renderDiagnostics = {
      startedAt: performance.now(), count: 0, totalDurationMs: 0, maxDurationMs: 0,
      lastPhase: renderDiagnostics.lastPhase
    };
  };
  const recordRenderDiagnostic = (startedAt, phase) => {
    const durationMs = performance.now() - startedAt;
    renderDiagnostics.count += 1;
    renderDiagnostics.totalDurationMs += durationMs;
    renderDiagnostics.maxDurationMs = Math.max(renderDiagnostics.maxDurationMs, durationMs);
    renderDiagnostics.lastPhase = phase || 'normal';
    if (performance.now() - renderDiagnostics.startedAt >= 5000) flushRenderDiagnostics();
  };

  const render = () => {
    if (!tty || finished || headerRendering || pageTransitionDepth > 0) return;
    const renderStartedAt = performance.now();
    if (refreshTimer) clearTimeout(refreshTimer);
    const rawElapsedMs = clock.position();
    const elapsedMs = sessionEnded ? activeDurationMs : displayPosition(rawElapsedMs, activeOffsetMs);
    const displayDurationMs = activeDurationMs;
    const lyricElapsedMs = elapsedMs;
    const now = performance.now();
    if (indicator && now >= indicatorUntil) indicator = '';
    const easterEggConfig = easterEggForSong(activeSong);
    const easterEggTimeline = easterEggConfig
      ? creditsEasterEggTimelineForSong(
          activeSong, rawElapsedMs, lyricElapsedMs, Math.max(1, process.stdout.rows || 24)
        )
      : null;
    const easterEgg = easterEggConfig ? {
      ...easterEggConfig,
      ...easterEggTimeline
    } : null;
    const renderOptions = {
      elapsedMs,
      lyricElapsedMs,
      durationMs: displayDurationMs,
      paused: userPaused,
      lyrics,
      showTranslation,
      showRomanized,
      translationMode: showRomanized ? 'romanized' : showTranslation ? 'translated' : 'off',
      canToggleTranslation: lyrics.some((line) => Boolean(line.translation || line.romanized)),
      indicator,
      playlist: playbackPlaylist,
      playlistOpen,
      playlistSelection,
      playbackModeText: playlistTracks.length
        ? { randomLabel: randomLabels[randomMode], loopLabel: loopLabels[loopMode], playlistOpen }
        : '',
      canFavorite: typeof onFavorite === 'function',
      favorited: favoritedSongIds.has(String(activeSong?.id ?? '')),
      compactPausedRow: activeSong.name || activeSong.title || '',
      compactPausedArtist: songArtistsText(activeSong),
      replacePausedContent: !activeHeaderMetadataVisible,
      writeOutput: dynamicWriter?.write,
      verticalLayout: activeVerticalLayout
    };
    const creditsTransitionActive = easterEgg?.phase?.endsWith('-transition');
    if (creditsTransitionActive && !creditsTransitionHeaderRows) {
      creditsTransitionHeaderRows = [...creditsPlayerHeaderRows];
    }
    const stableCreditsHeaderRows = creditsTransitionHeaderRows ?? creditsPlayerHeaderRows;
    if (creditsTransitionActive) {
      const terminalRows = Math.max(1, process.stdout.rows || 24);
      const animationRows = renderDynamic({
        ...renderOptions,
        // 转场尚未完全擦除普通播放器头部时，不提前显示暂停摘要。
        replacePausedContent: false,
        dynamicRow: 1,
        dynamicAnchored: false,
        currentLyricOnly: true,
        easterEgg: { ...easterEgg, phase: 'animation' },
        verticalLayout: null,
        captureOnly: true
      });
      const playerDynamicRows = renderDynamic({
        ...renderOptions,
        replacePausedContent: creditsPlayerVerticalLayout?.metadataRows === 0,
        dynamicRow: stableCreditsHeaderRows.length + 1,
        dynamicAnchored: false,
        currentLyricOnly: Boolean(easterEggConfig?.currentLyricOnly),
        easterEgg: null,
        verticalLayout: creditsPlayerVerticalLayout,
        captureOnly: true
      });
      const playerRows = [...stableCreditsHeaderRows, ...playerDynamicRows];
      const enteringEasterEgg = easterEgg.phase === 'egg-transition';
      creditsFullPlayerActive = enteringEasterEgg;
      const entries = composeCreditsPlayerTransitionRows(
        enteringEasterEgg ? playerRows : animationRows,
        enteringEasterEgg ? animationRows : playerRows,
        easterEgg.transitionElapsedMs,
        terminalRows
      );
      writeCreditsTransitionRows(entries, dynamicWriter?.write);
    } else {
      const creditsOrdinaryPlayer = ['player-intro', 'player'].includes(easterEgg?.phase);
      if (creditsOrdinaryPlayer && !creditsFullPlayerActive) {
        creditsFullPlayerActive = true;
        creditsTransitionHeaderRows = null;
        dynamicRow = Math.min(
          Math.max(1, process.stdout.rows || 24),
          stableCreditsHeaderRows.length + 1
        );
        dynamicAnchored = true;
        activeHeaderMetadataVisible = Boolean(creditsPlayerVerticalLayout?.metadataRows);
        const headerOutput = stableCreditsHeaderRows
          .map((row) => `${row}\x1b[0m\x1b[K`).join('\n');
        process.stdout.write(
          `\x1b[H${headerOutput}${headerOutput ? '\n' : ''}\x1b[${dynamicRow};1H\x1b[s`
        );
      } else if (easterEgg?.phase === 'animation' && creditsFullPlayerActive) {
        creditsFullPlayerActive = false;
        creditsTransitionHeaderRows = null;
        dynamicRow = 1;
        dynamicAnchored = true;
        activeHeaderMetadataVisible = false;
        process.stdout.write('\x1b[2J\x1b[H\x1b[s');
      }
      renderDynamic({
        ...renderOptions,
        dynamicRow,
        dynamicAnchored,
        currentLyricOnly: Boolean(easterEggConfig?.currentLyricOnly),
        easterEgg: creditsOrdinaryPlayer ? null : easterEgg,
        verticalLayout: creditsOrdinaryPlayer ? creditsPlayerVerticalLayout : null
      });
    }
    recordRenderDiagnostic(renderStartedAt, easterEgg?.phase || 'normal');
    const indicatorDelay = indicator ? Math.max(20, indicatorUntil - now) : Infinity;
    const easterEggPhaseDelay = easterEgg?.nextChangeDelayMs ?? Infinity;
    refreshTimer = setTimeout(render, Math.min(
      nextRefreshDelay(rawElapsedMs, lyrics, userPaused, activeOffsetMs, easterEgg?.refreshIntervalMs),
      indicatorDelay,
      easterEggPhaseDelay
    ));
  };

  const setIndicator = (text, durationMs = 1200) => {
    indicator = text;
    indicatorUntil = performance.now() + Math.max(0, Number(durationMs) || 0);
  };

  const runPageTransition = async (operation) => {
    pageTransitionDepth += 1;
    try {
      return await operation();
    } finally {
      pageTransitionDepth = Math.max(0, pageTransitionDepth - 1);
    }
  };

  const captureDirectCreditsAnimationRows = (rawElapsedMs = clock.position()) => {
    const config = easterEggForSong(activeSong);
    if (!config?.directAnimation) return [];
    const elapsedMs = displayPosition(rawElapsedMs, activeOffsetMs);
    const timeline = creditsEasterEggTimelineForSong(
      activeSong, rawElapsedMs, elapsedMs, Math.max(1, process.stdout.rows || 24)
    );
    return renderDynamic({
      elapsedMs,
      lyricElapsedMs: elapsedMs,
      durationMs: activeDurationMs,
      paused: true,
      lyrics,
      showTranslation,
      showRomanized,
      indicator,
      playlist: playbackPlaylist,
      playlistOpen: false,
      playlistSelection,
      playbackModeText: playlistTracks.length
        ? { randomLabel: randomLabels[randomMode], loopLabel: loopLabels[loopMode], playlistOpen: false }
        : '',
      canFavorite: typeof onFavorite === 'function',
      favorited: favoritedSongIds.has(String(activeSong?.id ?? '')),
      dynamicRow: 1,
      dynamicAnchored: false,
      currentLyricOnly: true,
      easterEgg: { ...config, ...timeline },
      verticalLayout: null,
      captureOnly: true
    });
  };

  const playDirectCreditsEntryTransition = async (transitionSignal) => {
    const config = easterEggForSong(activeSong);
    if (!tty || !config?.directAnimation) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const terminalRows = Math.max(1, process.stdout.rows || 24);
    const animationRows = captureDirectCreditsAnimationRows(0);
    await runPageTransition(() =>
      playCreditsPageRevealTransition(animationRows, terminalRows, {
        signal: transitionSignal,
        writeFrame: (entries) => writeCreditsPageRevealRows(entries),
        refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS
      })
    );
    creditsFullPlayerActive = false;
    dynamicRow = 1;
    dynamicAnchored = true;
    activeHeaderMetadataVisible = false;
    headerRendering = false;
    process.stdout.write('\x1b[H\x1b[s');
  };

  const playDirectCreditsExitTransition = async () => {
    const config = easterEggForSong(activeSong);
    if (!tty || !config?.directAnimation) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const terminalRows = Math.max(1, process.stdout.rows || 24);
    const animationRows = captureDirectCreditsAnimationRows();
    const targetRows = Array.isArray(returnPageRows) ? returnPageRows : [];
    if (!targetRows.length) return;
    await runPageTransition(() =>
      playCreditsPlayerTransition(animationRows, targetRows, terminalRows, {
        writeFrame: (entries) => writeCreditsTransitionRows(entries),
        refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS
      })
    );
    refreshCreditsTargetPage(targetRows, terminalRows);
  };

  const showCreditsFontRecommendation = () => {
    const recommendation = creditsFontRecommendation(activeSong);
    if (!recommendation) return false;
    setIndicator(recommendation, CREDITS_FONT_HINT_DURATION_MS);
    return true;
  };

  let operationQueue = Promise.resolve();
  const enqueue = (operation) => {
    operationQueue = operationQueue.then(() => finished ? undefined : operation()).then(render).catch((error) => {
      if (!finished) {
        finished = true;
        rejectCompletion(error);
      }
    });
    return operationQueue;
  };

  const restartDebounce = createLatestDebounce(({ positionMs, generation }) => {
    const target = restartTargetMs ?? positionMs;
    restartTargetMs = null;
    enqueue(() => generation === restartGeneration ? restartAt(target, generation) : undefined);
  });
  const invalidateRestart = () => {
    restartGeneration += 1;
    restartDebounce.cancel();
    restartTargetMs = null;
  };
  const scheduleRestart = (positionMs) => {
    restartTargetMs = positionMs;
    restartDebounce.schedule({ positionMs, generation: restartGeneration });
  };

  const cancelTrackTransition = (reason = '切歌操作已取消') => {
    initialEntryTransitionController?.abort(new DOMException(reason, 'AbortError'));
    trackTransitionController?.abort(new DOMException(reason, 'AbortError'));
  };

  const finish = (reason) => {
    if (closing) return;
    closing = true;
    invalidateRestart();
    cancelTrackTransition('播放已退出');
    enqueue(async () => {
      if (finished) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      await runPlaybackExitSequence({
        stop: async () => {
          await stopCurrent();
          updateSmtc('stopped');
        },
        transition: playDirectCreditsExitTransition,
        onError: (error, stage) => logger?.warn('playback_exit_stage_failed', { stage, error })
      });
      finished = true;
      resolveCompletion(reason);
    });
  };

  const verticalLayoutFor = (songSnapshot, terminalRows, terminalColumns, coverRows = 0) => {
    const modeRowCount = playlistTracks.length
      ? playbackPlaylistModeRows({
          randomLabel: randomLabels[randomMode],
          loopLabel: loopLabels[loopMode],
          playlistOpen
        }, terminalColumns).length
      : 0;
    const shortcutRowCount = playbackShortcutRows({
      canFavorite: typeof onFavorite === 'function',
      favorited: favoritedSongIds.has(String(songSnapshot?.id ?? ''))
    }, terminalColumns).length;
    return planPlaybackVerticalLayout({
      rows: terminalRows,
      coverRows,
      metadataRows: playbackMetadataRows(songSnapshot, backendLabel, terminalColumns).length,
      metadataSpacerRows: 1,
      futureLyricRows: terminalRows,
      modeRows: modeRowCount,
      shortcutRows: shortcutRowCount,
      statusRows: 1,
      currentLyricRows: 1,
      progressRows: 1
    });
  };

  const prepareOrdinaryPlayerTransitionRows = async (transitionSignal) => {
    const terminalRows = Math.max(1, process.stdout.rows || 24);
    const terminalColumns = Math.max(1, process.stdout.columns || 80);
    const desiredCoverRows = activeSong.cover && imageProtocol !== 'none'
      ? playbackCoverRowBudget(terminalRows)
      : 0;
    let layout = verticalLayoutFor(activeSong, terminalRows, terminalColumns, desiredCoverRows);
    const prepared = await buildTextPlaybackHeaderRows(activeSong, {
      signal: transitionSignal,
      backendLabel,
      columns: terminalColumns,
      layout,
      protocol: imageProtocol,
      imageCacheMaxBytes,
      logger
    });
    if (transitionSignal?.aborted) {
      throw transitionSignal.reason ?? new DOMException('切歌转场已取消', 'AbortError');
    }
    if (prepared.coverRows.length !== layout.coverRows) {
      layout = verticalLayoutFor(activeSong, terminalRows, terminalColumns, prepared.coverRows.length);
    }
    const headerRows = [
      ...prepared.coverRows,
      ...playbackMetadataRows(activeSong, backendLabel, terminalColumns, layout.metadataRows)
    ];
    const elapsedMs = displayPosition(0, activeOffsetMs);
    const dynamicRows = renderDynamic({
      elapsedMs,
      lyricElapsedMs: elapsedMs,
      durationMs: activeDurationMs,
      paused: userPaused,
      lyrics,
      showTranslation,
      showRomanized,
      indicator,
      playlist: playbackPlaylist,
      playlistOpen: false,
      playlistSelection,
      playbackModeText: playlistTracks.length
        ? { randomLabel: randomLabels[randomMode], loopLabel: loopLabels[loopMode], playlistOpen: false }
        : '',
      canFavorite: typeof onFavorite === 'function',
      favorited: favoritedSongIds.has(String(activeSong?.id ?? '')),
      compactPausedRow: activeSong.name || activeSong.title || '',
      compactPausedArtist: songArtistsText(activeSong),
      replacePausedContent: layout.metadataRows === 0,
      dynamicRow: headerRows.length + 1,
      dynamicAnchored: false,
      currentLyricOnly: Boolean(easterEggForSong(activeSong)?.currentLyricOnly),
      easterEgg: null,
      verticalLayout: layout,
      captureOnly: true
    });
    return { rows: [...headerRows, ...dynamicRows], headerRows, layout, coverBuffer: prepared.coverBuffer };
  };

  const drawHeader = async (
    transitionSignal = null,
    { allowNativeGraphics = false, preloadedCoverBuffer = null, reason = 'unspecified' } = {}
  ) => {
    if (!tty) return;
    headerAbortController?.abort();
    const renderId = ++headerRenderId;
    const controller = new AbortController();
    headerAbortController = controller;
    const headerSignals = [signal, controller.signal, transitionSignal].filter(Boolean);
    const headerSignal = headerSignals.length > 1
      ? AbortSignal.any(headerSignals)
      : controller.signal;
    const headerStartedAt = Date.now();
    let headerStatus = 'pending';
    mediaLog(logger, 'info', 'playback_header_started', {
      renderId, reason, songId: activeSong?.id,
      terminalRows: process.stdout.rows || 24,
      terminalColumns: process.stdout.columns || 80,
      imageProtocol, preloadedCover: Boolean(preloadedCoverBuffer)
    });
    try {
    const songSnapshot = activeSong;
    headerRendering = true;
    dynamicAnchored = false;
    dynamicWriter?.dropPending();
    activeHeaderMetadataVisible = false;
    process.stdout.write('\x1b[2J\x1b[H');
    const initialRows = Math.max(1, process.stdout.rows || 24);
    const initialColumns = Math.max(1, process.stdout.columns || 80);
    const desiredCoverRows = songSnapshot.cover && imageProtocol !== 'none'
      ? playbackCoverRowBudget(initialRows)
      : 0;
    let verticalLayout = verticalLayoutFor(songSnapshot, initialRows, initialColumns, desiredCoverRows);
    const creditsConfig = easterEggForSong(songSnapshot);
    const creditsTimeline = creditsConfig ? creditsEasterEggTimelineForSong(
      songSnapshot,
      clock.position(),
      displayPosition(clock.position(), activeOffsetMs),
      initialRows
    ) : null;
    if (creditsConfig?.mode === 'credits-csf') {
      creditsPlayerVerticalLayout = verticalLayout;
      creditsTransitionHeaderRows = null;
      creditsPlayerHeaderRows = playbackMetadataRows(
        songSnapshot, backendLabel, initialColumns, verticalLayout.metadataRows
      );
      const normalizeCreditsHeader = (prepared) => {
        const layout = prepared.coverRows.length === verticalLayout.coverRows
          ? verticalLayout
          : verticalLayoutFor(songSnapshot, initialRows, initialColumns, prepared.coverRows.length);
        return {
          layout,
          rows: [
            ...prepared.coverRows,
            ...playbackMetadataRows(songSnapshot, backendLabel, initialColumns, layout.metadataRows)
          ]
        };
      };
      const creditsOrdinaryPlayer = ['player-intro', 'player'].includes(creditsTimeline?.phase);
      if (creditsOrdinaryPlayer) {
        const imageIdentity = { type: 'track-cover', id: songSnapshot.id };
        const availableCoverBuffer = preloadedCoverBuffer
          ?? peekCachedImage(songSnapshot.cover, { identity: imageIdentity });
        if (verticalLayout.coverRows > 0 && !availableCoverBuffer) {
          void loadImage(songSnapshot.cover, headerSignal, {
            imageCacheMaxBytes, logger, imageIdentity
          }).then((buffer) => {
            if (!headerSignal.aborted && renderId === headerRenderId && !finished) {
              void drawHeader(null, {
                preloadedCoverBuffer: buffer,
                reason: 'image_ready'
              }).catch((error) => mediaLog(logger, 'warn', 'playback_header_failed', { error }));
            }
          }).catch((error) => {
            if (error?.name !== 'AbortError') mediaLog(logger, 'warn', 'image_deferred_load_failed', { error });
          });
        }
        const prepared = normalizeCreditsHeader(verticalLayout.coverRows > 0 && !availableCoverBuffer
          ? { coverRows: Array.from({ length: verticalLayout.coverRows }, () => ''), coverBuffer: null }
          : await buildTextPlaybackHeaderRows(songSnapshot, {
              signal: headerSignal, backendLabel, columns: initialColumns,
              layout: verticalLayout, protocol: imageProtocol,
              imageCacheMaxBytes, logger, preloadedBuffer: availableCoverBuffer
            }));
        if (headerSignal.aborted || renderId !== headerRenderId || finished) return;
        verticalLayout = prepared.layout;
        creditsPlayerVerticalLayout = verticalLayout;
        creditsPlayerHeaderRows = prepared.rows;
        activeVerticalLayout = verticalLayout;
        activeHeaderMetadataVisible = verticalLayout.metadataRows > 0;
        creditsFullPlayerActive = true;
        const headerOutput = prepared.rows.map((row) => `${row}\x1b[0m\x1b[K`).join('\n');
        dynamicRow = Math.min(initialRows, prepared.rows.length + 1);
        process.stdout.write(
          `${headerOutput}${headerOutput ? '\n' : ''}\x1b[${dynamicRow};1H\x1b[s`
        );
        dynamicAnchored = true;
        headerRendering = false;
        headerStatus = 'success';
        render();
        return;
      }

      // 两次逐行过渡使用可切分的 ANSI 封面快照；稳定彩蛋阶段将整屏留给 CSF。
      creditsFullPlayerActive = creditsTimeline?.phase === 'egg-transition';
      const prepareCreditsHeader = buildTextPlaybackHeaderRows(songSnapshot, {
        signal: headerSignal, backendLabel, columns: initialColumns,
        layout: verticalLayout, protocol: imageProtocol,
        imageCacheMaxBytes, logger, preloadedBuffer: preloadedCoverBuffer
      });
      if (creditsTimeline?.phase?.endsWith('-transition')) {
        const prepared = normalizeCreditsHeader(await prepareCreditsHeader);
        if (headerSignal.aborted || renderId !== headerRenderId || finished) return;
        creditsPlayerVerticalLayout = prepared.layout;
        creditsPlayerHeaderRows = prepared.rows;
      } else {
        void prepareCreditsHeader.then(normalizeCreditsHeader).then((prepared) => {
          if (!headerSignal.aborted && renderId === headerRenderId && !finished
              && String(activeSong?.id ?? '') === String(songSnapshot.id ?? '')) {
            creditsPlayerVerticalLayout = prepared.layout;
            creditsPlayerHeaderRows = prepared.rows;
          }
        });
      }
      dynamicRow = 1;
      activeVerticalLayout = null;
      activeHeaderMetadataVisible = false;
      process.stdout.write('\x1b[s');
      dynamicAnchored = true;
      headerRendering = false;
      headerStatus = 'success';
      render();
      return;
    }
    const coverRows = verticalLayout.coverRows > 0
      ? await tryRenderImage(songSnapshot.cover, {
          signal: headerSignal,
          size: 'playback',
          protocol: imageProtocol,
          maxRows: verticalLayout.coverRows,
          allowNativeGraphics,
          preloadedBuffer: preloadedCoverBuffer,
          logger,
          diagnosticContext: 'playback_header',
          imageCacheMaxBytes,
          imageIdentity: { type: 'track-cover', id: songSnapshot.id },
          deferLoad: true,
          onDeferredReady: (buffer) => {
            if (!headerSignal.aborted && renderId === headerRenderId && !finished
                && String(activeSong?.id ?? '') === String(songSnapshot.id ?? '')) {
              void drawHeader(null, {
                preloadedCoverBuffer: buffer,
                reason: 'image_ready'
              }).catch((error) => mediaLog(logger, 'warn', 'playback_header_failed', { error }));
            }
          },
          shouldRender: () => !headerSignal.aborted && renderId === headerRenderId && !finished
        })
      : 0;
    if (headerSignal.aborted || renderId !== headerRenderId || finished) return;
    if (coverRows !== verticalLayout.coverRows) {
      verticalLayout = verticalLayoutFor(songSnapshot, initialRows, initialColumns, coverRows);
    }
    activeVerticalLayout = verticalLayout;
    const metadata = playbackMetadataRows(
      songSnapshot, backendLabel, initialColumns, verticalLayout.metadataRows
    );
    activeHeaderMetadataVisible = metadata.length > 0;
    for (const line of metadata) console.log(line);
    dynamicRow = Math.min(initialRows, coverRows + Math.min(metadata.length, verticalLayout.metadataRows) + 1);
    process.stdout.write('\x1b[s');
    dynamicAnchored = true;
    headerRendering = false;
    headerStatus = 'success';
    render();
    } finally {
      if (headerStatus === 'pending') {
        headerStatus = headerSignal.aborted || finished || renderId !== headerRenderId
          ? 'cancelled'
          : 'failed';
      }
      mediaLog(logger, headerStatus === 'failed' ? 'warn' : 'info', 'playback_header_completed', {
        renderId, reason, songId: activeSong?.id, status: headerStatus,
        durationMs: Date.now() - headerStartedAt,
        terminalRows: process.stdout.rows || 24,
        terminalColumns: process.stdout.columns || 80,
        dynamicRow, metadataVisible: activeHeaderMetadataVisible,
        coverRows: activeVerticalLayout?.coverRows ?? null
      });
    }
  };

  const transitionTo = async (targetIndex, cause = 'manual') => {
    if (closing) return transitionCancelled;
    if (!playlistTracks.length || targetIndex < 0 || targetIndex >= playlistTracks.length) return false;
    invalidateRestart();
    trackTransitioning = true;
    const transitionController = new AbortController();
    trackTransitionController = transitionController;
    try {
    const sameTrack = targetIndex === playlistCurrentIndex;
    if (!sameTrack && typeof onTrackChange !== 'function') {
      // 兼容旧调用方：没有加载回调时仍返回原有的切歌结果。
      finished = true;
      resolveCompletion({
        type: cause === 'select' ? 'playlist_select'
          : targetIndex < playlistCurrentIndex ? 'playlist_previous' : 'playlist_next',
        ...(cause === 'select' ? { index: targetIndex } : {})
      });
      return false;
    }

    const oldPosition = clock.position();
    const leavingDirectAnimation = Boolean(easterEggForSong(activeSong)?.directAnimation);
    const wasPlaying = Boolean(child && !userPaused);
    setIndicator(`正在切换到 ${targetIndex + 1}/${playlistTracks.length}`);
    render();
    const leavingCreditsRows = leavingDirectAnimation
      ? captureDirectCreditsAnimationRows(oldPosition)
      : [];
    if (leavingDirectAnimation && refreshTimer) clearTimeout(refreshTimer);
    if (wasPlaying) clock.pause();
    // 用户发出切歌请求后先立即停止声音；网络加载时间不会继续吞掉旧曲时间。
    await stopCurrent();
    let next = sameTrack ? {
      song: activeSong,
      url: activeUrl,
      durationMs: activeDurationMs,
      lyricSource: '',
      translatedLyricSource: '',
      lyrics
    } : null;
    if (!sameTrack) {
      try {
        next = await waitWithSignal(
          onTrackChange(targetIndex, cause, transitionController.signal),
          transitionController.signal
        );
      } catch (error) {
        if (closing || error?.name === 'AbortError') return transitionCancelled;
        void logger?.warn('playlist_track_change_failed', { targetIndex, error });
        setIndicator('切歌失败，已保留当前歌曲');
        if (!closing && cause !== 'natural' && !userPaused) {
          await spawnAt(oldPosition);
          clock.resume();
        }
        return false;
      }
      invalidateRestart();
      if (closing) return transitionCancelled;
      if (!next?.url || !next?.song) {
        setIndicator('目标歌曲暂时无法播放');
        if (cause !== 'natural' && !userPaused) {
          await spawnAt(oldPosition);
          clock.resume();
        }
        return false;
      }
    }

    const resolvedIndex = Number.isInteger(next.index)
      ? clamp(next.index, 0, playlistTracks.length - 1)
      : targetIndex;
    activeSong = next.song;
    const nextSongId = String(activeSong?.id ?? '');
    if (next.favorited) favoritedSongIds.add(nextSongId);
    else favoritedSongIds.delete(nextSongId);
    activeOffsetMs = trackOffset.reset();
    creditsFullPlayerActive = false;
    creditsPlayerHeaderRows = [];
    creditsTransitionHeaderRows = null;
    activeUrl = next.url;
    activeDurationMs = Math.max(0, Number(next.durationMs ?? next.song.durationMs) || 0);
    lyrics = Array.isArray(next.lyrics) ? next.lyrics : attachLyricTranslations(
      parseLrc(next.lyricSource ?? next.lyrics?.original ?? ''),
      parseLrc(next.translatedLyricSource ?? next.lyrics?.translated ?? ''),
      parseLrc(next.romanizedLyricSource ?? next.lyrics?.romanized ?? '')
    );
    hasTranslation = lyrics.some((line) => Boolean(line.translation));
    const hasRomanized = lyrics.some((line) => Boolean(line.romanized));
    showTranslation = false;
    showRomanized = false;
    playlistCurrentIndex = resolvedIndex;
    if (!sameTrack && cause !== 'history') playHistory.push(resolvedIndex);
    playbackPlaylist.currentIndex = resolvedIndex;
    playlistSelection = resolvedIndex;
    playlistOpen = false;
    sessionEnded = false;
    clock = createPlaybackClock(activeDurationMs);
    clock.pause();
    await smtc.setMetadata({
      ...activeSong,
      durationMs: activeDurationMs,
      cover: activeSong.cover ?? null,
      coverUri: activeSong.cover ?? null
    });
    invalidateRestart();
    if (closing) return transitionCancelled;
    updateSmtcControls();
    const directAnimation = Boolean(easterEggForSong(activeSong)?.directAnimation);
    let started;
    if (leavingDirectAnimation && !directAnimation) {
      try {
        const prepared = await prepareOrdinaryPlayerTransitionRows(transitionController.signal);
        await runPageTransition(() =>
          playCreditsPlayerTransition(
            leavingCreditsRows,
            prepared.rows,
            Math.max(1, process.stdout.rows || 24),
            {
              signal: transitionController.signal,
              writeFrame: (entries) => writeCreditsTransitionRows(entries),
              refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS
            }
          )
        );
        try {
          // 转场快照必须使用可逐行组合的 ANSI 文本；稳定页面则重新走正式
          // header 渲染，以便按 imageProtocol 使用 Kitty/SIXEL/chafa/ANSI。
          await drawHeader(transitionController.signal, {
            allowNativeGraphics: true,
            preloadedCoverBuffer: prepared.coverBuffer,
            reason: 'track_change_after_transition'
          });
        } catch (headerError) {
          if (headerError?.name === 'AbortError') throw headerError;
          void logger?.warn('playback_header_failed', { error: headerError });
          const terminalRows = Math.max(1, process.stdout.rows || 24);
          refreshCreditsTargetPage(prepared.rows, terminalRows);
          creditsPlayerHeaderRows = prepared.headerRows;
          activeVerticalLayout = prepared.layout;
          activeHeaderMetadataVisible = prepared.layout.metadataRows > 0;
          dynamicRow = Math.min(terminalRows, prepared.headerRows.length + 1);
          dynamicAnchored = true;
          headerRendering = false;
          process.stdout.write(`\x1b[${dynamicRow};1H\x1b[s`);
        }
        if (closing || transitionController.signal.aborted) return transitionCancelled;
        if (!userPaused) {
          await spawnAt(0);
          if (closing || transitionController.signal.aborted) return transitionCancelled;
          clock.resume();
        } else {
          updateSmtc('paused', 0);
        }
      } catch (error) {
        if (closing || transitionController.signal.aborted || error?.name === 'AbortError') {
          return transitionCancelled;
        }
        throw error;
      }
      started = true;
    } else {
      started = await startTrackWithPreparedHeader({
        directAnimation,
        drawHeader: directAnimation
          ? () => playDirectCreditsEntryTransition(transitionController.signal)
          : () => drawHeader(transitionController.signal, { reason: 'track_change' }),
        signal: transitionController.signal,
        startPlayback: async () => {
          if (closing || transitionController.signal.aborted) return;
          if (!userPaused) {
            await spawnAt(0);
            if (closing || transitionController.signal.aborted) return;
            clock.resume();
          } else {
            updateSmtc('paused', 0);
          }
        },
        onHeaderError: (error) => {
          if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
          if (directAnimation) throw error;
        }
      });
    }
    if (!started || closing || transitionController.signal.aborted) return transitionCancelled;
    if (!showCreditsFontRecommendation()) {
      setIndicator(userPaused
        ? `已暂停 ${resolvedIndex + 1}/${playlistTracks.length}`
        : `正在播放 ${resolvedIndex + 1}/${playlistTracks.length}`);
    }
    return true;
    } finally {
      if (trackTransitionController === transitionController) trackTransitionController = null;
      trackTransitioning = false;
    }
  };

  const handleNaturalEnd = async () => {
    clock.pause();
    userPaused = true;
    clock.seekTo(activeDurationMs);
    updateSmtc('stopped', activeDurationMs);
    if (playlistTracks.length) {
      const targetIndex = nextModeTarget({ natural: true });
      if (targetIndex !== null) {
        userPaused = false;
        const result = await transitionTo(targetIndex, 'natural');
        if (result === true || result === transitionCancelled) return;
      }
    }
    userPaused = true;
    sessionEnded = true;
    updateSmtcControls();
    if (playlistTracks.length) {
      setIndicator('歌单播放完毕');
      return;
    }
    // 单曲自然结束后保留最后元数据与最终时间戳，但不再处理系统控制。
    sessionControlsEnabled = false;
    smtc.updateControls({ canPrevious: false, canNext: false });
    await runPlaybackExitSequence({
      stop: stopCurrent,
      transition: playDirectCreditsExitTransition,
      onError: (error, stage) => logger?.warn('playback_exit_stage_failed', { stage, error })
    });
    retainSmtc = true;
    retainedSmtcBridge = smtc;
    finished = true;
    resolveCompletion('ended');
  };

  dispatchPlaybackAction = (action) => {
    if (!sessionControlsEnabled && action.action) return;
    if (action.type === 'interrupt') {
      onInterrupt?.();
      return;
    }
    if (action.type === 'quit' || action.action === 'stop') {
      finish(action.action === 'stop' ? 'smtc_stop' : 'quit');
      return;
    }
    if (closing) return;
    if (pageTransitionDepth > 0) return;
    if (action.type === 'refresh') {
      setIndicator('页面已刷新');
      if (creditsPlayerTransitionActive()) {
        render();
        return;
      }
      void drawHeader(null, { reason: 'manual_refresh' }).catch((error) => {
        if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
      });
      return;
    }
    if (action.type === 'playlist_previous' || action.type === 'playlist_next'
        || action.action === 'previous' || action.action === 'next') {
      if (playlistTracks.length) {
        const type = action.action === 'previous' ? 'playlist_previous'
          : action.action === 'next' ? 'playlist_next' : action.type;
        const previous = type === 'playlist_previous';
        const immediateTarget = previous
          ? (playHistory.length > 1 ? playHistory.at(-2) : playlistCurrentIndex - 1)
          : nextModeTarget();
        if (immediateTarget === null || immediateTarget < 0 || immediateTarget >= playlistTracks.length) return;
        cancelTrackTransition('切歌目标已更新');
        invalidateRestart();
        enqueue(() => {
          if (previous && playHistory.length > 1) playHistory.pop();
          return transitionTo(immediateTarget, previous ? 'history' : 'control');
        });
      }
      return;
    }
    if (action.type === 'toggle_playlist') {
      if (playlistTracks.length) {
        playlistOpen = !playlistOpen;
        render();
      }
      return;
    }
    if (action.type === 'close_playlist') {
      if (playlistTracks.length) {
        playlistOpen = false;
        render();
      }
      return;
    }
    if (action.type === 'playlist_move') {
      if (playlistOpen && playlistTracks.length) {
        playlistSelection = clamp(playlistSelection + action.delta, 0, playlistTracks.length - 1);
        render();
      }
      return;
    }
    if (action.type === 'playlist_select') {
      if (playlistOpen && Number.isInteger(action.index) && action.index >= 0 && action.index < playlistTracks.length) {
        cancelTrackTransition('切歌目标已更新');
        invalidateRestart();
        enqueue(() => transitionTo(action.index, 'select'));
      }
      return;
    }
    if (action.type === 'cycle_random_mode' && playlistTracks.length) {
      randomMode = RANDOM_MODES[(RANDOM_MODES.indexOf(randomMode) + 1) % RANDOM_MODES.length];
      resetRandomCycle();
      setIndicator(`随机模式：${randomLabels[randomMode]}`);
      updateSmtcControls();
      render();
      void drawHeader(null, { reason: 'random_mode_change' }).catch((error) => {
        if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
      });
      return;
    }
    if (action.type === 'cycle_loop_mode' && playlistTracks.length) {
      loopMode = LOOP_MODES[(LOOP_MODES.indexOf(loopMode) + 1) % LOOP_MODES.length];
      setIndicator(`循环模式：${loopLabels[loopMode]}`);
      updateSmtcControls();
      render();
      void drawHeader(null, { reason: 'loop_mode_change' }).catch((error) => {
        if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
      });
      return;
    }
    if (action.type === 'favorite' && typeof onFavorite === 'function') {
      const songSnapshot = activeSong;
      const songId = String(songSnapshot?.id ?? '');
      if (!songId || favoritePending) return;
      const removing = favoritedSongIds.has(songId);
      favoritePending = true;
      setIndicator(removing ? '正在取消收藏…' : '正在收藏当前歌曲…');
      render();
      void Promise.resolve(onFavorite(songSnapshot, removing ? 'del' : 'add')).then((result) => {
        if (removing) {
          favoritedSongIds.delete(songId);
          setIndicator('已从喜欢的音乐中移除');
        } else {
          favoritedSongIds.add(songId);
          setIndicator(result?.alreadyPresent ? '当前歌曲已在喜欢的音乐中' : '已添加至喜欢的音乐');
        }
        render();
        void drawHeader(null, { reason: 'favorite_change' }).catch((error) => {
          if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
        });
      }, (error) => {
        if (error?.name !== 'AbortError') {
          void logger?.warn('favorite_song_failed', { songId, error });
          setIndicator(`收藏失败：${error?.message || '未知错误'}`);
          render();
        }
      }).finally(() => { favoritePending = false; });
      return;
    }
    if (action.type === 'toggle_pause' || action.action === 'play' || action.action === 'pause') {
      if (sessionEnded && (action.action === 'play' || action.type === 'toggle_pause')) {
        enqueue(async () => {
          if (closing) return;
          userPaused = false;
          clock.seekTo(0);
          await spawnAt(0);
          clock.resume();
          setIndicator('重新播放');
        });
        return;
      }
      const shouldPlay = action.action === 'play' || (action.type === 'toggle_pause' && userPaused);
      const shouldPause = action.action === 'pause' || (action.type === 'toggle_pause' && !userPaused);
      if (shouldPause && !userPaused) {
        userPaused = true;
        invalidateRestart();
        if (!clock.paused) clock.pause();
        updateSmtc('paused');
        setIndicator('已暂停');
        render();
        if (!trackTransitioning) {
          enqueue(() => persistentController ? persistentController.pause() : stopCurrent());
        }
      } else if (shouldPlay && userPaused) {
        userPaused = false;
        if (trackTransitioning) {
          setIndicator('切歌后继续播放');
          render();
        } else {
          enqueue(async () => {
            if (closing) return;
            const resumeAt = clock.position();
            if (persistentController && persistentLoaded) await persistentController.resume();
            else await spawnAt(resumeAt);
            clock.resume();
            setIndicator('继续播放');
          });
        }
      }
      return;
    }
    if (action.type === 'seek' || action.action === 'fast_forward' || action.action === 'rewind' || action.action === 'seek_absolute' || action.action === 'seek_relative') {
      if (trackTransitioning) {
        setIndicator('正在切歌，暂不支持跳转');
        render();
        return;
      }
      const deltaMs = action.action === 'fast_forward' ? 5000 : action.action === 'rewind' ? -5000 : action.deltaMs;
      const seekTo = action.action === 'seek_absolute'
        ? clock.seekTo(rawPosition(action.positionMs, activeOffsetMs + activeSmtcOffsetMs, activeDurationMs))
        : clock.seek(deltaMs);
      if (action.action === 'seek_absolute') setIndicator(`跳转到 ${formatTime(displayPosition(seekTo, activeOffsetMs))}`);
      else setIndicator(deltaMs > 0 ? '快进 5 秒' : '后退 5 秒');
      render();
      if (persistentController) {
        enqueue(() => persistentController.seekAbsolute(seekTo / 1000));
        updateSmtc(userPaused ? 'paused' : 'playing', seekTo);
      } else if (!userPaused) scheduleRestart(seekTo);
      else updateSmtc('paused', seekTo);
      return;
    }
    if (action.type === 'volume') {
      volume = clamp(volume + action.delta, 0, 100);
      setIndicator(`音量 ${volume}%`);
      render();
      if (persistentController) enqueue(() => persistentController.setVolume(volume));
      else if (!userPaused && !trackTransitioning) scheduleRestart(clock.position());
      return;
    }
    if (action.type === 'offset') {
      activeOffsetMs = trackOffset.adjust(action.deltaMs);
      setIndicator(`当前曲目临时偏移 ${activeOffsetMs} ms`);
      updateSmtc(userPaused ? 'paused' : 'playing');
      render();
      return;
    }
    if (action.type === 'toggle_translation') {
      const hasRomanized = lyrics.some((line) => Boolean(line.romanized));
      if (!hasTranslation && !hasRomanized) return;
      if (showRomanized) {
        showRomanized = false;
        showTranslation = hasTranslation;
      } else if (showTranslation && hasRomanized) {
        showTranslation = false;
        showRomanized = true;
      } else if (showTranslation) {
        showTranslation = false;
      } else if (hasTranslation) {
        showTranslation = true;
      } else {
        showRomanized = true;
      }
      setIndicator(showRomanized ? '音译已开启' : showTranslation ? '翻译已开启' : '翻译已关闭');
      render();
    }
  };

  const handleData = (buffer) => dispatchPlaybackAction(playbackAction(buffer, { playlistOpen, playlistSelection }));

  const abort = () => {
    if (closing) return;
    closing = true;
    invalidateRestart();
    cancelTrackTransition('播放已中断');
    enqueue(async () => {
      if (finished) return;
      finished = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      await stopCurrent();
      rejectCompletion(signal.reason || new DOMException('操作已取消', 'AbortError'));
    });
  };

  let restoreInput = () => {};
  const resizeRefresh = createLatestDebounce(() => {
    if (finished || closing || trackTransitioning || pageTransitionDepth > 0) return;
    if (creditsPlayerTransitionActive()) return;
    void drawHeader(null, { reason: 'resize' }).catch((error) => {
      if (error?.name !== 'AbortError') void logger?.warn('playback_resize_refresh_failed', { error });
    });
  }, 180);
  const resize = () => {
    resizeRefresh.schedule();
  };
  releaseScreen = tty ? acquireTerminalScreen(process.stdout) : () => {};
  try {
    while (['mpv', 'vlc', 'cvlc'].includes(player.command)) {
      let controller;
      const callbacks = {
        onEnd: (_event, generation) => {
          if (!finished && !closing) enqueue(
            () => generation === controller.generation ? handleNaturalEnd() : undefined
          );
        },
        onPauseChange: (paused) => {
          if (!persistentLoaded || finished || closing || trackTransitioning || sessionEnded) return;
          dispatchPlaybackAction({ action: paused ? 'pause' : 'play', source: 'player' });
        },
        onPositionChange: (seconds, _event, generation) => {
          if (!persistentLoaded || finished || closing || trackTransitioning || sessionEnded
              || generation !== controller.generation) return;
          const localPosition = clock.position();
          if (!shouldSyncPlayerPosition(localPosition, seconds)) return;
          const remotePosition = clock.seekTo(Number(seconds) * 1000);
          updateSmtc(userPaused ? 'paused' : 'playing', remotePosition);
          setIndicator(`播放器跳转到 ${formatTime(displayPosition(remotePosition, activeOffsetMs))}`);
          render();
        },
        onError: (error) => {
          if (!finished && !closing) rejectCompletion(error);
        }
      };
      controller = player.command === 'mpv'
        ? createMpvController({ command: player.executable, ...callbacks })
        : createVlcController({ command: player.executable, ...callbacks });
      try {
        await controller.initialize();
        persistentController = controller;
        backendLabel = playerBackendLabel(player.command, { persistent: true });
        break;
      } catch (error) {
        await controller.close();
        void logger?.warn('persistent_player_unavailable', { player: player.command, error });
        if (player.command !== 'mpv' || playerBackend !== 'auto') break;
        player = findPlayer(['vlc', 'cvlc', 'ffplay']);
        if (!player) throw new Error('mpv IPC 初始化失败，且未找到 VLC 或 ffplay 回退播放器。', { cause: error });
      }
    }
    if (!persistentController) backendLabel = playerBackendLabel(player.command, { persistent: false });
    if (tty) {
      const directAnimation = Boolean(easterEggForSong(activeSong)?.directAnimation);
      process.stdout.write(playbackEntrySequence(directAnimation));
      if (directAnimation) {
        restoreInput = setupRawInput(rl, handleData);
        process.stdout.on('resize', resize);
        showCreditsFontRecommendation();
        const transitionController = new AbortController();
        initialEntryTransitionController = transitionController;
        const transitionSignal = signal
          ? AbortSignal.any([signal, transitionController.signal])
          : transitionController.signal;
        try {
          await playDirectCreditsEntryTransition(transitionSignal);
        } catch (error) {
          if (!(closing && transitionController.signal.aborted && error?.name === 'AbortError')) throw error;
        } finally {
          if (initialEntryTransitionController === transitionController) {
            initialEntryTransitionController = null;
          }
        }
        if (closing) return await completion;
      } else {
        await drawHeader(null, { reason: 'initial' });
        restoreInput = setupRawInput(rl, handleData);
        process.stdout.on('resize', resize);
      }
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else {
      await spawnAt(clock.position());
      clock.resume();
      showCreditsFontRecommendation();
      smtcTimer = setInterval(() => {
        if (!finished) {
          updateSmtc(sessionEnded ? 'stopped' : userPaused ? 'paused' : 'playing');
        }
      }, 1000);
      render();
    }
    return await completion;
  } finally {
    finished = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (smtcTimer) clearInterval(smtcTimer);
    invalidateRestart();
    headerAbortController?.abort();
    signal?.removeEventListener('abort', abort);
    process.stdout.removeListener('resize', resize);
    resizeRefresh.cancel();
    flushRenderDiagnostics('playback_end');
    dynamicWriter?.close();
    try {
      await stopCurrent();
      await persistentController?.close();
      if (!retainSmtc) {
        updateSmtc('stopped');
        await smtc.close();
      }
    } finally {
      try { restoreInput(); } catch {}
      if (tty) {
        try { process.stdout.write(`${playbackTerminalModeSequence(false)}\x1b[?25h`); } catch {}
      }
      releaseScreen();
    }
  }
}
