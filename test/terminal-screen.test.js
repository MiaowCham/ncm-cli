import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireTerminalScreen, terminalScreenDepth } from '../src/terminal-screen.js';

test('嵌套页面共享备用缓冲区，只有最外层负责进入和退出', () => {
  const chunks = [];
  const output = { isTTY: true, write: (chunk) => { chunks.push(String(chunk)); } };
  const releaseParent = acquireTerminalScreen(output);
  const releaseChild = acquireTerminalScreen(output);
  assert.equal(terminalScreenDepth(output), 2);
  releaseChild();
  assert.equal(terminalScreenDepth(output), 1);
  assert.equal(chunks.join(''), '\x1b[?1049h');
  releaseParent();
  assert.equal(terminalScreenDepth(output), 0);
  assert.equal(chunks.join(''), '\x1b[?1049h\x1b[?1049l');
});

test('页面释放函数重复调用不会提前退出备用缓冲区', () => {
  const chunks = [];
  const output = { isTTY: true, write: (chunk) => { chunks.push(String(chunk)); } };
  const release = acquireTerminalScreen(output);
  release();
  release();
  assert.equal(chunks.join(''), '\x1b[?1049h\x1b[?1049l');
});
