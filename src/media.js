import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import chalk from 'chalk';
import stringWidth from 'string-width';
import supportsTerminalGraphics from 'supports-terminal-graphics';
import { parseLrc } from './lyrics.js';
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
  creditsEasterEggTimeline,
  creditsFontRecommendation,
  easterEggForSong
} from './credits-csf.js';
import { composeCreditsPlayerTransitionRows } from './credits-player-transition.js';

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
  if (playlistOpen && key === '\u001b') return { type: 'close_playlist' };
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

export function lyricPosition(elapsedMs, lyricOffsetMs = 2000) {
  const offset = Number(lyricOffsetMs);
  return displayPosition(elapsedMs, Number.isFinite(offset) ? offset : 2000);
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

export function attachLyricTranslations(originalLines, translatedLines) {
  const translations = new Map();
  for (const line of translatedLines) {
    const texts = translations.get(line.timeMs) || [];
    if (!texts.includes(line.text)) texts.push(line.text);
    translations.set(line.timeMs, texts);
  }
  return originalLines.map((line) => ({
    ...line,
    translation: (translations.get(line.timeMs) || []).filter((text) => text !== line.text).join(' / ')
  }));
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

export function playbackShortcutText({ canFavorite = false, favorited = false } = {}) {
  const base = 'q 返回  空格 暂停/继续  ←/→ 快退/快进  ↑/↓ 音量  Ctrl+↑/↓ 偏移  t 翻译  r 刷新';
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

export function playbackProgressText({ bar, timeText, paused = false, pauseText = '[已暂停]', columns = 80 } = {}) {
  const width = Math.max(1, columns);
  const state = paused ? pauseText : '';
  const full = `${bar}${state ? ` ${state}` : ''} ${timeText}`;
  if (stringWidth(full) <= width) return full;
  if (paused) {
    const compact = `> ${state}`;
    if (stringWidth(compact) <= width) return compact;
    if (stringWidth(state) <= width) return state;
  }
  return truncateText(full, width);
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

export function playbackDynamicRows({ progress, modeRows, shortcutRows, indicatorRow, contentRows, contentBeforeControls = false, availableRows = Infinity }) {
  const ordered = contentBeforeControls
    ? [...contentRows, progress, ...modeRows, ...shortcutRows, indicatorRow]
    : [progress, ...modeRows, ...shortcutRows, indicatorRow, ...contentRows];
  return ordered.slice(0, Math.max(0, availableRows));
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
  indicator,
  playlist,
  playlistOpen,
  playlistSelection,
  playbackModeText,
  currentLyricOnly = false,
  easterEgg = null,
  canFavorite = false,
  favorited = false,
  captureOnly = false
}) {
  const columns = Math.max(1, process.stdout.columns || 80);
  const rows = Math.max(1, process.stdout.rows || 24);
  const startRow = clamp(dynamicRow, 1, rows);
  const availableRows = rows - startRow + 1;
  const timeText = `${formatTime(elapsedMs)} / ${formatTime(durationMs)}`;
  const pauseWidth = paused ? stringWidth(' [已暂停]') : 0;
  const barWidth = clamp(columns - stringWidth(timeText) - pauseWidth - 3, 1, 50);
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
    pauseText: chalk.yellow('[已暂停]'),
    columns
  });
  const modeRows = playbackModeText
    ? playbackPlaylistModeRows({
        randomLabel: playbackModeText.randomLabel,
        loopLabel: playbackModeText.loopLabel,
        playlistOpen: playbackModeText.playlistOpen
      }, columns).map((row) => chalk.magentaBright(row))
    : [];
  const shortcutRows = playbackShortcutRows({ canFavorite, favorited }, columns).map((row) => chalk.cyanBright(row));
  // 快捷键始终保留；控制结果占用快捷键和歌词之间原本的空行。
  const fixedChromeRows = 1 + modeRows.length + 1;
  const visibleShortcutRows = shortcutRows.slice(0, Math.max(0, availableRows - fixedChromeRows));
  const chromeRows = Math.min(availableRows, fixedChromeRows + visibleShortcutRows.length);
  const lyricCapacity = Math.max(0, availableRows - chromeRows);
  let contentRows;
  if (playlistOpen) {
    const title = truncateText(`歌单：${playlist?.name || '当前播放队列'}`, columns);
    const viewport = playlistViewport(playlist?.tracks, playlistSelection, playlist?.currentIndex, Math.max(0, lyricCapacity - 1));
    const trackRows = viewport.rows.map((item) => {
      const prefix = `${item.current ? '▶' : ' '} ${item.selected ? '›' : ' '} `;
      const text = truncateText(`${prefix}${playlistTrackText(item.track, item.index)}`, columns);
      if (item.selected) return chalk.bgWhite.black(text);
      return item.current ? chalk.whiteBright.bold(text) : secondaryText(text);
    });
    contentRows = lyricCapacity > 0
      ? [chalk.cyanBright.bold(title), ...(trackRows.length ? trackRows : [secondaryText('歌单为空')])].slice(0, lyricCapacity)
      : [];
  } else if (easterEgg?.mode === 'credits-csf' && creditsEasterEggShowsFrame(easterEgg)) {
    // 原始 CSF 使用终端默认色，不对上游分镜追加自定义样式。
    contentRows = creditsEasterEggFrame(easterEgg.frameElapsedMs, columns, lyricCapacity);
  } else {
    const displayRows = playbackLyricRows(
      lyrics, lyricElapsedMs, lyricCapacity, showTranslation, columns, currentLyricOnly
    );
    contentRows = displayRows.length
      ? displayRows.map((line, rowIndex) => {
          const text = truncateText(line.text, columns);
          const tone = lyricTone(line);
          if (tone === 'future') return secondaryText(text);
          if (line.translation) return tone === 'current' ? chalk.cyan(text) : chalk.white.dim(text);
          return tone === 'current' ? primaryText(text) : chalk.white(text);
        })
      : lyricCapacity > 0 ? [currentLyricOnly ? '' : secondaryText(truncateText('暂无逐行歌词', columns))] : [];
  }
  const creditsFrameVisible = easterEgg?.mode === 'credits-csf' && creditsEasterEggShowsFrame(easterEgg);
  const outputRows = playbackDynamicRows({
    progress,
    modeRows,
    shortcutRows: visibleShortcutRows,
    indicatorRow: indicator ? chalk.yellow(truncateText(indicator, columns)) : '',
    contentRows,
    contentBeforeControls: creditsFrameVisible && !playlistOpen,
    availableRows
  });
  const position = dynamicAnchored ? '\x1b[u' : `\x1b[${startRow};1H`;
  if (captureOnly) return outputRows;
  process.stdout.write(`${position}\x1b[0J${outputRows.join('\n')}`);
}

function imageBufferFromDataUri(source) {
  const match = source.match(/^data:image\/[^;,]+;base64,(.+)$/i);
  return match ? Buffer.from(match[1], 'base64') : null;
}

async function loadImage(source, signal) {
  const inline = imageBufferFromDataUri(source);
  if (inline) return inline;
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:') throw new Error('只加载 HTTPS 图片');
  const timeoutSignal = AbortSignal.timeout(10000);
  const response = await fetch(parsed, { signal: signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal });
  if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('响应不是图片');
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > 5 * 1024 * 1024) throw new Error('图片超过 5 MiB');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 5 * 1024 * 1024) throw new Error('图片超过 5 MiB');
  return buffer;
}

async function renderAnsiBlocks(buffer, maxWidth, maxRows) {
  const { Jimp, intToRGBA } = await import('jimp');
  const image = await Jimp.read(buffer);
  const scale = Math.min(maxWidth / image.bitmap.width, (maxRows * 2) / image.bitmap.height);
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
      row += `\x1b[38;2;${topColor.r};${topColor.g};${topColor.b}m\x1b[48;2;${bottomColor.r};${bottomColor.g};${bottomColor.b}m▀`;
    }
    rows.push(`${row}\x1b[0m`);
  }
  return rows.join('\n');
}

function playbackMetadataRows(song, backendLabel, columns) {
  const artists = Array.isArray(song.artists) ? song.artists.join('/') : song.artist;
  return [
    chalk.bold(truncateText(song.name || song.title || '', columns)),
    truncateText(`歌手：${artists || '未知'}`, columns),
    truncateText(`专辑：${song.album || '未知'}`, columns),
    truncateText(`播放器：${backendLabel}`, columns),
    truncateText(`ID：${song.id ?? ''}`, columns)
  ];
}

async function buildTextPlaybackHeaderRows(song, { signal, backendLabel, columns, rows }) {
  const coverRows = [];
  if (song.cover && rows >= 10) {
    try {
      const buffer = await loadImage(song.cover, signal);
      const width = Math.max(1, Math.min(52, columns - 2));
      const height = Math.max(1, Math.min(20, Math.floor(rows * 0.36), rows - 8));
      const text = await renderAnsiBlocks(buffer, width, height);
      coverRows.push(...text.split(/\r?\n/));
    } catch {}
  }
  const metadata = playbackMetadataRows(song, backendLabel, columns);
  const metadataCapacity = Math.max(0, rows - coverRows.length - 1);
  return [...coverRows, ...metadata.slice(0, metadataCapacity)];
}

function writeCreditsTransitionRows(entries) {
  const output = entries.map(({ state, text }) => {
    const rendered = state === 'flash-target'
      ? chalk.inverse(chalk.whiteBright(text))
      : state === 'target-preview' ? chalk.whiteBright(text) : text;
    return `${rendered}\x1b[0m\x1b[K`;
  }).join('\n');
  process.stdout.write(`\x1b[H${output}`);

}
function writeTerminalOutput(output) {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
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

export async function tryRenderImage(source, { signal, size = 'detail', shouldRender, protocol = 'auto' } = {}) {
  if (!source || !process.stdout.isTTY || protocol === 'none') return 0;
  const guarded = typeof shouldRender === 'function';
  const current = () => !signal?.aborted && (!guarded || shouldRender());
  try {
    const buffer = await loadImage(source, signal);
    if (!current()) return 0;
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const width = Math.max(1, Math.min(size === 'playback' ? 52 : 56, columns - 2));
    const height = Math.max(1, Math.min(size === 'playback' ? 20 : 22, Math.floor(rows * 0.36), rows - 8));
    const hasChafa = commandExists('chafa');
    const protocols = imageProtocolOrder({
      preference: protocol,
      kitty: supportsTerminalGraphics.stdout.kitty && process.env.TERM_PROGRAM !== 'iTerm.app',
      iterm2: supportsTerminalGraphics.stdout.iterm2,
      sixel: supportsSixelEnvironment(),
      chafa: hasChafa
    });

    for (const protocol of protocols) {
      if (!current()) return 0;
      if (protocol === 'kitty' || protocol === 'iterm2') {
        // terminal-image 的 Kitty 路径可能在 Promise 返回前直接写 stdout，
        // 无法为连续切歌做 generation 校验；可取消的后台封面任务跳过该路径。
        if (guarded) continue;
        try {
          if (await tryNativeGraphics(buffer, width, height, protocol)) return height;
        } catch {}
      }

      if (protocol === 'sixel') {
        try {
          const rendered = spawnSync('chafa', ['--format=sixels', `--size=${width}x${height}`, '-'], {
            input: buffer,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024
          });
          if (rendered.status === 0 && rendered.stdout?.includes(Buffer.from('\x1bP'))) {
            if (!current()) return 0;
            await writeTerminalOutput(rendered.stdout);
            // chafa 已在 SIXEL 结束后输出光标移动。Windows Terminal 还会根据
            // 实际图像像素高度定位光标，额外按请求高度补行会造成双重占位。
            return height;
          }
        } catch {}
      }

      if (protocol === 'symbols') {
        try {
          const rendered = spawnSync('chafa', ['--format=symbols', `--size=${width}x${height}`, '-'], {
            input: buffer,
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 2 * 1024 * 1024
          });
          if (rendered.status === 0 && rendered.stdout?.trim()) {
            const text = rendered.stdout.replace(/\s+$/, '');
            if (!current()) return 0;
            await writeTerminalOutput(`${text}\n`);
            return text.split(/\r?\n/).length;
          }
        } catch {}
      }

      if (protocol === 'ansi') {
        try {
          const text = await renderAnsiBlocks(buffer, width, height);
          if (!current()) return 0;
          await writeTerminalOutput(`${text}\n`);
          return text.split(/\r?\n/).length;
        } catch {}
      }
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function playWithProgress({
  song,
  url,
  durationMs,
  lyricSource = '',
  translatedLyricSource = '',
  lyricOffsetMs = 2000,
  smtcOffsetMs = 0,
  playerBackend = 'auto',
  imageProtocol = 'auto',
  playlist = { name: '', tracks: [], currentIndex: 0 },
  signal,
  logger,
  rl,
  onInterrupt,
  onOffsetChange,
  onTrackChange,
  onFavorite
}) {
  let releaseScreen = () => {};
  await closeRetainedSmtc();
  let player = findPlayer(playerCommandsForBackend(playerBackend));
  if (!player) throw new Error('未找到播放器。请安装 ffplay、mpv 或 VLC 后重试。');
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  let activeSong = song;
  let activeUrl = url;
  let activeDurationMs = durationMs;
  let lyrics = attachLyricTranslations(parseLrc(lyricSource), parseLrc(translatedLyricSource));
  let clock = createPlaybackClock(activeDurationMs);
  // 创建 bridge、下载封面等准备工作不应计入真实播放位置。
  clock.pause();
  let activeOffsetMs = adjustPlaybackOffset(lyricOffsetMs, 0);
  const activeSmtcOffsetMs = Number.isFinite(Number(smtcOffsetMs)) ? Number(smtcOffsetMs) : 0;
  let volume = 100;
  let userPaused = false;
  let hasTranslation = lyrics.some((line) => Boolean(line.translation));
  let showTranslation = hasTranslation;
  let indicator = '';
  let indicatorUntil = 0;
  let favoritePending = false;
  const favoritedSongIds = new Set();
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
    && creditsEasterEggTimeline(displayPosition(clock.position(), activeOffsetMs),
      Math.max(1, process.stdout.rows || 24)).phase.endsWith('-transition')
  );

  const render = () => {
    if (!tty || finished || headerRendering) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const rawElapsedMs = clock.position();
    const elapsedMs = sessionEnded ? activeDurationMs : displayPosition(rawElapsedMs, activeOffsetMs);
    const displayDurationMs = activeDurationMs;
    const lyricElapsedMs = elapsedMs;
    const now = performance.now();
    if (indicator && now >= indicatorUntil) indicator = '';
    const easterEggConfig = easterEggForSong(activeSong);
    const easterEggTimeline = easterEggConfig
      ? creditsEasterEggTimeline(lyricElapsedMs, Math.max(1, process.stdout.rows || 24)) : null;
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
      indicator,
      playlist: playbackPlaylist,
      playlistOpen,
      playlistSelection,
      playbackModeText: playlistTracks.length
        ? { randomLabel: randomLabels[randomMode], loopLabel: loopLabels[loopMode], playlistOpen }
        : '',
      canFavorite: typeof onFavorite === 'function',
      favorited: favoritedSongIds.has(String(activeSong?.id ?? ''))
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
        dynamicRow: 1,
        dynamicAnchored: false,
        currentLyricOnly: true,
        easterEgg: { ...easterEgg, phase: 'animation' },
        captureOnly: true
      });
      const playerDynamicRows = renderDynamic({
        ...renderOptions,
        dynamicRow: stableCreditsHeaderRows.length + 1,
        dynamicAnchored: false,
        currentLyricOnly: Boolean(easterEggConfig?.currentLyricOnly),
        easterEgg: null,
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
      writeCreditsTransitionRows(entries);
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
        process.stdout.write('\x1b[2J\x1b[H\x1b[s');
      }
      renderDynamic({
        ...renderOptions,
        dynamicRow,
        dynamicAnchored,
        currentLyricOnly: Boolean(easterEggConfig?.currentLyricOnly),
        easterEgg: creditsOrdinaryPlayer ? null : easterEgg
      });
    }
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

  let offsetPersistence = Promise.resolve();
  const persistOffset = (value) => {
    offsetPersistence = offsetPersistence
      .then(() => onOffsetChange?.(value))
      .catch((error) => { void logger?.warn('playback_offset_save_failed', { error }); });
  };

  const cancelTrackTransition = (reason = '切歌操作已取消') => {
    trackTransitionController?.abort(new DOMException(reason, 'AbortError'));
  };

  const finish = (reason) => {
    if (closing) return;
    closing = true;
    invalidateRestart();
    cancelTrackTransition('播放已退出');
    enqueue(async () => {
      if (finished) return;
      finished = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      await stopCurrent();
      updateSmtc('stopped');
      resolveCompletion(reason);
    });
  };

  const drawHeader = async () => {
    if (!tty) return;
    headerAbortController?.abort();
    const renderId = ++headerRenderId;
    const controller = new AbortController();
    headerAbortController = controller;
    const headerSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    const songSnapshot = activeSong;
    headerRendering = true;
    dynamicAnchored = false;
    process.stdout.write('\x1b[2J\x1b[H');
    const initialRows = Math.max(1, process.stdout.rows || 24);
    const initialColumns = Math.max(1, process.stdout.columns || 80);
    const creditsConfig = easterEggForSong(songSnapshot);
    const creditsTimeline = creditsConfig ? creditsEasterEggTimeline(
      displayPosition(clock.position(), activeOffsetMs), initialRows) : null;
    if (creditsConfig?.mode === 'credits-csf') {
      creditsTransitionHeaderRows = null;
      creditsPlayerHeaderRows = playbackMetadataRows(songSnapshot, backendLabel, initialColumns)
        .slice(0, Math.max(0, initialRows - 1));
      const creditsOrdinaryPlayer = ['player-intro', 'player'].includes(creditsTimeline?.phase);
      if (creditsOrdinaryPlayer) {
        const preparedRows = await buildTextPlaybackHeaderRows(songSnapshot, {
          signal: headerSignal, backendLabel, columns: initialColumns, rows: initialRows
        });
        if (controller.signal.aborted || renderId !== headerRenderId || finished) return;
        creditsPlayerHeaderRows = preparedRows;
        creditsFullPlayerActive = true;
        const headerOutput = preparedRows.map((row) => `${row}\x1b[0m\x1b[K`).join('\n');
        dynamicRow = Math.min(initialRows, preparedRows.length + 1);
        process.stdout.write(
          `${headerOutput}${headerOutput ? '\n' : ''}\x1b[${dynamicRow};1H\x1b[s`
        );
        dynamicAnchored = true;
        headerRendering = false;
        render();
        return;
      }

      // 两次逐行过渡使用可切分的 ANSI 封面快照；稳定彩蛋阶段将整屏留给 CSF。
      creditsFullPlayerActive = creditsTimeline?.phase === 'egg-transition';
      const prepareCreditsHeader = buildTextPlaybackHeaderRows(songSnapshot, {
        signal: headerSignal, backendLabel, columns: initialColumns, rows: initialRows
      });
      if (creditsTimeline?.phase?.endsWith('-transition')) {
        const preparedRows = await prepareCreditsHeader;
        if (controller.signal.aborted || renderId !== headerRenderId || finished) return;
        creditsPlayerHeaderRows = preparedRows;
      } else {
        void prepareCreditsHeader.then((preparedRows) => {
          if (!controller.signal.aborted && renderId === headerRenderId && !finished
              && String(activeSong?.id ?? '') === String(songSnapshot.id ?? '')) {
            creditsPlayerHeaderRows = preparedRows;
          }
        });
      }
      dynamicRow = 1;
      process.stdout.write('\x1b[s');
      dynamicAnchored = true;
      headerRendering = false;
      render();
      return;
    }
    const coverRows = initialRows >= 10
      ? await tryRenderImage(songSnapshot.cover, {
          signal: headerSignal,
          size: 'playback',
          protocol: imageProtocol,
          shouldRender: () => renderId === headerRenderId && !finished
        })
      : 0;
    if (controller.signal.aborted || renderId !== headerRenderId || finished) return;
    const artists = Array.isArray(songSnapshot.artists) ? songSnapshot.artists.join('/') : songSnapshot.artist;
    const metadata = [
      chalk.bold(truncateText(songSnapshot.name || songSnapshot.title || '', initialColumns)),
      truncateText(`歌手：${artists || '未知'}`, initialColumns),
      truncateText(`专辑：${songSnapshot.album || '未知'}`, initialColumns),
      truncateText(`播放器：${backendLabel}`, initialColumns),
      truncateText(`ID：${songSnapshot.id ?? ''}`, initialColumns)
    ];
    const metadataCapacity = Math.max(0, initialRows - coverRows - 1);
    for (const line of metadata.slice(0, metadataCapacity)) console.log(line);
    dynamicRow = Math.min(initialRows, coverRows + Math.min(metadata.length, metadataCapacity) + 1);
    process.stdout.write('\x1b[s');
    dynamicAnchored = true;
    headerRendering = false;
    render();
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
    const wasPlaying = Boolean(child && !userPaused);
    setIndicator(`正在切换到 ${targetIndex + 1}/${playlistTracks.length}`);
    render();
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
    creditsFullPlayerActive = false;
    creditsPlayerHeaderRows = [];
    creditsTransitionHeaderRows = null;
    activeUrl = next.url;
    activeDurationMs = Math.max(0, Number(next.durationMs ?? next.song.durationMs) || 0);
    lyrics = Array.isArray(next.lyrics) ? next.lyrics : attachLyricTranslations(
      parseLrc(next.lyricSource ?? next.lyrics?.original ?? ''),
      parseLrc(next.translatedLyricSource ?? next.lyrics?.translated ?? '')
    );
    hasTranslation = lyrics.some((line) => Boolean(line.translation));
    showTranslation = hasTranslation;
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
    if (!userPaused) {
      await spawnAt(0);
      clock.resume();
    } else {
      updateSmtc('paused', 0);
    }
    // 新音频先开始播放；封面在可取消的后台任务中绘制，
    // 不占用按键和 SMTC 共用的串行控制队列。
    void drawHeader().catch((error) => {
      if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
    });
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
    if (action.type === 'refresh') {
      setIndicator('页面已刷新');
      if (creditsPlayerTransitionActive()) {
        render();
        return;
      }
      void drawHeader().catch((error) => {
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
      return;
    }
    if (action.type === 'cycle_loop_mode' && playlistTracks.length) {
      loopMode = LOOP_MODES[(LOOP_MODES.indexOf(loopMode) + 1) % LOOP_MODES.length];
      setIndicator(`循环模式：${loopLabels[loopMode]}`);
      updateSmtcControls();
      render();
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
      const nextOffsetMs = adjustPlaybackOffset(activeOffsetMs, action.deltaMs);
      if (nextOffsetMs !== activeOffsetMs) {
        activeOffsetMs = nextOffsetMs;
        persistOffset(nextOffsetMs);
      }
      setIndicator(`播放时间偏移 ${activeOffsetMs} ms`);
      updateSmtc(userPaused ? 'paused' : 'playing');
      render();
      return;
    }
    if (action.type === 'toggle_translation') {
      const next = toggleTranslationState(showTranslation, hasTranslation);
      showTranslation = next.showTranslation;
      setIndicator(next.indicator);
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
    if (finished || closing) return;
    if (creditsPlayerTransitionActive()) return;
    void drawHeader().catch((error) => {
      if (error?.name !== 'AbortError') void logger?.warn('playback_resize_refresh_failed', { error });
    });
  }, 180);
  const resize = () => {
    render();
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
      process.stdout.write(`${playbackTerminalModeSequence(true)}\x1b[?25l\x1b[2J\x1b[H`);
      await drawHeader();
      restoreInput = setupRawInput(rl, handleData);
      process.stdout.on('resize', resize);
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
    try {
      await offsetPersistence;
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
