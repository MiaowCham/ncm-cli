import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSmtcBridge } from '../src/smtc.js';

class FakeStream extends EventEmitter {
  constructor() {
    super();
    this.writable = true;
    this.writes = [];
  }
  write(value, callback) {
    this.writes.push(String(value));
    callback?.();
    return true;
  }
  end() {
    this.writable = false;
    this.emit('finish');
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeStream();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.killed = false;
  }
  kill() {
    this.killed = true;
    this.exitCode = 1;
    this.emit('exit', 1, null);
    return true;
  }
  message(index = 0) {
    return JSON.parse(this.stdin.writes[index]);
  }
  ready({ fragmented = false } = {}) {
    const initialize = this.message(0);
    const line = `${JSON.stringify({ v: 1, type: 'ready', sessionId: initialize.sessionId })}\n`;
    if (fragmented) {
      this.stdout.emit('data', Buffer.from(line.slice(0, 7)));
      this.stdout.emit('data', Buffer.from(line.slice(7)));
    } else {
      this.stdout.emit('data', Buffer.from(line));
    }
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

function spawning(child, onSpawn = () => child.ready()) {
  return (...args) => {
    queueMicrotask(() => onSpawn(child));
    child.spawnArgs = args;
    return child;
  };
}

test('非 Windows 环境返回 no-op 且不启动 helper', async () => {
  let spawned = false;
  const bridge = await createSmtcBridge({
    platform: 'linux',
    spawnImpl: () => { spawned = true; }
  });
  assert.equal(spawned, false);
  assert.equal(bridge.available, false);
  assert.equal(bridge.updatePlayback({ status: 'playing' }), false);
  assert.equal(bridge.updateControls({ hasPlaylist: true }), false);
  await bridge.close();
});

test('分片 ready 后发送隔离会话的元数据且仅接受 HTTPS 封面', async () => {
  const child = new FakeChild();
  const bridge = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(child, () => child.ready({ fragmented: true })),
    helperCommand: 'mock.exe',
    song: {
      id: 42,
      name: '歌名',
      artists: ['歌手一', '歌手二'],
      album: '专辑',
      durationMs: 12000,
      cover: 'https://example.test/cover.jpg',
      cookie: '绝不能发送',
      url: 'https://example.test/audio.mp3'
    },
    closeTimeoutMs: 5
  });
  assert.equal(bridge.available, true);
  const initialize = child.message(0);
  const controls = child.message(1);
  const metadata = child.message(2);
  assert.deepEqual(
    { previous: initialize.controls.previous, next: initialize.controls.next },
    { previous: false, next: false }
  );
  assert.deepEqual(
    { previous: controls.previous, next: controls.next },
    { previous: false, next: false }
  );
  assert.equal(metadata.sessionId, initialize.sessionId);
  assert.equal(metadata.artist, '歌手一/歌手二');
  assert.equal(metadata.coverUri, 'https://example.test/cover.jpg');
  assert.equal(JSON.stringify(metadata).includes('绝不能发送'), false);
  assert.equal(JSON.stringify(metadata).includes('audio.mp3'), false);
  assert.equal(await bridge.setMetadata({ coverUri: 'http://insecure.test/a.jpg' }), true);
  assert.equal('coverUri' in child.message(3), false);
  await bridge.close();
});

test('控制消息按会话过滤、去重并解析跳转和歌单切歌', async () => {
  const child = new FakeChild();
  const controls = [];
  const bridge = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(child),
    helperCommand: 'mock.exe',
    onControl: (control) => controls.push(control),
    closeTimeoutMs: 5
  });
  const send = (value) => child.stdout.emit('data', Buffer.from(`${JSON.stringify(value)}\n`));
  send({ v: 1, type: 'control', sessionId: 'other', requestId: 1, action: 'pause' });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 1, action: 'pause' });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 1, action: 'play' });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 2, action: 'seek_absolute', positionMs: 12500.4 });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 3, action: 'seek_relative', deltaMs: -5000 });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 4, action: 'unknown' });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 5, action: 'previous' });
  send({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 6, action: 'next' });
  assert.deepEqual(controls, [
    { action: 'pause' },
    { action: 'seek_absolute', positionMs: 12500 },
    { action: 'seek_relative', deltaMs: -5000 },
    { action: 'previous' },
    { action: 'next' }
  ]);
  await bridge.close();
});

test('歌单控制可在初始化时启用并动态更新', async () => {
  const child = new FakeChild();
  const bridge = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(child),
    helperCommand: 'mock.exe',
    hasPlaylist: true,
    closeTimeoutMs: 5
  });
  assert.deepEqual(
    { previous: child.message(0).controls.previous, next: child.message(0).controls.next },
    { previous: true, next: true }
  );
  assert.deepEqual(
    { previous: child.message(1).previous, next: child.message(1).next },
    { previous: true, next: true }
  );
  assert.equal(bridge.updateControls({ canPrevious: false, canNext: true }), true);
  const updated = child.message(3);
  assert.deepEqual({ previous: updated.previous, next: updated.next }, { previous: false, next: true });
  await bridge.close();
});

test('非法与超长 NDJSON 行不会阻止后续合法控制消息', async () => {
  const child = new FakeChild();
  const controls = [];
  const bridge = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(child),
    helperCommand: 'mock.exe',
    maxLineBytes: 256,
    onControl: (control) => controls.push(control),
    closeTimeoutMs: 5
  });
  child.stdout.emit('data', Buffer.from('{not json}\n'));
  child.stdout.emit('data', Buffer.from('x'.repeat(300)));
  child.stdout.emit('data', Buffer.from(`tail\n${JSON.stringify({ v: 1, type: 'control', sessionId: bridge.sessionId, requestId: 9, action: 'stop' })}\n`));
  assert.deepEqual(controls, [{ action: 'stop' }]);
  await bridge.close();
});

test('播放状态校验、时间范围约束与 revision 递增', async () => {
  const child = new FakeChild();
  const bridge = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(child),
    helperCommand: 'mock.exe',
    durationMs: 10000,
    closeTimeoutMs: 5
  });
  assert.equal(bridge.updatePlayback({ status: 'invalid' }), false);
  assert.equal(bridge.updatePlayback({ status: 'playing', positionMs: 15000 }), true);
  assert.equal(bridge.updatePlayback({ status: 'paused', positionMs: -5 }), true);
  const playing = child.message(3);
  const paused = child.message(4);
  assert.deepEqual([playing.positionMs, playing.durationMs, playing.revision], [10000, 10000, 1]);
  assert.deepEqual([paused.positionMs, paused.revision], [0, 2]);
  await bridge.close();
});

test('ready 超时和 helper 崩溃均安全降级', async () => {
  const neverReady = new FakeChild();
  const unavailable = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(neverReady, () => {}),
    helperCommand: 'mock.exe',
    readyTimeoutMs: 5
  });
  assert.equal(unavailable.available, false);
  assert.equal(neverReady.killed, true);

  const child = new FakeChild();
  const bridge = await createSmtcBridge({
    platform: 'win32',
    spawnImpl: spawning(child),
    helperCommand: 'mock.exe',
    closeTimeoutMs: 5
  });
  child.exit(2);
  assert.equal(bridge.available, false);
  assert.equal(bridge.updatePlayback({ status: 'playing' }), false);
  await bridge.close();
});
