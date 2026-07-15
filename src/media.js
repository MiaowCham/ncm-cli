import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { parseLrc } from './lyrics.js';

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

export function findPlayer() {
  const candidates = ['ffplay', 'mpv', 'vlc', 'cvlc'].map((command) => ({
    command,
    args: (url, seconds) => playerArguments(command, url, seconds)
  }));
  return candidates.find((item) => commandExists(item.command)) || null;
}

export function playerArguments(command, url, seconds) {
  if (command === 'ffplay') return ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', String(seconds), url];
  if (command === 'mpv') return ['--no-video', '--really-quiet', `--start=${seconds}`, url];
  if (command === 'vlc') return ['--intf', 'dummy', '--play-and-exit', `--start-time=${seconds}`, url];
  if (command === 'cvlc') return ['--play-and-exit', `--start-time=${seconds}`, url];
  throw new Error(`不支持的播放器：${command}`);
}

export function playbackAction(buffer) {
  const key = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  if (key.includes('\u0003')) return { type: 'interrupt' };
  if (/q/i.test(key)) return { type: 'quit' };
  if (key === ' ') return { type: 'toggle_pause' };
  if (key.includes('\u001b[D')) return { type: 'seek', deltaMs: -5000 };
  if (key.includes('\u001b[C')) return { type: 'seek', deltaMs: 5000 };
  return { type: 'ignore' };
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
    }
  };
}

export function nextRefreshDelay(elapsedMs, lyricLines, paused = false) {
  if (paused) return 1000;
  const toNextSecond = 1000 - (Math.floor(elapsedMs) % 1000 || 0);
  const nextLyric = lyricLines.find((line) => line.timeMs > elapsedMs);
  const toNextLyric = nextLyric ? nextLyric.timeMs - elapsedMs : Infinity;
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

export function lyricViewport(lines, elapsedMs, capacity) {
  if (!lines.length || capacity <= 0) return [];
  let currentIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].timeMs > elapsedMs) break;
    currentIndex = index;
  }
  const playedSlots = Math.max(1, Math.floor(capacity / 3));
  const start = Math.max(0, currentIndex - playedSlots + 1);
  return lines.slice(start, start + capacity).map((line, offset) => ({
    ...line,
    played: start + offset <= currentIndex,
    current: start + offset === currentIndex
  }));
}

async function waitForExit(child, timeoutMs = 1500) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([
    once(child, 'exit').catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function terminatePlayer(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(killer, 'exit').catch(() => {});
    if (child.exitCode === null) child.kill();
    await waitForExit(child);
    return;
  }
  child.kill('SIGTERM');
  await waitForExit(child, 1000);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(child, 500);
  }
}

function setupRawInput(rl, onData) {
  const stream = process.stdin;
  if (!process.stdin.isTTY || typeof stream.setRawMode !== 'function') return () => {};
  const wasRaw = Boolean(stream.isRaw);
  const wasPaused = stream.isPaused();
  rl?.pause();
  const previousDataListeners = stream.listeners('data');
  for (const listener of previousDataListeners) stream.removeListener('data', listener);
  stream.on('data', onData);
  stream.setRawMode(true);
  stream.resume();
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

function renderDynamic({ elapsedMs, durationMs, paused, lyrics, dynamicRow }) {
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
  const shortcuts = chalk.cyan(truncateText('q 停止并返回  空格 暂停/继续  ←/→ 后退/前进 5 秒', columns));
  const lyricCapacity = Math.max(0, availableRows - 2);
  const visible = lyricViewport(lyrics, elapsedMs, lyricCapacity);
  const lyricRows = visible.length
    ? visible.map((line) => {
        const text = truncateText(line.text, columns);
        if (line.current) return chalk.whiteBright.bold(text);
        return line.played ? chalk.white(text) : chalk.gray(text);
      })
    : lyricCapacity > 0 ? [chalk.gray(truncateText('暂无逐行歌词', columns))] : [];
  const outputRows = [progress];
  if (availableRows > 1) outputRows.push(shortcuts);
  outputRows.push(...lyricRows.slice(0, Math.max(0, availableRows - outputRows.length)));
  process.stdout.write(`\x1b[${startRow};1H\x1b[0J${outputRows.join('\n')}`);
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

export async function tryRenderImage(source, { signal, size = 'detail' } = {}) {
  if (!source || !process.stdout.isTTY) return 0;
  try {
    const buffer = await loadImage(source, signal);
    const columns = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const width = Math.max(1, Math.min(size === 'playback' ? 52 : 56, columns - 2));
    const height = Math.max(1, Math.min(size === 'playback' ? 20 : 22, Math.floor(rows * 0.36), rows - 8));

    if (commandExists('chafa')) {
      const rendered = spawnSync('chafa', ['--format=symbols', `--size=${width}x${height}`, '-'], {
        input: buffer,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      });
      if (rendered.status === 0 && rendered.stdout?.trim()) {
        const text = rendered.stdout.replace(/\s+$/, '');
        process.stdout.write(`${text}\n`);
        return text.split(/\r?\n/).length;
      }
    }

    // ANSI 24-bit 半块字符无需专用图片协议，Windows Terminal 和
    // GNOME Terminal/VTE 均可直接显示，因此作为内置主降级路径。
    try {
      const text = await renderAnsiBlocks(buffer, width, height);
      process.stdout.write(`${text}\n`);
      return text.split(/\r?\n/).length;
    } catch {}

    const { default: terminalImage } = await import('terminal-image');
    const text = await terminalImage.buffer(buffer, { width: '35%', height: '35%' });
    const renderedRows = text.split(/\r?\n/).length;
    const reservedRows = Math.max(renderedRows, height);
    process.stdout.write(`${text}\n${'\n'.repeat(Math.max(0, reservedRows - renderedRows))}`);
    return reservedRows;
  } catch {
    return 0;
  }
}

export async function playWithProgress({ song, url, durationMs, lyricSource = '', signal, logger, rl, onInterrupt }) {
  const player = findPlayer();
  if (!player) throw new Error('未找到播放器。请安装 ffplay、mpv 或 VLC 后重试。');
  const tty = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const lyrics = parseLrc(lyricSource);
  const clock = createPlaybackClock(durationMs);
  let child = null;
  let finished = false;
  let refreshTimer = null;
  let dynamicRow = 1;
  const intentionalStops = new WeakSet();
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const spawnAt = (positionMs) => {
    const instance = spawn(player.command, player.args(url, positionMs / 1000), { stdio: 'ignore', windowsHide: true });
    child = instance;
    void logger?.info('player_spawn', { player: player.command, pid: instance.pid, positionMs });
    instance.once('error', (error) => {
      if (!finished && !intentionalStops.has(instance)) rejectCompletion(error);
    });
    instance.once('exit', (code, exitSignal) => {
      void logger?.info('player_exit', { player: player.command, code, signal: exitSignal });
      if (!finished && child === instance && !intentionalStops.has(instance)) {
        finished = true;
        resolveCompletion('ended');
      }
    });
  };

  const stopCurrent = async () => {
    const instance = child;
    child = null;
    if (!instance || instance.exitCode !== null) return;
    intentionalStops.add(instance);
    await terminatePlayer(instance);
  };

  const render = () => {
    if (!tty || finished) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    const elapsedMs = clock.position();
    renderDynamic({ elapsedMs, durationMs, paused: clock.paused, lyrics, dynamicRow });
    refreshTimer = setTimeout(render, nextRefreshDelay(elapsedMs, lyrics, clock.paused));
  };

  let operationQueue = Promise.resolve();
  const enqueue = (operation) => {
    operationQueue = operationQueue.then(() => finished ? undefined : operation()).then(render).catch((error) => {
      if (!finished) {
        finished = true;
        rejectCompletion(error);
      }
    });
  };

  const finish = (reason) => enqueue(async () => {
    if (finished) return;
    finished = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    await stopCurrent();
    resolveCompletion(reason);
  });

  const handleData = (buffer) => {
    const action = playbackAction(buffer);
    if (action.type === 'interrupt') {
      onInterrupt?.();
      return;
    }
    if (action.type === 'quit') {
      finish('quit');
      return;
    }
    if (action.type === 'toggle_pause') {
      enqueue(async () => {
        if (clock.paused) {
          const resumeAt = clock.resume();
          spawnAt(resumeAt);
        } else {
          clock.pause();
          await stopCurrent();
        }
      });
      return;
    }
    if (action.type === 'seek') {
      enqueue(async () => {
        const seekTo = clock.seek(action.deltaMs);
        if (!clock.paused) {
          await stopCurrent();
          spawnAt(seekTo);
        }
      });
    }
  };

  const abort = () => enqueue(async () => {
    if (finished) return;
    finished = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    await stopCurrent();
    rejectCompletion(signal.reason || new DOMException('操作已取消', 'AbortError'));
  });

  let restoreInput = () => {};
  const resize = () => render();
  try {
    if (tty) {
      process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
      const initialRows = Math.max(1, process.stdout.rows || 24);
      const initialColumns = Math.max(1, process.stdout.columns || 80);
      const coverRows = initialRows >= 10
        ? await tryRenderImage(song.cover, { signal, size: 'playback' })
        : 0;
      const metadata = [
        chalk.bold(truncateText(song.name, initialColumns)),
        truncateText(`歌手：${song.artists.join('/') || '未知'}`, initialColumns),
        truncateText(`专辑：${song.album}`, initialColumns),
        truncateText(`ID：${song.id}`, initialColumns)
      ];
      const metadataCapacity = Math.max(0, initialRows - coverRows - 1);
      for (const line of metadata.slice(0, metadataCapacity)) console.log(line);
      dynamicRow = Math.min(initialRows, coverRows + Math.min(metadata.length, metadataCapacity) + 1);
      restoreInput = setupRawInput(rl, handleData);
      process.stdout.on('resize', resize);
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else {
      spawnAt(clock.position());
      render();
    }
    return await completion;
  } finally {
    finished = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    signal?.removeEventListener('abort', abort);
    process.stdout.removeListener('resize', resize);
    await stopCurrent();
    restoreInput();
    if (tty) process.stdout.write('\x1b[?25h\x1b[?1049l');
  }
}
