import test from 'node:test';
import assert from 'node:assert/strict';
import { ask } from '../src/cli.js';

function fakeReadline(history, answer = '子界面输入', error = null) {
  return {
    history,
    async question() {
      this.history.unshift(answer);
      if (error) throw error;
      return answer;
    }
  };
}

test('子界面输入不会进入 readline 历史', async () => {
  const rl = fakeReadline(['主页命令']);
  assert.equal(await ask(rl, '> '), '子界面输入');
  assert.deepEqual(rl.history, ['主页命令']);
});

test('主页输入保留在 readline 历史', async () => {
  const rl = fakeReadline(['旧搜索'], '新搜索');
  assert.equal(await ask(rl, '> ', undefined, { recordHistory: true }), '新搜索');
  assert.deepEqual(rl.history, ['新搜索', '旧搜索']);
});

test('子界面提问失败时仍恢复历史快照', async () => {
  const failure = new DOMException('取消', 'AbortError');
  const rl = fakeReadline(['主页命令'], '未完成输入', failure);
  await assert.rejects(ask(rl, '> '), failure);
  assert.deepEqual(rl.history, ['主页命令']);
});
