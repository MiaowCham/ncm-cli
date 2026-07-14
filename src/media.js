import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { currentLyric, parseLrc } from './lyrics.js';

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where.exe' : 'which';
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0;
}

export function findPlayer() {
  const candidates = [
    { command: 'ffplay', args: (url) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', url] },
    { command: 'mpv', args: (url) => ['--no-video', '--really-quiet', url] },
    { command: 'vlc', args: (url) => ['--intf', 'dummy', '--play-and-exit', url] },
    { command: 'cvlc', args: (url) => ['--play-and-exit', url] }
  ];
  return candidates.find((item) => commandExists(item.command)) || null;
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderProgress(elapsed, duration, lyric) {
  const width = 30;
  const ratio = duration ? Math.min(1, elapsed / duration) : 0;
  const filled = Math.round(ratio * width);
  const bar = `${'='.repeat(filled)}${filled < width ? '>' : ''}${' '.repeat(Math.max(0, width - filled - 1))}`;
  const line = `[${bar}] ${formatTime(elapsed)} / ${formatTime(duration)}  ${lyric}`;
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(line.slice(0, process.stdout.columns || 120));
}

export async function playWithProgress({ url, durationMs, lyricSource = '', signal, logger }) {
  const player = findPlayer();
  if (!player) {
    throw new Error('未找到播放器。请安装 ffplay、mpv 或 VLC 后重试；播放链接仍可通过 [u] 获取。');
  }
  const child = spawn(player.command, player.args(url), { stdio: 'ignore', windowsHide: true });
  void logger?.info('player_spawn', { player: player.command, pid: child.pid });
  const lines = parseLrc(lyricSource);
  const startedAt = Date.now();
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });

  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    if (process.stdout.isTTY) renderProgress(elapsed, durationMs, currentLyric(lines, elapsed));
  }, 250);

  let forceTimer = null;
  const abortPlayback = () => {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      child.kill('SIGKILL');
    }, 1000);
  };
  signal?.addEventListener('abort', abortPlayback, { once: true });
  if (signal?.aborted) abortPlayback();

  try {
    await once(child, 'exit');
    if (spawnError) throw spawnError;
    void logger?.info('player_exit', { player: player.command, code: child.exitCode, signal: child.signalCode });
    if (signal?.aborted) throw signal.reason || new DOMException('操作已取消', 'AbortError');
  } finally {
    clearInterval(timer);
    if (forceTimer) clearTimeout(forceTimer);
    signal?.removeEventListener('abort', abortPlayback);
    if (process.stdout.isTTY) {
      renderProgress(Math.min(Date.now() - startedAt, durationMs), durationMs, '');
      process.stdout.write('\n');
    }
  }
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

export async function tryRenderImage(source, { signal } = {}) {
  if (!source || !process.stdout.isTTY) return false;
  try {
    const buffer = await loadImage(source, signal);

    // chafa 的 ANSI/Unicode 输出对 Windows Terminal 与 GNOME Terminal/VTE
    // 最稳妥，因此优先于 Kitty/iTerm 图片协议。
    if (commandExists('chafa')) {
      const rendered = spawnSync('chafa', ['--format=symbols', '--size=40x20', '-'], {
        input: buffer,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024
      });
      if (rendered.status === 0 && rendered.stdout?.trim()) {
        console.log(rendered.stdout);
        return true;
      }
    }

    const { default: terminalImage } = await import('terminal-image');
    console.log(await terminalImage.buffer(buffer, { width: '25%', height: '25%' }));
    return true;
  } catch {
    return false;
  }
}
