import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasProcessExited } from './process-state.js';

const PROTOCOL_VERSION = 1;
const DEFAULT_READY_TIMEOUT_MS = 3000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1000;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 15000;
const CONTROL_ACTIONS = new Set([
  'play',
  'pause',
  'stop',
  'seek_absolute',
  'seek_relative',
  'fast_forward',
  'rewind',
  'previous',
  'next'
]);

function log(logger, level, event, data = {}) {
  try { void logger?.[level]?.(event, data); } catch {}
}

function noOpBridge(sessionId = '') {
  return {
    available: false,
    sessionId,
    setMetadata: async () => false,
    updateControls: () => false,
    updatePlayback: () => false,
    close: async () => {}
  };
}

function finiteInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : fallback;
}

function httpsUri(value) {
  if (!value) return undefined;
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function metadataFrom(song = {}, durationMs = 0, coverPath, overrides = {}) {
  const normalizedOverrides = {
    ...overrides,
    ...(overrides.title == null && overrides.name != null ? { title: overrides.name } : {}),
    ...(overrides.trackId == null && overrides.id != null ? { trackId: overrides.id } : {})
  };
  const source = { ...song, ...normalizedOverrides };
  const artists = Array.isArray(source.artists) ? source.artists.join('/') : source.artist;
  const metadata = {
    trackId: String(source.trackId ?? source.id ?? ''),
    title: String(source.title ?? source.name ?? ''),
    artist: String(artists ?? ''),
    album: String(source.album ?? ''),
    durationMs: finiteInteger(source.durationMs, finiteInteger(durationMs))
  };
  const localCover = source.coverPath ?? coverPath;
  if (typeof localCover === 'string' && path.isAbsolute(localCover)) metadata.coverPath = localCover;
  const remoteCover = httpsUri(source.coverUri ?? source.cover);
  if (remoteCover) metadata.coverUri = remoteCover;
  return metadata;
}

function helperSpec(helperCommand) {
  if (Array.isArray(helperCommand) && helperCommand.length) {
    return { command: helperCommand[0], args: helperCommand.slice(1) };
  }
  if (helperCommand && typeof helperCommand === 'object') {
    return { command: helperCommand.command, args: helperCommand.args || [] };
  }
  if (typeof helperCommand === 'string' && helperCommand) return { command: helperCommand, args: [] };
  if (process.env.NCM_SMTC_HELPER) return { command: process.env.NCM_SMTC_HELPER, args: [] };
  const runtime = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  const root = fileURLToPath(new URL('../native/smtc-bridge/', import.meta.url));
  const candidates = [
    path.join(root, 'publish', runtime, 'ncm-cli-smtc-bridge.exe'),
    path.join(root, 'ncm-cli-smtc-bridge.exe'),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate)) || candidates[0];
  return { command: executable, args: [] };
}

export function hasSmtcHelper({ platform = process.platform } = {}) {
  if (platform !== 'win32') return false;
  if (process.env.NCM_SMTC_HELPER) return true;
  return existsSync(helperSpec().command);
}

function waitForChildExit(child, timeoutMs) {
  if (hasProcessExited(child)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      child.removeListener('exit', done);
      child.removeListener('close', done);
      resolve();
    }
    child.once('exit', done);
    child.once('close', done);
  });
}

/**
 * 创建 Windows SMTC 的容错桥接。helper 的 stdout 必须只输出 NDJSON 协议消息。
 * 非 Windows 或 helper 不可用时返回同接口的 no-op bridge。
 */
export async function createSmtcBridge({
  song = {},
  durationMs = song.durationMs || 0,
  coverPath,
  logger,
  onControl = () => {},
  helperCommand,
  platform = process.platform,
  spawnImpl = spawn,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  playlistControls,
  hasPlaylist,
  canPrevious,
  canNext,
  mode = 'smtc-only',
  onPlayerEvent = () => {},
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  sessionId = randomUUID()
} = {}) {
  if (platform !== 'win32') return noOpBridge(sessionId);

  const spec = helperSpec(helperCommand);
  let child;
  try {
    child = spawnImpl(spec.command, spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
  } catch (error) {
    log(logger, 'warn', 'smtc_spawn_failed', { error });
    return noOpBridge(sessionId);
  }

  let alive = true;
  let ready = false;
  let closed = false;
  let revision = 0;
  let commandId = 0;
  let generation = 0;
  let buffered = Buffer.alloc(0);
  let droppingOversizedLine = false;
  const requestIds = new Set();
  const requestOrder = [];
  const pendingCommands = new Map();

  const rejectPendingCommands = (error) => {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingCommands.clear();
  };

  const markUnavailable = (reason, error) => {
    if (!alive) return;
    alive = false;
    ready = false;
    rejectPendingCommands(error instanceof Error ? error : new Error(`MediaPlayer helper 不可用：${reason}`));
    log(logger, 'warn', 'smtc_unavailable', { reason, error });
  };

  const write = (message, requireReady = true) => {
    if (!alive || closed || (requireReady && !ready) || !child.stdin?.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify({ v: PROTOCOL_VERSION, sessionId, ...message })}\n`, (error) => {
        if (error) markUnavailable('stdin_write_failed', error);
      });
      return true;
    } catch (error) {
      markUnavailable('stdin_write_failed', error);
      return false;
    }
  };

  const playlistEnabled = Boolean(playlistControls ?? hasPlaylist);
  let currentControls = {
    previous: typeof canPrevious === 'boolean' ? canPrevious : playlistEnabled,
    next: typeof canNext === 'boolean' ? canNext : playlistEnabled
  };

  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  const finishStartup = (success) => {
    if (!resolveReady) return;
    const resolve = resolveReady;
    resolveReady = null;
    resolve(success);
  };

  const handleMessage = (message) => {
    if (!message || message.v !== PROTOCOL_VERSION || message.sessionId !== sessionId) return;
    if (message.type === 'ready') {
      ready = true;
      finishStartup(true);
      return;
    }
    if (message.type === 'error' && !ready) {
      log(logger, 'warn', 'smtc_initialize_failed', { error: message.message });
      finishStartup(false);
      return;
    }
    if ((message.type === 'ack' || message.type === 'error') && message.commandId != null) {
      const pending = pendingCommands.get(String(message.commandId));
      if (!pending) return;
      pendingCommands.delete(String(message.commandId));
      clearTimeout(pending.timer);
      if (message.type === 'error') pending.reject(new Error(message.message || `${pending.command} 命令失败`));
      else pending.resolve(message);
      return;
    }
    if (message.type === 'player_event' && mode === 'media-player') {
      const eventGeneration = Number.isInteger(message.generation) ? message.generation : generation;
      try { onPlayerEvent(message, eventGeneration); }
      catch (error) { log(logger, 'warn', 'media_player_event_failed', { event: message.event, error }); }
      return;
    }
    if (message.type !== 'control' || !ready || !CONTROL_ACTIONS.has(message.action)) return;
    if (!['string', 'number'].includes(typeof message.requestId)) return;
    const requestId = String(message.requestId);
    if (requestIds.has(requestId)) return;
    requestIds.add(requestId);
    requestOrder.push(requestId);
    if (requestOrder.length > 1024) requestIds.delete(requestOrder.shift());
    const control = { action: message.action };
    if (message.action.startsWith('seek_')) {
      const position = Number(message.positionMs ?? message.deltaMs);
      if (!Number.isFinite(position)) return;
      if (message.action === 'seek_absolute') control.positionMs = Math.max(0, Math.round(position));
      else control.deltaMs = Math.round(position);
    }
    log(logger, 'info', 'smtc_control_received', { action: message.action, requestId });
    try {
      const result = onControl(control);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => log(logger, 'warn', 'smtc_control_failed', { action: message.action, error }));
      }
    } catch (error) {
      log(logger, 'warn', 'smtc_control_failed', { action: message.action, error });
    }
  };

  const consumeLine = (line) => {
    if (line.length > maxLineBytes) {
      log(logger, 'warn', 'smtc_protocol_line_too_long', { bytes: line.length });
      return;
    }
    const text = line.toString('utf8').trim();
    if (!text) return;
    try { handleMessage(JSON.parse(text)); }
    catch (error) { log(logger, 'warn', 'smtc_protocol_invalid_json', { error }); }
  };

  const onData = (chunk) => {
    let incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (droppingOversizedLine) {
      const newline = incoming.indexOf(0x0a);
      if (newline < 0) return;
      incoming = incoming.subarray(newline + 1);
      droppingOversizedLine = false;
    }
    buffered = Buffer.concat([buffered, incoming]);
    let newline;
    while ((newline = buffered.indexOf(0x0a)) >= 0) {
      consumeLine(buffered.subarray(0, newline));
      buffered = buffered.subarray(newline + 1);
    }
    if (buffered.length > maxLineBytes) {
      buffered = Buffer.alloc(0);
      droppingOversizedLine = true;
      log(logger, 'warn', 'smtc_protocol_line_too_long', { bytes: `>${maxLineBytes}` });
    }
  };

  child.stdout?.on('data', onData);
  child.once('error', (error) => {
    markUnavailable('process_error', error);
    finishStartup(false);
  });
  child.once('exit', (code, signal) => {
    if (!closed) markUnavailable('process_exit', { code, signal });
    finishStartup(false);
  });
  child.stderr?.on('data', (chunk) => {
    log(logger, 'debug', 'smtc_helper_stderr', { message: String(chunk).slice(0, 1000) });
  });

  write({
    type: 'initialize',
    mode,
    controls: {
      play: true, pause: true, stop: true, seek: true, rewind: true, fastForward: true,
      ...currentControls
    }
  }, false);

  const startupTimer = setTimeout(() => finishStartup(false), readyTimeoutMs);
  const started = await readyPromise;
  clearTimeout(startupTimer);
  if (!started) {
    markUnavailable('ready_timeout');
    try { child.stdin?.end(); } catch {}
    try { child.kill(); } catch {}
    return noOpBridge(sessionId);
  }

  let currentMetadata = metadataFrom(song, durationMs, coverPath);
  write({ type: 'controls', ...currentControls });
  write({ type: 'metadata', ...currentMetadata });

  const request = (command, details = {}) => {
    const nextId = ++commandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(String(nextId));
        reject(new Error(`MediaPlayer 命令响应超时：${command}`));
      }, commandTimeoutMs);
      pendingCommands.set(String(nextId), { command, resolve, reject, timer });
      if (!write({ type: command, commandId: nextId, ...details })) {
        clearTimeout(timer);
        pendingCommands.delete(String(nextId));
        reject(new Error('MediaPlayer helper 不可用'));
      }
    });
  };

  return {
    get available() { return alive && ready && !closed; },
    get generation() { return generation; },
    capabilities: Object.freeze({ pause: true, seek: true, volume: true, load: mode === 'media-player' }),
    sessionId,
    initialize: async () => true,
    async setMetadata(overrides = {}) {
      currentMetadata = metadataFrom(currentMetadata, durationMs, coverPath, overrides);
      return write({ type: 'metadata', ...currentMetadata });
    },
    updateControls(options = {}) {
      const fallback = options.playlistControls ?? options.hasPlaylist;
      currentControls = {
        previous: typeof options.canPrevious === 'boolean'
          ? options.canPrevious
          : fallback === undefined ? currentControls.previous : Boolean(fallback),
        next: typeof options.canNext === 'boolean'
          ? options.canNext
          : fallback === undefined ? currentControls.next : Boolean(fallback)
      };
      return write({ type: 'controls', ...currentControls });
    },
    updatePlayback({ status, positionMs = 0, durationMs: nextDuration = currentMetadata.durationMs, rate = 1 } = {}) {
      if (!['playing', 'paused', 'stopped'].includes(status)) return false;
      const safeDuration = finiteInteger(nextDuration, currentMetadata.durationMs);
      const safePosition = Math.min(finiteInteger(positionMs), safeDuration);
      revision += 1;
      return write({
        type: 'playback',
        revision,
        status,
        positionMs: safePosition,
        durationMs: safeDuration,
        rate: Number.isFinite(Number(rate)) && Number(rate) > 0 ? Number(rate) : 1
      });
    },
    async load(url, { positionMs = 0, volume = 100, durationMs: nextDuration, metadata = {} } = {}) {
      if (mode !== 'media-player') throw new Error('当前 SMTC bridge 未启用 MediaPlayer 模式');
      if (!url) throw new Error('播放地址不能为空');
      generation += 1;
      await this.setMetadata({ ...metadata, durationMs: nextDuration });
      await request('load', {
        url: String(url),
        positionMs: finiteInteger(positionMs),
        volume: Math.min(100, Math.max(0, Number(volume) || 0))
      });
      return generation;
    },
    pause() { return request('pause'); },
    resume() { return request('play'); },
    seekAbsolute(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 0) throw new Error('跳转位置必须是非负数');
      return request('seek', { positionMs: Math.round(value * 1000) });
    },
    setVolume(volume) {
      const value = Number(volume);
      if (!Number.isFinite(value)) throw new Error('音量必须是数字');
      return request('volume', { volume: Math.min(100, Math.max(0, value)) });
    },
    stop() { return request('stop'); },
    async close() {
      if (closed) return;
      if (alive && ready) write({ type: 'shutdown' });
      closed = true;
      ready = false;
      try { child.stdin?.end(); } catch {}
      await waitForChildExit(child, closeTimeoutMs);
      if (!hasProcessExited(child)) {
        try { child.kill(); } catch {}
        await waitForChildExit(child, Math.min(250, closeTimeoutMs));
      }
      alive = false;
      rejectPendingCommands(new Error('MediaPlayer helper 已关闭'));
    }
  };
}
