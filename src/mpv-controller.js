import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { guardPlayerProcess } from './process-guardian.js';

export function createMpvIpcPath({ platform = process.platform, pid = process.pid, uuid = randomUUID() } = {}) {
  const name = `ncm-cli-mpv-${pid}-${uuid}`;
  return platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createMpvController({
  command = 'mpv',
  platform = process.platform,
  ipcPath = createMpvIpcPath({ platform }),
  spawnProcess = spawn,
  guardProcess = guardPlayerProcess,
  connectIpc = (socketPath) => net.createConnection(socketPath),
  delay = wait,
  connectTimeoutMs = 3000,
  retryDelayMs = 25,
  commandTimeoutMs = 3000,
  loadTimeoutMs = 15000,
  onEnd = () => {},
  onPauseChange = () => {},
  onPositionChange = () => {},
  onError = () => {}
} = {}) {
  let child = null;
  let socket = null;
  let buffer = '';
  let initialized = false;
  let closing = false;
  let requestId = 0;
  let initializationFailure = null;
  let loadGeneration = 0;
  let pendingLoad = null;
  const pendingRequests = new Map();

  const reportError = (error) => {
    if (!closing) onError(error instanceof Error ? error : new Error(String(error)));
  };

  const handleMessage = (message) => {
    if (message?.event === 'property-change' && message.name === 'pause' && typeof message.data === 'boolean') {
      onPauseChange(message.data, message);
      return;
    }
    if (message?.event === 'property-change' && message.name === 'time-pos'
        && Number.isFinite(message.data) && message.data >= 0) {
      onPositionChange(message.data, message, loadGeneration);
      return;
    }
    if (message?.request_id != null) {
      const pending = pendingRequests.get(message.request_id);
      if (pending) {
        pendingRequests.delete(message.request_id);
        clearTimeout(pending.timer);
        if (message.error && message.error !== 'success') {
          pending.reject(new Error(`mpv 命令失败：${message.error}`));
        } else pending.resolve(message.data);
      }
      return;
    }
    if (message?.event === 'file-loaded') {
      if (pendingLoad) {
        const current = pendingLoad;
        pendingLoad = null;
        clearTimeout(current.timer);
        current.resolve(current.generation);
      }
      return;
    }
    if (message?.event !== 'end-file') return;
    if (message.reason === 'eof') {
      // loadfile replace 会先结束旧文件；加载中的 EOF 不得推进新曲。
      if (!pendingLoad) onEnd(message, loadGeneration);
    } else if (message.reason === 'error') {
      const error = new Error(`mpv 播放错误：${message.error || '未知错误'}`);
      if (pendingLoad) {
        const current = pendingLoad;
        pendingLoad = null;
        clearTimeout(current.timer);
        current.reject(error);
      } else reportError(error);
    }
  };

  const handleData = (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch {
        reportError(new Error(`mpv IPC 返回了无效 JSON：${line}`));
      }
    }
  };

  const attachSocket = (candidate) => {
    socket = candidate;
    socket.on('data', handleData);
    socket.on('error', reportError);
    socket.once('close', () => {
      if (socket === candidate) {
        initialized = false;
        socket = null;
      }
      if (!closing) {
        const error = new Error('mpv IPC 连接意外关闭');
        rejectPending(error);
        reportError(error);
      }
    });
  };

  const connectOnce = (timeoutMs) => new Promise((resolve, reject) => {
    let candidate;
    let timer;
    try {
      candidate = connectIpc(ipcPath);
    } catch (error) {
      reject(error);
      return;
    }
    const connected = () => {
      cleanup();
      resolve(candidate);
    };
    const failed = (error) => {
      cleanup();
      candidate.destroy?.();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      candidate.removeListener('connect', connected);
      candidate.removeListener('error', failed);
    };
    candidate.once('connect', connected);
    candidate.once('error', failed);
    timer = setTimeout(() => failed(new Error('mpv IPC 连接超时')), Math.max(1, timeoutMs));
  });

  const terminateChild = () => {
    if (child && child.exitCode == null && child.signalCode == null) child.kill();
  };

  const initialize = async () => {
    if (initialized) return;
    if (child) throw new Error('mpv 控制器正在初始化');
    closing = false;
    initializationFailure = null;
    try {
      child = spawnProcess(command, [
        '--no-video',
        '--idle=yes',
        '--no-terminal',
        '--really-quiet',
        `--input-ipc-server=${ipcPath}`
      ], { stdio: 'ignore', windowsHide: true });
      guardProcess(child, { command, marker: ipcPath });
      child.once('error', (error) => {
        if (!initialized) initializationFailure = error;
        else reportError(error);
      });
      child.once('exit', (code, signal) => {
        if (!initialized && !closing) {
          initializationFailure = new Error(`mpv 在 IPC 初始化前退出（code=${code}, signal=${signal || 'none'}）`);
        } else if (!closing) {
          reportError(new Error(`mpv 意外退出（code=${code}, signal=${signal || 'none'}）`));
        }
      });

      const deadline = Date.now() + connectTimeoutMs;
      let lastError;
      while (Date.now() <= deadline) {
        if (initializationFailure) throw initializationFailure;
        try {
          const connectedSocket = await connectOnce(Math.max(1, deadline - Date.now()));
          attachSocket(connectedSocket);
          initialized = true;
          await send(['observe_property', 1, 'pause']);
          await send(['observe_property', 2, 'time-pos']);
          return;
        } catch (error) {
          lastError = error;
          if (initializationFailure) throw initializationFailure;
          await delay(retryDelayMs);
        }
      }
      throw new Error(`无法连接 mpv IPC：${lastError?.message || '连接超时'}`);
    } catch (error) {
      closing = true;
      socket?.destroy?.();
      socket = null;
      terminateChild();
      child = null;
      initialized = false;
      throw error;
    }
  };

  const send = (commandParts) => {
    if (!initialized || !socket) throw new Error('mpv 控制器尚未初始化');
    const payload = { command: commandParts, request_id: ++requestId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(payload.request_id);
        reject(new Error(`mpv 命令响应超时：${commandParts[0]}`));
      }, commandTimeoutMs);
      pendingRequests.set(payload.request_id, { resolve, reject, timer });
      try {
        socket.write(`${JSON.stringify(payload)}\n`, (error) => {
          if (!error) return;
          const pending = pendingRequests.get(payload.request_id);
          if (!pending) return;
          pendingRequests.delete(payload.request_id);
          clearTimeout(pending.timer);
          pending.reject(error);
        });
      } catch (error) {
        pendingRequests.delete(payload.request_id);
        clearTimeout(timer);
        reject(error);
      }
    });
  };

  const rejectPending = (error) => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
    if (pendingLoad) {
      clearTimeout(pendingLoad.timer);
      pendingLoad.reject(error);
      pendingLoad = null;
    }
  };

  return {
    ipcPath,
    capabilities: Object.freeze({ pause: true, seek: true, volume: true, load: true }),
    get available() { return initialized && !closing; },
    get generation() { return loadGeneration; },
    initialize,
    async load(url, { positionMs = 0, volume = 100, metadata = {} } = {}) {
      if (!url) throw new Error('播放地址不能为空');
      const generation = ++loadGeneration;
      if (pendingLoad) {
        clearTimeout(pendingLoad.timer);
        pendingLoad.reject(new Error('mpv 加载已被新请求取代'));
      }
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pendingLoad?.generation === generation) pendingLoad = null;
          reject(new Error('mpv 等待 file-loaded 超时'));
        }, loadTimeoutMs);
        pendingLoad = { generation, resolve, reject, timer };
      });
      try {
        const title = String(metadata.title || metadata.name || '').trim();
        const artists = Array.isArray(metadata.artists) ? metadata.artists.join('/') : metadata.artist;
        const album = String(metadata.album || '').trim();
        const mediaTitle = [title, String(artists || '').trim()].filter(Boolean).join(' — ') || title;
        await send(['set_property', 'volume', Math.min(100, Math.max(0, Number(volume) || 0))]);
        if (mediaTitle) await send(['set_property', 'force-media-title', mediaTitle]);
        await send(['loadfile', String(url), 'replace']);
        await loaded;
        if (generation !== loadGeneration) throw new Error('mpv 加载已过期');
        if (Number(positionMs) > 0) await send(['seek', Number(positionMs) / 1000, 'absolute+exact']);
        return generation;
      } catch (error) {
        if (pendingLoad?.generation === generation) {
          clearTimeout(pendingLoad.timer);
          pendingLoad = null;
        }
        throw error;
      }
    },
    pause() { return send(['set_property', 'pause', true]); },
    resume() { return send(['set_property', 'pause', false]); },
    seekAbsolute(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 0) throw new Error('跳转位置必须是非负数');
      return send(['seek', value, 'absolute+exact']);
    },
    setVolume(volume) {
      const value = Number(volume);
      if (!Number.isFinite(value)) throw new Error('音量必须是数字');
      return send(['set_property', 'volume', Math.min(100, Math.max(0, value))]);
    },
    stop() { return send(['stop']); },
    async close() {
      if (closing) return;
      closing = true;
      initialized = false;
      rejectPending(new Error('mpv 控制器已关闭'));
      socket?.end?.();
      socket?.destroy?.();
      socket = null;
      terminateChild();
      child = null;
      buffer = '';
    }
  };
}
