import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { guardPlayerProcess } from '../src/process-guardian.js';

class FakeProcess extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.channel = { unref: () => { this.channelUnref = true; } };
  }
  unref() { this.unrefCalled = true; }
  send(message, callback) { this.messages = [...(this.messages || []), message]; callback?.(); }
  disconnect() { this.disconnected = true; }
}

test('为播放器启动独立 IPC 守护并在播放器退出后解除', () => {
  const player = new FakeProcess(4321);
  const watchdog = new FakeProcess(9876);
  let spawnCall;
  const result = guardPlayerProcess(player, {
    nodePath: 'node-test',
    command: 'mpv',
    marker: 'ipc-marker',
    registerSession() {},
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      return watchdog;
    }
  });

  assert.equal(result, watchdog);
  assert.equal(spawnCall.command, 'node-test');
  assert.equal(spawnCall.args.at(-1), '4321');
  assert.deepEqual(spawnCall.options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.equal(watchdog.unrefCalled, true);
  assert.equal(watchdog.channelUnref, true);

  player.emit('exit', 0, null);
  assert.deepEqual(watchdog.messages, ['disarm']);
  assert.equal(watchdog.disconnected, true);
});

test('没有有效 PID 时不创建守护进程', () => {
  let spawned = false;
  const result = guardPlayerProcess(new FakeProcess(undefined), {
    spawnProcess() { spawned = true; }
  });
  assert.equal(result, null);
  assert.equal(spawned, false);
});
