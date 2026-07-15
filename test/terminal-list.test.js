import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { selectTerminalList, terminalListAction, terminalListViewport } from '../src/terminal-list.js';

test('终端列表视窗始终包含选择项', () => {
  assert.deepEqual(terminalListViewport(20, 0, 5, 0), { start: 0, end: 5, selectedIndex: 0 });
  assert.deepEqual(terminalListViewport(20, 5, 5, 0), { start: 1, end: 6, selectedIndex: 5 });
  assert.deepEqual(terminalListViewport(20, 3, 5, 8), { start: 3, end: 8, selectedIndex: 3 });
  assert.deepEqual(terminalListViewport(3, 99, 5, 0), { start: 0, end: 3, selectedIndex: 2 });
  assert.deepEqual(terminalListViewport(0, 0, 5, 0), { start: 0, end: 0, selectedIndex: -1 });
});

test('终端列表解析方向键、滚轮、确认和返回', () => {
  assert.deepEqual(terminalListAction('\x1b[A'), { type: 'move', delta: -1 });
  assert.deepEqual(terminalListAction('\x1b[B'), { type: 'move', delta: 1 });
  assert.deepEqual(terminalListAction('\x1b[<64;10;5M'), { type: 'move', delta: -1 });
  assert.deepEqual(terminalListAction('\x1b[<65;10;5M'), { type: 'move', delta: 1 });
  assert.deepEqual(terminalListAction('\x1b[<64;10;5m'), { type: 'ignore' });
  assert.deepEqual(terminalListAction('\r'), { type: 'select' });
  assert.deepEqual(terminalListAction(' '), { type: 'alternate' });
  assert.deepEqual(terminalListAction('q'), { type: 'cancel' });
  assert.deepEqual(terminalListAction('\x1b'), { type: 'cancel' });
  assert.deepEqual(terminalListAction('\x03'), { type: 'interrupt' });
  assert.deepEqual(terminalListAction('x'), { type: 'ignore' });
});

test('终端列表仅在启用备用动作时允许空格确认', async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = false;
    setRawMode(value) { this.isRaw = value; }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    isPaused() { return this.paused; }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    rows = 8;
    columns = 80;
    chunks = [];
    write(chunk) { this.chunks.push(String(chunk)); return true; }
  }
  const input = new FakeInput();
  const output = new FakeOutput();
  const rl = { pause() {}, resume() {}, write() {} };
  const selection = selectTerminalList({
    rl, items: ['一'], alternateAction: 'play', input, output
  });
  setImmediate(() => input.emit('data', Buffer.from(' ')));
  assert.deepEqual(await selection, { index: 0, action: 'play' });
  assert.match(output.chunks.join(''), /空格|请选择/);
});

test('终端列表退出时恢复 raw mode、监听器和终端模式', async () => {
  class FakeInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = false;
    rawChanges = [];
    setRawMode(value) { this.isRaw = value; this.rawChanges.push(value); }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    isPaused() { return this.paused; }
  }
  class FakeOutput extends EventEmitter {
    isTTY = true;
    rows = 8;
    columns = 40;
    chunks = [];
    write(chunk) { this.chunks.push(String(chunk)); return true; }
  }
  const input = new FakeInput();
  const output = new FakeOutput();
  const originalListener = () => {};
  input.on('data', originalListener);
  const rl = {
    pause() {}, resume() {}, write() {}
  };
  const selection = selectTerminalList({ rl, items: ['一', '二'], input, output });
  setImmediate(() => input.emit('data', Buffer.from('q')));
  assert.equal(await selection, null);
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.deepEqual(input.listeners('data'), [originalListener]);
  assert.equal(output.listenerCount('resize'), 0);
  assert.match(output.chunks.join(''), /\x1b\[\?1049h/);
  assert.match(output.chunks.join(''), /\x1b\[\?1049l/);
});
