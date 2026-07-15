import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createMpvController, createMpvIpcPath } from '../src/mpv-controller.js';

class FakeSocket extends EventEmitter {
  writes = [];
  destroyed = false;
  ended = false;
  autoRespond = true;
  write(value, callback) {
    this.writes.push(value);
    callback?.();
    if (this.autoRespond) {
      const payload = JSON.parse(value);
      queueMicrotask(() => {
        this.emit('data', Buffer.from(`${JSON.stringify({ request_id: payload.request_id, error: 'success' })}\n`));
        if (payload.command[0] === 'loadfile') {
          this.emit('data', Buffer.from('{"event":"file-loaded"}\n'));
        }
      });
    }
    return true;
  }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = false;
  kill() { this.killed = true; return true; }
}

function harness(overrides = {}) {
  const socket = new FakeSocket();
  const child = new FakeChild();
  const spawnCalls = [];
  const controller = createMpvController({
    ipcPath: 'test-ipc',
    connectTimeoutMs: 10,
    retryDelayMs: 0,
    delay: async () => {},
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    connectIpc() {
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
    ...overrides
  });
  return { controller, socket, child, spawnCalls };
}

test('creates platform-specific IPC paths', () => {
  assert.equal(createMpvIpcPath({ platform: 'win32', pid: 7, uuid: 'abc' }), '\\\\.\\pipe\\ncm-cli-mpv-7-abc');
  assert.match(createMpvIpcPath({ platform: 'linux', pid: 7, uuid: 'abc' }), /ncm-cli-mpv-7-abc\.sock$/);
});

test('starts persistent mpv and sends JSON IPC commands', async () => {
  const { controller, socket, spawnCalls } = harness();
  await controller.initialize();
  assert.deepEqual(spawnCalls[0], {
    command: 'mpv',
    args: ['--no-video', '--idle=yes', '--no-terminal', '--really-quiet', '--input-ipc-server=test-ipc'],
    options: { stdio: 'ignore', windowsHide: true }
  });

  await controller.load('https://example.test/a.mp3', { positionMs: 2500, volume: 80 });
  await controller.pause();
  await controller.resume();
  await controller.seekAbsolute(12.5);
  await controller.setVolume(130);
  await controller.stop();
  const commands = socket.writes.map((line) => JSON.parse(line).command);
  assert.deepEqual(commands, [
    ['set_property', 'volume', 80],
    ['loadfile', 'https://example.test/a.mp3', 'replace'],
    ['seek', 2.5, 'absolute+exact'],
    ['set_property', 'pause', true],
    ['set_property', 'pause', false],
    ['seek', 12.5, 'absolute+exact'],
    ['set_property', 'volume', 100],
    ['stop']
  ]);
  assert.equal(controller.available, true);
  assert.equal(controller.capabilities.seek, true);
});

test('parses split NDJSON and reports only eof as natural end', async () => {
  const ended = [];
  const errors = [];
  const { controller, socket } = harness({ onEnd: (event) => ended.push(event), onError: (error) => errors.push(error) });
  await controller.initialize();
  socket.emit('data', Buffer.from('{"event":"end-'));
  socket.emit('data', Buffer.from('file","reason":"eof"}\n{"event":"end-file","reason":"stop"}\n'));
  assert.equal(ended.length, 1);
  assert.equal(errors.length, 0);

  socket.emit('data', Buffer.from('{"event":"end-file","reason":"error","error":"loading failed"}\n'));
  assert.match(errors[0].message, /loading failed/);
});

test('waits for file-loaded before seeking and ignores replaced-file eof', async () => {
  const ended = [];
  const { controller, socket } = harness({ onEnd: (_event, generation) => ended.push(generation) });
  await controller.initialize();
  socket.autoRespond = false;
  const loading = controller.load('https://example.test/next.mp3', { positionMs: 5000, volume: 70 });

  const volume = JSON.parse(socket.writes[0]);
  socket.emit('data', Buffer.from(`${JSON.stringify({ request_id: volume.request_id, error: 'success' })}\n`));
  await Promise.resolve();
  const loadfile = JSON.parse(socket.writes[1]);
  socket.emit('data', Buffer.from(`${JSON.stringify({ request_id: loadfile.request_id, error: 'success' })}\n`));
  socket.emit('data', Buffer.from('{"event":"end-file","reason":"eof"}\n'));
  await Promise.resolve();
  assert.equal(socket.writes.length, 2);
  assert.deepEqual(ended, []);

  socket.emit('data', Buffer.from('{"event":"file-loaded"}\n'));
  await Promise.resolve();
  const seek = JSON.parse(socket.writes[2]);
  assert.deepEqual(seek.command, ['seek', 5, 'absolute+exact']);
  socket.emit('data', Buffer.from(`${JSON.stringify({ request_id: seek.request_id, error: 'success' })}\n`));
  await loading;
  socket.emit('data', Buffer.from('{"event":"end-file","reason":"eof"}\n'));
  assert.deepEqual(ended, [1]);
});

test('rejects failed mpv command responses', async () => {
  const { controller, socket } = harness();
  await controller.initialize();
  socket.autoRespond = false;
  const pausing = controller.pause();
  const request = JSON.parse(socket.writes[0]);
  socket.emit('data', Buffer.from(`${JSON.stringify({ request_id: request.request_id, error: 'property unavailable' })}\n`));
  await assert.rejects(pausing, /property unavailable/);
});

test('reports invalid JSON and unexpected process exit', async () => {
  const errors = [];
  const { controller, socket, child } = harness({ onError: (error) => errors.push(error) });
  await controller.initialize();
  socket.emit('data', Buffer.from('not-json\n'));
  child.emit('exit', 0, null);
  assert.match(errors[0].message, /无效 JSON/);
  assert.match(errors[1].message, /code=0/);
});

test('initialization failure terminates the child and cleans up', async () => {
  const child = new FakeChild();
  const controller = createMpvController({
    ipcPath: 'test-ipc',
    connectTimeoutMs: -1,
    spawnProcess: () => child,
    connectIpc: () => { throw new Error('unreachable'); }
  });
  await assert.rejects(controller.initialize(), /无法连接 mpv IPC/);
  assert.equal(child.killed, true);
  assert.throws(() => controller.pause(), /尚未初始化/);
});

test('silent IPC connection obeys initialization timeout', async () => {
  const child = new FakeChild();
  const socket = new FakeSocket();
  const controller = createMpvController({
    ipcPath: 'silent-ipc',
    connectTimeoutMs: 15,
    retryDelayMs: 0,
    spawnProcess: () => child,
    connectIpc: () => socket,
    delay: async () => {}
  });
  await assert.rejects(controller.initialize(), /连接超时|无法连接/);
  assert.equal(child.killed, true);
  assert.equal(socket.destroyed, true);
});

test('unexpected IPC close marks controller unavailable', async () => {
  const errors = [];
  const { controller, socket } = harness({ onError: (error) => errors.push(error) });
  await controller.initialize();
  socket.emit('close');
  assert.equal(controller.available, false);
  assert.match(errors[0].message, /意外关闭/);
  assert.throws(() => controller.pause(), /尚未初始化/);
});

test('close shuts down IPC and suppresses later exit errors', async () => {
  const errors = [];
  const { controller, socket, child } = harness({ onError: (error) => errors.push(error) });
  await controller.initialize();
  await controller.close();
  child.emit('exit', 1, null);
  assert.equal(socket.ended, true);
  assert.equal(socket.destroyed, true);
  assert.equal(child.killed, true);
  assert.deepEqual(errors, []);
});
