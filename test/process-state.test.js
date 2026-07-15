import test from 'node:test';
import assert from 'node:assert/strict';
import { hasProcessExited } from '../src/process-state.js';

test('进程以退出码或信号结束时都视为已经退出', () => {
  assert.equal(hasProcessExited(null), true);
  assert.equal(hasProcessExited({ exitCode: null, signalCode: null }), false);
  assert.equal(hasProcessExited({ exitCode: 0, signalCode: null }), true);
  assert.equal(hasProcessExited({ exitCode: null, signalCode: 'SIGTERM' }), true);
  assert.equal(hasProcessExited({}), false);
});
