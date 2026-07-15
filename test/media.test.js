import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackClock, lyricViewport, nextRefreshDelay, playbackAction, playerArguments } from '../src/media.js';

test('刷新间隔取下一秒与下一行歌词中的较早者', () => {
  const lines = [{ timeMs: 1800, text: 'next' }];
  assert.equal(nextRefreshDelay(1500, lines), 300);
  assert.equal(nextRefreshDelay(1000, [], false), 1000);
  assert.equal(nextRefreshDelay(1500, lines, true), 1000);
});

test('播放器偏移参数覆盖 ffplay/mpv/vlc', () => {
  assert.deepEqual(playerArguments('ffplay', 'song.mp3', 5).slice(-3), ['-ss', '5', 'song.mp3']);
  assert.ok(playerArguments('mpv', 'song.mp3', 5).includes('--start=5'));
  assert.ok(playerArguments('vlc', 'song.mp3', 5).includes('--start-time=5'));
});

test('播放快捷键解析 q、空格、方向键与 Ctrl+C', () => {
  assert.deepEqual(playbackAction('q'), { type: 'quit' });
  assert.deepEqual(playbackAction(' '), { type: 'toggle_pause' });
  assert.deepEqual(playbackAction('\u001b[D'), { type: 'seek', deltaMs: -5000 });
  assert.deepEqual(playbackAction('\u001b[C'), { type: 'seek', deltaMs: 5000 });
  assert.deepEqual(playbackAction('\u0003'), { type: 'interrupt' });
});

test('播放时钟支持暂停、继续和前后跳转并限制边界', () => {
  let now = 0;
  const clock = createPlaybackClock(10000, () => now);
  now = 2000;
  assert.equal(clock.position(), 2000);
  clock.pause();
  now = 5000;
  assert.equal(clock.position(), 2000);
  assert.equal(clock.seek(5000), 7000);
  clock.resume();
  now = 6000;
  assert.equal(clock.position(), 8000);
  assert.equal(clock.seek(5000), 10000);
  assert.equal(clock.seek(-15000), 0);
});

test('歌词视窗不超过容量并标记已播放与未播放', () => {
  const lines = Array.from({ length: 10 }, (_, index) => ({ timeMs: index * 1000, text: `line-${index}` }));
  const viewport = lyricViewport(lines, 3500, 5);
  assert.equal(viewport.length, 5);
  assert.ok(viewport.some((line) => line.played));
  assert.ok(viewport.some((line) => !line.played));
  assert.equal(viewport.filter((line) => line.current).length, 1);
});
