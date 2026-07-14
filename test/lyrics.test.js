import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLyric, mergeTranslatedLrc, parseLrc, plainLyrics } from '../src/lyrics.js';

const sample = '[00:01.50]第一句\n[00:03.000]第二句';

test('解析与定位逐行歌词', () => {
  const lines = parseLrc(sample);
  assert.deepEqual(lines, [
    { timeMs: 1500, text: '第一句' },
    { timeMs: 3000, text: '第二句' }
  ]);
  assert.equal(currentLyric(lines, 2000), '第一句');
  assert.equal(currentLyric(lines, 3500), '第二句');
});

test('移除 LRC 时间标签', () => {
  assert.equal(plainLyrics(sample), '第一句\n第二句');
});

test('支持一行多个时间标签与 offset', () => {
  assert.deepEqual(parseLrc('[offset:500]\n[00:01.000][00:02.000]重复句'), [
    { timeMs: 1500, text: '重复句' },
    { timeMs: 2500, text: '重复句' }
  ]);
});

test('按时间戳合并原文与翻译 LRC', () => {
  assert.equal(
    mergeTranslatedLrc('[00:01.000]Hello\n[00:02.000]World', '[00:01.000]你好\n[00:02.000]世界'),
    '[00:01.000]Hello\n[00:01.000]你好\n[00:02.000]World\n[00:02.000]世界'
  );
  assert.equal(
    mergeTranslatedLrc('[00:01.000]Hello', '[00:01.500]延迟翻译'),
    '[00:01.000]Hello\n[00:01.500]延迟翻译'
  );
});
