import { spawn } from 'node:child_process';
import net from 'node:net';
import { guardPlayerProcess } from './process-guardian.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const MAX_COMMAND_BYTES = 1024;

export function validateVlcUrl(url) {
  const value = String(url || '');
  if (!value) throw new Error('播放地址不能为空');
  if(/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('播放地址包含控制字符');
  if (Buffer.byteLength(`add ${value}\n`, 'utf8') > MAX_COMMAND_BYTES) throw new Error('VLC 命令超过 1024 字节限制');
  return value;
}

function vlcMetadataOption(name, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/[\r\n\u0000]/u.test(text)) throw new Error('VLC 元数据包含控制字符');
  return ` :meta-${name}="${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function createVlcController({
  command = 'vlc',
  host = '127.0.0.1',
  allocatePort = async () => {
    const server = net.createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(0, host, resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
  },
  spawnProcess = spawn,
  guardProcess = guardPlayerProcess,
  connectRc = (port) => net.createConnection({ host, port }),
  delay = wait,
  connectTimeoutMs = 3000,
  retryDelayMs = 25,
  commandTimeoutMs = 3000,
  loadTimeoutMs = 15000,
  onEnd = () => {},
  onPauseChange = () => {},
  onError = () => {}
} = {}) {
  let child = null;
  let socket = null;
  let initialized = false;
  let closing = false;
  let lineBuffer = '';
  let queue = Promise.resolve();
  let responseWaiter = null;
  let loadGeneration = 0;
  let currentInput = '';
  let lastState = '';
  let intentionalStop = false;
  let loadingGeneration = 0;

  const reportError = (error) => {
    if (!closing) onError(error instanceof Error ? error : new Error(String(error)));
  };

  const inspectOutput = (text) => {
    for (const match of text.matchAll(/(?:new input|input)\s*:\s*(.+?)\s*\)?(?:\r?\n|$)/gi)) currentInput = match[1].trim();
    for (const match of text.matchAll(/status change:\s*\(\s*(play|pause|stop|error)\s+state\s*:/gi)) {
      const state = match[1].toLowerCase();
      if (state === 'stop' && lastState === 'play' && !loadingGeneration) {
        if (intentionalStop) intentionalStop = false;
        else onEnd({ state, input: currentInput }, loadGeneration);
      }
      if (state === 'error') reportError(new Error('VLC 播放错误'));
      if ((state === 'play' || state === 'pause') && state !== lastState) {
        onPauseChange(state === 'pause', { state, input: currentInput }, loadGeneration);
      }
      lastState = state;
    }
  };

  const handleData = (chunk) => {
    const text = chunk.toString('utf8');
    lineBuffer += text;
    const lines = lineBuffer.split(/\r?\n/);
    lineBuffer = lines.pop() || '';
    for (const line of lines) {
      inspectOutput(`${line}\n`);
      if (!responseWaiter) continue;
      const match = line.match(/^\s*([\w-]+):\s+returned\s+(-?\d+)/i);
      if (!match || match[1].toLowerCase() !== responseWaiter.command) continue;
      const waiter = responseWaiter;
      responseWaiter = null;
      clearTimeout(waiter.timer);
      const code = Number(match[2]);
      if (code === 0) waiter.resolve(line);
      else waiter.reject(new Error(`VLC 命令失败：${waiter.command} returned ${code}`));
    }
  };

  const rejectWaiter = (error) => {
    if (!responseWaiter) return;
    clearTimeout(responseWaiter.timer);
    responseWaiter.reject(error);
    responseWaiter = null;
  };

  const attachSocket = (candidate) => {
    socket = candidate;
    socket.on('data', handleData);
    socket.on('error', reportError);
    socket.once('close', () => {
      if (socket === candidate) { socket = null; initialized = false; }
      if (!closing) {
        const error = new Error('VLC RC 连接意外关闭');
        rejectWaiter(error);
        reportError(error);
      }
    });
  };

  const connectOnce = (port, timeoutMs) => new Promise((resolve, reject) => {
    let candidate;
    let timer;
    const cleanup = () => { clearTimeout(timer); candidate?.removeListener('connect', connected); candidate?.removeListener('error', failed); };
    const connected = () => { cleanup(); resolve(candidate); };
    const failed = (error) => { cleanup(); candidate?.destroy?.(); reject(error); };
    try { candidate = connectRc(port); } catch (error) { reject(error); return; }
    candidate.once('connect', connected);
    candidate.once('error', failed);
    timer = setTimeout(() => failed(new Error('VLC RC 连接超时')), Math.max(1, timeoutMs));
  });

  const sendNow = (line) => {
    if (!initialized || !socket) throw new Error('VLC 控制器尚未初始化');
    if (/[\r\n\u0000]/u.test(line)) throw new Error('VLC 命令包含控制字符');
    if (Buffer.byteLength(`${line}\n`, 'utf8') > MAX_COMMAND_BYTES) throw new Error('VLC 命令超过 1024 字节限制');
    return new Promise((resolve, reject) => {
      const commandName = line.trim().split(/\s+/, 1)[0].toLowerCase();
      const timer = setTimeout(() => {
        if (responseWaiter?.reject === reject) responseWaiter = null;
        reject(new Error(`VLC 命令响应超时：${line.split(' ')[0]}`));
      }, commandTimeoutMs);
      responseWaiter = { command: commandName, resolve, reject, timer };
      try {
        socket.write(`${line}\n`, (error) => {
          if (!error) return;
          if (responseWaiter?.reject === reject) responseWaiter = null;
          clearTimeout(timer);
          reject(error);
        });
      } catch (error) {
        responseWaiter = null;
        clearTimeout(timer);
        reject(error);
      }
    });
  };

  const send = (line) => {
    const operation = queue.then(() => sendNow(line));
    queue = operation.catch(() => {});
    return operation;
  };

  const initialize = async () => {
    if (initialized) return;
    if (child) throw new Error('VLC 控制器正在初始化');
    closing = false;
    const port = await allocatePort();
    try {
      child = spawnProcess(command, ['-I', 'oldrc', '--rc-host', `${host}:${port}`, '--no-video', '--quiet'], { stdio: 'ignore', windowsHide: true });
      guardProcess(child, { command, marker: `${host}:${port}` });
      let startupFailure = null;
      child.once('error', (error) => { if (!initialized) startupFailure = error; else reportError(error); });
      child.once('exit', (code, signal) => {
        child = null;
        if (closing) return;
        const error = new Error(`VLC 意外退出（code=${code}, signal=${signal || 'none'}）`);
        if (!initialized) startupFailure = error;
        else {
          initialized = false;
          socket?.destroy?.();
          socket = null;
          reportError(error);
        }
      });
      const deadline = Date.now() + connectTimeoutMs;
      let lastError;
      while (Date.now() <= deadline) {
        if (startupFailure) throw startupFailure;
        try {
          attachSocket(await connectOnce(port, Math.max(1, deadline - Date.now())));
          initialized = true;
          await send('status');
          return;
        }
        catch (error) { lastError = error; await delay(retryDelayMs); }
      }
      throw new Error(`无法连接 VLC RC：${lastError?.message || '连接超时'}`);
    } catch (error) {
      closing = true;
      socket?.destroy?.(); socket = null;
      if (child && child.exitCode == null && child.signalCode == null) child.kill();
      child = null;
      throw error;
    }
  };

  return {
    capabilities: Object.freeze({ pause: true, seek: true, volume: true, load: true }),
    get available() { return initialized && !closing; },
    get generation() { return loadGeneration; },
    initialize,
    async load(url, { positionMs = 0, volume = 100, metadata = {} } = {}) {
      const value = validateVlcUrl(url);
      const artists = Array.isArray(metadata.artists) ? metadata.artists.join('/') : metadata.artist;
      const addCommand = `add ${value}${vlcMetadataOption('title', metadata.title || metadata.name)}${vlcMetadataOption('artist', artists)}`;
      if (Buffer.byteLength(`${addCommand}\n`, 'utf8') > MAX_COMMAND_BYTES) throw new Error('VLC 地址与元数据超过 1024 字节限制');
      const generation = ++loadGeneration;
      loadingGeneration = generation;
      currentInput = '';
      intentionalStop = true;
      await send('stop');
      await send(`volume ${Math.round(Math.min(100, Math.max(0, Number(volume) || 0)) * 2.56)}`);
      await send(addCommand);
      const deadline = Date.now() + loadTimeoutMs;
      while (Date.now() <= deadline) {
        const status = await send('status');
        if (generation !== loadGeneration) throw new Error('VLC 加载已过期');
        if (currentInput.includes(value) || status.includes(value)) break;
        await delay(retryDelayMs);
      }
      if (!(currentInput.includes(value))) {
        if (loadingGeneration === generation) loadingGeneration = 0;
        throw new Error('VLC 等待媒体加载超时');
      }
      if (loadingGeneration === generation) loadingGeneration = 0;
      intentionalStop = false;
      if (Number(positionMs) > 0) await send(`seek ${Math.floor(Number(positionMs) / 1000)}`);
      return generation;
    },
    pause() { return send('pause'); },
    resume() { return send('play'); },
    seekAbsolute(seconds) {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 0) throw new Error('跳转位置必须是非负数');
      return send(`seek ${Math.floor(value)}`);
    },
    setVolume(volume) {
      const value = Number(volume);
      if (!Number.isFinite(value)) throw new Error('音量必须是数字');
      return send(`volume ${Math.round(Math.min(100, Math.max(0, value)) * 2.56)}`);
    },
    stop() { intentionalStop = true; return send('stop'); },
    async close() {
      if (closing) return;
      closing = true; initialized = false;
      rejectWaiter(new Error('VLC 控制器已关闭'));
      socket?.end?.(); socket?.destroy?.(); socket = null;
      if (child && child.exitCode == null && child.signalCode == null) child.kill();
      child = null; lineBuffer = ''; queue = Promise.resolve();
    }
  };
}
