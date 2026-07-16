import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createVlcController, validateVlcUrl } from '../src/vlc-controller.js';

class FakeSocket extends EventEmitter {
  writes = [];
  ended = false;
  destroyed = false;
  input = '';
  state = 'play';
  write(value, callback) {
    this.writes.push(value);
    callback?.();
    const command = value.trim();
    if (command.startsWith('add ')) this.input = command.slice(4);
    queueMicrotask(() => {
      const status = command === 'status'
        ? `status change: ( new input: ${this.input} )\nstatus change: ( ${this.state} state: 3 )\n`
        : '';
      const stopped = command === 'stop' ? 'status change: ( stop state: 6 ): Stopped\n' : '';
      const name = command.split(/\s+/, 1)[0];
      this.emit('data', Buffer.from(`${stopped}${status}${name}: returned 0 (no error)\n`));
    });
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
  const controller = createVlcController({
    allocatePort: async () => 43123,
    connectTimeoutMs: 20,
    retryDelayMs: 0,
    delay: async () => {},
    spawnProcess(command, args, options) { spawnCalls.push({ command, args, options }); return child; },
    guardProcess() {},
    connectRc() { queueMicrotask(() => socket.emit('connect')); return socket; },
    ...overrides
  });
  return { controller, socket, child, spawnCalls };
}

test('starts persistent VLC oldrc and maps control commands', async () => {
  const { controller, socket, spawnCalls } = harness();
  await controller.initialize();
  assert.deepEqual(spawnCalls[0], {
    command: 'vlc',
    args: ['-I', 'oldrc', '--rc-host', '127.0.0.1:43123', '--no-video', '--quiet'],
    options: { stdio: 'ignore', windowsHide: true }
  });
  await controller.load('https://example.test/a.mp3', { positionMs: 2500, volume: 80 });
  await controller.pause();
  await controller.resume();
  await controller.seekAbsolute(12.9);
  await controller.setVolume(100);
  await controller.stop();
  assert.deepEqual(socket.writes.map((value) => value.trim()), [
    'status', 'stop', 'volume 205', 'add https://example.test/a.mp3', 'status', 'seek 2',
    'pause', 'play', 'seek 12', 'volume 256', 'stop'
  ]);
  assert.equal(controller.available, true);
});

test('strictly serializes commands until each oldrc return line arrives', async () => {
  const { controller, socket } = harness();
  await controller.initialize();
  const originalWrite = socket.write.bind(socket);
  let release;
  socket.write = (value, callback) => {
    socket.writes.push(value); callback?.();
    const name = value.trim().split(/\s+/, 1)[0];
    if (!release) release = () => socket.emit('data', Buffer.from(`${name}: returned 0 (no error)\n`));
    else queueMicrotask(() => socket.emit('data', Buffer.from(`${name}: returned 0 (no error)\n`)));
    return true;
  };
  const first = controller.pause();
  const second = controller.resume();
  await Promise.resolve();
  assert.equal(socket.writes.length, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(socket.writes.length, 3);
  socket.write = originalWrite;
});

test('向 VLC 注入安全的标题和歌手，并接收播放器暂停状态', async () => {
  const states = [];
  const { controller, socket } = harness({ onPauseChange: (paused) => states.push(paused) });
  await controller.initialize();
  await controller.load('https://example.test/opaque', {
    metadata: { name: '歌曲 "A"', artists: ['歌手甲', '歌手乙'], album: '专辑名' }
  });
  const add = socket.writes.map((value) => value.trim()).find((value) => value.startsWith('add '));
  assert.match(add, /:meta-title="歌曲 \\"A\\""/);
  assert.match(add, /:meta-artist="歌手甲\/歌手乙"/);
  assert.doesNotMatch(add, /meta-album/);
  socket.emit('data', Buffer.from('status change: ( pause state: 4 ): Paused\n'));
  socket.emit('data', Buffer.from('status change: ( pause state: 4 ): Paused\n'));
  socket.emit('data', Buffer.from('status change: ( play state: 3 ): Playing\n'));
  assert.deepEqual(states.slice(-2), [true, false]);
});

test('rejects URL command injection and oversized commands', () => {
  assert.throws(() => validateVlcUrl('https://x.test/a\nstop'), /控制字符/);
  assert.throws(() => validateVlcUrl(`https://x.test/${'a'.repeat(1100)}`), /1024/);
});

test('recognizes oldrc natural end but suppresses intentional and replaced stops', async () => {
  const ended = [];
  const { controller, socket } = harness({ onEnd: (event, generation) => ended.push({ event, generation }) });
  await controller.initialize();
  await controller.load('https://example.test/a.mp3');
  socket.emit('data', Buffer.from('status change: ( stop state: 6 ): Ended\n'));
  assert.equal(ended.length, 1);
  assert.equal(ended[0].generation, 1);

  socket.emit('data', Buffer.from('status change: ( play state: 3 ): Playing\n'));
  await controller.stop();
  socket.emit('data', Buffer.from('status change: ( stop state: 6 ): Stopped\n'));
  assert.equal(ended.length, 1);
});

test('command timeout, unexpected close, and close cleanup are handled', async () => {
  const errors = [];
  const { controller, socket, child } = harness({ commandTimeoutMs: 10, onError: (error) => errors.push(error) });
  await controller.initialize();
  socket.write = (value, callback) => { socket.writes.push(value); callback?.(); return true; };
  await assert.rejects(controller.pause(), /响应超时/);
  socket.emit('close');
  assert.equal(controller.available, false);
  assert.match(errors[0].message, /意外关闭/);
  await controller.close();
  await controller.close();
  assert.equal(child.killed, true);
});

test('failed initialization terminates child', async () => {
  const child = new FakeChild();
  const controller = createVlcController({
    allocatePort: async () => 1,
    connectTimeoutMs: -1,
    spawnProcess: () => child,
    connectRc: () => { throw new Error('unreachable'); }
  });
  await assert.rejects(controller.initialize(), /无法连接 VLC RC/);
  assert.equal(child.killed, true);
});

test('startup exit rejects initialization without runtime error callback', async () => {
  const child = new FakeChild();
  const socket = new FakeSocket();
  const errors = [];
  const controller = createVlcController({
    allocatePort: async () => 43124,
    connectTimeoutMs: 15,
    retryDelayMs: 0,
    delay: async () => {},
    spawnProcess: () => {
      queueMicrotask(() => child.emit('exit', 1, null));
      return child;
    },
    connectRc: () => socket,
    onError: (error) => errors.push(error)
  });
  await assert.rejects(controller.initialize(), /VLC 意外退出|无法连接 VLC RC/);
  assert.deepEqual(errors, []);
});
