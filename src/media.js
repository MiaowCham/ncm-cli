import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import chalk from 'chalk';
import stringWidth from 'string-width';
import supportsTerminalGraphics from 'supports-terminal-graphics';
import { parseLrc } from './lyrics.js';
import { createSmtcBridge } from './smtc.js';
import { hasProcessExited } from './process-state.js';

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

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
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

export function imageProtocolOrder({ nativeGraphics = false, sixel = false, chafa = false } = {}) {
  const order = [];
  if (nativeGraphics) order.push('native');
  if (sixel && chafa) order.push('sixel');
  if (chafa) order.push('symbols');
  order.push('ansi');
  return order;
}

export function findPlayer() {
  const candidates = ['ffplay', 'mpv', 'vlc', 'cvlc'].map((command) => ({
    command,
    args: (url, seconds, volume) => playerArguments(command, url, seconds, volume)
  }));
  return candidates.find((item) => commandExists(item.command)) || null;
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

export function nextRefreshDelay(elapsedMs, lyricLines, paused = false, lyricOffsetMs = 0) {
  if (paused) return 1000;
  const toNextSecond = 1000 - (Math.floor(elapsedMs) % 1000 || 0);
  const lyricElapsedMs = lyricPosition(elapsedMs, lyricOffsetMs);
  const nextLyric = lyricLines.find((line) => line.timeMs > lyricElapsedMs);
  const toNextLyric = nextLyric ? nextLyric.timeMs - lyricElapsedMs : Infinity;
  return clamp(Math.min(toNextSecond, toNextLyric), 20, 1000);
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

/** 按终端显示宽度换行；宽字符不会被拆成半个单元格。 */
export function wrapTerminalText(text, width) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const rows = [];
  let row = '';
  for (const character of String(text ?? '')) {
    if (character === '\n') {
      rows.push(row);
      row = '';
      continue;
    }
    const characterWidth = stringWidth(character);
    if (row && stringWidth(row) + characterWidth > safeWidth) {
      rows.push(row.trimEnd());
      row = '';
    }
    // 极窄终端遇到比一列更宽的字符时仍应保留字符，而不是死循环或丢失。
    row += character;
  }
  if (row || !rows.length) rows.push(row.trimEnd());
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

export function playbackLyricRows(lines, elapsedMs, capacity, showTranslation) {
  if (capacity <= 0) return [];
  const visible = lyricViewport(lines, elapsedMs, capacity);
  const rowsFor = (line, includeTranslation = true) => {
    const rows = [{ text: line.text, played: line.played, current: line.current, translation: false }];
    if (includeTranslation && showTranslation && line.translation) {
      rows.push({ text: line.translation, played: line.played, current: line.current, translation: true });
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

export function playbackShortcutText({ playlistOpen = false, hasPlaylist = false } = {}) {
  if (playlistOpen && hasPlaylist) {
    return 'p/Esc 关闭歌单  ↑/↓ 选择  Enter 播放  Ctrl+←/→ 上/下一首  Ctrl+↑/↓ 偏移  r 刷新';
  }
  const base = 'q 返回  空格 暂停/继续  ←/→ 快退/快进  ↑/↓ 音量  Ctrl+↑/↓ 偏移  t 翻译  r 刷新';
  return hasPlaylist ? `${base}  p 歌单  Ctrl+←/→ 切歌` : base;
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
  playlistSelection
}) {
  const columns = Math.max(1, process.stdout.columns || 80);
  const rows = Math.max(1, process.stdout.rows || 24);
  const startRow = clamp(dynamicRow, 1, rows);
  const availableRows = rows - startRow + 1;
  const timeText = `${formatTime(elapsedMs)} / ${formatTime(durationMs)}`;
  const barWidth = clamp(columns - stringWidth(timeText) - 5, 1, 50);
  const ratio = durationMs ? clamp(elapsedMs / durationMs, 0, 1) : 0;
  const filled = Math.round(ratio * barWidth);
  const bar = `${'='.repeat(filled)}${filled < barWidth ? '>' : ''}${' '.repeat(Math.max(0, barWidth - filled - 1))}`;
  const progressText = truncateText(`[${bar}] ${timeText}${paused ? '  [已暂停]' : ''}`, columns);
  const progress = paused ? chalk.yellow(progressText) : progressText;
  const shortcutText = playbackShortcutText({ playlistOpen, hasPlaylist: Boolean(playlist?.tracks?.length) });
  const indicatorRows = indicator
    ? [chalk.yellow(truncateText(indicator, columns))]
    : playbackShortcutRows({ playlistOpen, hasPlaylist: Boolean(playlist?.tracks?.length) }, columns)
      .map((row) => chalk.cyanBright(row));
  // 进度、可变行数快捷键提示和其后空行共同占用播放区。
  const chromeRows = 1 + Math.min(indicatorRows.length, Math.max(0, availableRows - 1))
    + (availableRows > 1 + indicatorRows.length ? 1 : 0);
  const lyricCapacity = Math.max(0, availableRows - chromeRows);
  let contentRows;
  if (playlistOpen) {
    const title = truncateText(`歌单：${playlist?.name || '当前播放队列'}`, columns);
    const viewport = playlistViewport(playlist?.tracks, playlistSelection, playlist?.currentIndex, Math.max(0, lyricCapacity - 1));
    const trackRows = viewport.rows.map((item) => {
      const prefix = `${item.current ? '▶' : ' '} ${item.selected ? '›' : ' '} `;
      const text = truncateText(`${prefix}${playlistTrackText(item.track, item.index)}`, columns);
      if (item.selected) return chalk.bgWhite.black(text);
      return item.current ? chalk.whiteBright.bold(text) : chalk.gray(text);
    });
    contentRows = lyricCapacity > 0
      ? [chalk.cyanBright.bold(title), ...(trackRows.length ? trackRows : [chalk.gray('歌单为空')])].slice(0, lyricCapacity)
      : [];
  } else {
    const displayRows = playbackLyricRows(lyrics, lyricElapsedMs, lyricCapacity, showTranslation);
    contentRows = displayRows.length
      ? displayRows.map((line) => {
          const text = truncateText(line.text, columns);
          const tone = lyricTone(line);
          if (tone === 'future') return chalk.gray(text);
          if (line.translation) return tone === 'current' ? chalk.cyan(text) : chalk.white.dim(text);
          return tone === 'current' ? chalk.whiteBright.bold(text) : chalk.white(text);
        })
      : lyricCapacity > 0 ? [chalk.gray(truncateText('暂无逐行歌词', columns))] : [];
  }
  const outputRows = [progress];
  outputRows.push(...indicatorRows.slice(0, Math.max(0, availableRows - 1)));
  if (outputRows.length < availableRows) outputRows.push('');
  outputRows.push(...contentRows);
  const position = dynamicAnchored ? '\x1b[u' : `\x1b[${startRow};1H`;
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

function writeTerminalOutput(output) {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve());
  });
}

async function tryNativeGraphics(buffer, width, height) {
  const kitty = supportsTerminalGraphics.stdout.kitty && process.env.TERM_PROGRAM !== 'iTerm.app';
  const iterm2 = supportsTerminalGraphics.stdout.iterm2;
  if (!kitty && !iterm2) return false;
  const { default: terminalImage } = await import('terminal-image');
  const text = await terminalImage.buffer(buffer, { width, height, preserveAspectRatio: true });
  const usedNativeProtocol = (kitty && text === '') || (iterm2 && typeof text === 'string' && text.includes('\x1b]1337;File='));
  if (!usedNativeProtocol) return false;
  if (text) await writeTerminalOutput(text);
  // Kitty/iTerm 图像本身不会可靠地下移文本光标，显式预留单元格行。
  await writeTerminalOutput('\n'.repeat(height));
  return true;
}

export async function tryRenderImage(source, { signal, size = 'detail', shouldRender } = {}) {
  if (!source || !process.stdout.isTTY) return 0;
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
    const nativeGraphics = supportsTerminalGraphics.stdout.kitty || supportsTerminalGraphics.stdout.iterm2;
    const protocols = imageProtocolOrder({
      nativeGraphics,
      sixel: supportsSixelEnvironment(),
      chafa: hasChafa
    });

    for (const protocol of protocols) {
      if (!current()) return 0;
      if (protocol === 'native') {
        // terminal-image 的 Kitty 路径可能在 Promise 返回前直接写 stdout，
        // 无法为连续切歌做 generation 校验；可取消的后台封面任务跳过该路径。
        if (guarded) continue;
        try {
          if (await tryNativeGraphics(buffer, width, height)) return height;
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
  playlist = { name: '', tracks: [], currentIndex: 0 },
  signal,
  logger,
  rl,
  onInterrupt,
  onOffsetChange,
  onTrackChange
}) {
  await closeRetainedSmtc();
  const player = findPlayer();
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
  const playlistTracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  let playlistCurrentIndex = playlistTracks.length
    ? clamp(Math.floor(Number(playlist?.currentIndex) || 0), 0, playlistTracks.length - 1)
    : -1;
  const playbackPlaylist = { name: playlist?.name || '', tracks: playlistTracks, currentIndex: playlistCurrentIndex };
  let playlistOpen = false;
  let playlistSelection = playlistCurrentIndex >= 0 ? playlistCurrentIndex : 0;
  let child = null;
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
    canPrevious: playlistCurrentIndex > 0,
    canNext: playlistCurrentIndex >= 0 && playlistCurrentIndex < playlistTracks.length - 1
  });

  const updateSmtc = (status, rawPositionMs = clock.position()) => {
    const timeline = smtcTimeline(rawPositionMs, activeDurationMs, activeOffsetMs + activeSmtcOffsetMs);
    return smtc.updatePlayback({ status, ...timeline });
  };

  const spawnAt = (positionMs) => {
    const instance = spawn(player.command, player.args(activeUrl, positionMs / 1000, volume), { stdio: 'ignore', windowsHide: true });
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
        enqueue(() => handleNaturalEnd());
      }
    });
  };

  const stopCurrent = async () => {
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
      spawnAt(finalPosition);
      clock.resume();
    }
  };

  const render = () => {
    if (!tty || finished || headerRendering) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const rawElapsedMs = clock.position();
    const elapsedMs = sessionEnded ? activeDurationMs : displayPosition(rawElapsedMs, activeOffsetMs);
    const displayDurationMs = activeDurationMs;
    const lyricElapsedMs = elapsedMs;
    const now = performance.now();
    if (indicator && now >= indicatorUntil) indicator = '';
    renderDynamic({
      elapsedMs,
      lyricElapsedMs,
      durationMs: displayDurationMs,
      paused: userPaused,
      lyrics,
      dynamicRow,
      dynamicAnchored,
      showTranslation,
      indicator,
      playlist: playbackPlaylist,
      playlistOpen,
      playlistSelection
    });
    const indicatorDelay = indicator ? Math.max(20, indicatorUntil - now) : Infinity;
    refreshTimer = setTimeout(render, Math.min(nextRefreshDelay(rawElapsedMs, lyrics, userPaused, activeOffsetMs), indicatorDelay));
  };

  const setIndicator = (text) => {
    indicator = text;
    indicatorUntil = performance.now() + 1200;
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
    const coverRows = initialRows >= 10
      ? await tryRenderImage(songSnapshot.cover, {
          signal: headerSignal,
          size: 'playback',
          shouldRender: () => renderId === headerRenderId && !finished
        })
      : 0;
    if (controller.signal.aborted || renderId !== headerRenderId || finished) return;
    const artists = Array.isArray(songSnapshot.artists) ? songSnapshot.artists.join('/') : songSnapshot.artist;
    const metadata = [
      chalk.bold(truncateText(songSnapshot.name || songSnapshot.title || '', initialColumns)),
      truncateText(`歌手：${artists || '未知'}`, initialColumns),
      truncateText(`专辑：${songSnapshot.album || '未知'}`, initialColumns),
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
          spawnAt(oldPosition);
          clock.resume();
        }
        return false;
      }
      invalidateRestart();
      if (closing) return transitionCancelled;
      if (!next?.url || !next?.song) {
        setIndicator('目标歌曲暂时无法播放');
        if (cause !== 'natural' && !userPaused) {
          spawnAt(oldPosition);
          clock.resume();
        }
        return false;
      }
    }

    const resolvedIndex = Number.isInteger(next.index)
      ? clamp(next.index, 0, playlistTracks.length - 1)
      : targetIndex;
    activeSong = next.song;
    activeUrl = next.url;
    activeDurationMs = Math.max(0, Number(next.durationMs ?? next.song.durationMs) || 0);
    lyrics = Array.isArray(next.lyrics) ? next.lyrics : attachLyricTranslations(
      parseLrc(next.lyricSource ?? next.lyrics?.original ?? ''),
      parseLrc(next.translatedLyricSource ?? next.lyrics?.translated ?? '')
    );
    hasTranslation = lyrics.some((line) => Boolean(line.translation));
    showTranslation = hasTranslation;
    playlistCurrentIndex = resolvedIndex;
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
      spawnAt(0);
      clock.resume();
    } else {
      updateSmtc('paused', 0);
    }
    // 新音频先开始播放；封面在可取消的后台任务中绘制，
    // 不占用按键和 SMTC 共用的串行控制队列。
    void drawHeader().catch((error) => {
      if (error?.name !== 'AbortError') void logger?.warn('playback_header_failed', { error });
    });
    setIndicator(userPaused
      ? `已暂停 ${resolvedIndex + 1}/${playlistTracks.length}`
      : `正在播放 ${resolvedIndex + 1}/${playlistTracks.length}`);
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
    if (playlistTracks.length && playlistCurrentIndex < playlistTracks.length - 1) {
      // 自然连播时跳过临时不可用的歌曲，直到找到下一首可播放曲目。
      userPaused = false;
      for (let targetIndex = playlistCurrentIndex + 1; targetIndex < playlistTracks.length; targetIndex += 1) {
        const result = await transitionTo(targetIndex, 'natural');
        if (result === true || result === transitionCancelled) return;
        if (finished) return;
        if (userPaused) break;
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
        const delta = type === 'playlist_previous' ? -1 : 1;
        const immediateTarget = playlistCurrentIndex + delta;
        if (immediateTarget < 0 || immediateTarget >= playlistTracks.length) return;
        cancelTrackTransition('切歌目标已更新');
        invalidateRestart();
        enqueue(() => {
          const targetIndex = playlistCurrentIndex + delta;
          if (targetIndex < 0 || targetIndex >= playlistTracks.length) return false;
          return transitionTo(targetIndex, 'control');
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
    if (action.type === 'toggle_pause' || action.action === 'play' || action.action === 'pause') {
      if (sessionEnded && (action.action === 'play' || action.type === 'toggle_pause')) {
        enqueue(async () => {
          if (closing) return;
          userPaused = false;
          clock.seekTo(0);
          spawnAt(0);
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
        if (!trackTransitioning) enqueue(() => stopCurrent());
      } else if (shouldPlay && userPaused) {
        userPaused = false;
        if (trackTransitioning) {
          setIndicator('切歌后继续播放');
          render();
        } else {
          enqueue(async () => {
            if (closing) return;
            const resumeAt = clock.position();
            spawnAt(resumeAt);
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
      if (!userPaused) scheduleRestart(seekTo);
      else updateSmtc('paused', seekTo);
      return;
    }
    if (action.type === 'volume') {
      volume = clamp(volume + action.delta, 0, 100);
      setIndicator(`音量 ${volume}%`);
      render();
      if (!userPaused && !trackTransitioning) scheduleRestart(clock.position());
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
  const resize = () => render();
  try {
    if (tty) {
      process.stdout.write(`\x1b[?1049h${playbackTerminalModeSequence(true)}\x1b[?25l\x1b[2J\x1b[H`);
      await drawHeader();
      restoreInput = setupRawInput(rl, handleData);
      process.stdout.on('resize', resize);
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else {
      spawnAt(clock.position());
      clock.resume();
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
    try {
      await offsetPersistence;
      await stopCurrent();
      if (!retainSmtc) {
        updateSmtc('stopped');
        await smtc.close();
      }
    } finally {
      try { restoreInput(); } catch {}
      if (tty) {
        try { process.stdout.write(`${playbackTerminalModeSequence(false)}\x1b[?25h\x1b[?1049l`); } catch {}
      }
    }
  }
}
