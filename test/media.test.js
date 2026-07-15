import test from 'node:test';
import assert from 'node:assert/strict';
import { attachLyricTranslations, createPlaybackClock, imageProtocolOrder, lyricViewport, nextRefreshDelay, playbackAction, playbackLyricRows, playerArguments, sixelPaddingRows, supportsSixelEnvironment, toggleTranslationState } from '../src/media.js';

test('SIXEL 只在已确认支持的终端环境启用', () => {
  assert.equal(supportsSixelEnvironment({ env: { WT_SESSION: 'session' }, platform: 'win32', windowsTerminalVersion: '1.21.9999.0' }), false);
  assert.equal(supportsSixelEnvironment({ env: { WT_SESSION: 'session' }, platform: 'win32', windowsTerminalVersion: '1.22.10352.0' }), true);
  assert.equal(supportsSixelEnvironment({ env: {}, platform: 'win32', windowsTerminalVersion: '1.24.0' }), false);
  assert.equal(supportsSixelEnvironment({ env: {}, platform: 'linux', detectedSixel: true }), true);
});

test('图像协议优先原生图形并保留安全降级顺序', () => {
  assert.deepEqual(imageProtocolOrder({ nativeGraphics: true, sixel: true, chafa: true }), ['native', 'sixel', 'symbols', 'ansi']);
  assert.deepEqual(imageProtocolOrder({ nativeGraphics: false, sixel: true, chafa: false }), ['ansi']);
  assert.deepEqual(imageProtocolOrder({ nativeGraphics: false, sixel: false, chafa: true }), ['symbols', 'ansi']);
});

test('SIXEL 输出后补足终端图像占用行数', () => {
  const chafaOutput = Buffer.from('\x1bPqSIXEL\x1b\\\r\n\x1b[?25h', 'latin1');
  assert.equal(sixelPaddingRows(20, chafaOutput), 19);
  assert.equal(sixelPaddingRows(1, chafaOutput), 0);
  assert.equal(sixelPaddingRows(5, '\x1bPqSIXEL\x1b\\'), 5);
  assert.equal(sixelPaddingRows(2, '\x1bPqSIXEL\x1b\\\n\n'), 0);
});

test('刷新间隔取下一秒与下一行歌词中的较早者', () => {
  const lines = [{ timeMs: 1800, text: 'next' }];
  assert.equal(nextRefreshDelay(1500, lines), 300);
  assert.equal(nextRefreshDelay(1000, [], false), 1000);
  assert.equal(nextRefreshDelay(1500, lines, true), 1000);
});

test('播放器偏移参数覆盖 ffplay/mpv/vlc', () => {
  assert.deepEqual(playerArguments('ffplay', 'song.mp3', 5, 80).slice(-5), ['-ss', '5', '-volume', '80', 'song.mp3']);
  assert.ok(playerArguments('mpv', 'song.mp3', 5).includes('--start=5'));
  assert.ok(playerArguments('vlc', 'song.mp3', 5).includes('--start-time=5'));
  assert.ok(playerArguments('mpv', 'song.mp3', 5, 80).includes('--volume=80'));
  assert.ok(playerArguments('vlc', 'song.mp3', 5, 80).includes('--volume=205'));
});

test('播放快捷键解析退出、暂停、跳转、音量、翻译与 Ctrl+C', () => {
  assert.deepEqual(playbackAction('q'), { type: 'quit' });
  assert.deepEqual(playbackAction(' '), { type: 'toggle_pause' });
  assert.deepEqual(playbackAction('\u001b[D'), { type: 'seek', deltaMs: -5000 });
  assert.deepEqual(playbackAction('\u001b[C'), { type: 'seek', deltaMs: 5000 });
  assert.deepEqual(playbackAction('\u001b[A'), { type: 'volume', delta: 5 });
  assert.deepEqual(playbackAction('\u001b[B'), { type: 'volume', delta: -5 });
  assert.deepEqual(playbackAction('t'), { type: 'toggle_translation' });
  assert.deepEqual(playbackAction('quit'), { type: 'ignore' });
  assert.deepEqual(playbackAction('text'), { type: 'ignore' });
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
  assert.equal(viewport.filter((line) => line.played && !line.current).length, 1);
  assert.equal(lyricViewport(lines, 3500, 1)[0].text, 'line-3');
});

test('翻译仅按相同时间戳附加并去除与原文相同的内容', () => {
  const original = [
    { timeMs: 1000, text: 'Hello' },
    { timeMs: 2000, text: 'World' }
  ];
  const translated = [
    { timeMs: 1000, text: '你好' },
    { timeMs: 1000, text: 'Hello' },
    { timeMs: 2100, text: '不应误配' }
  ];
  assert.deepEqual(attachLyricTranslations(original, translated), [
    { timeMs: 1000, text: 'Hello', translation: '你好' },
    { timeMs: 2000, text: 'World', translation: '' }
  ]);
});

test('翻译按实际终端行数裁剪且极小容量不溢出', () => {
  const lines = [
    { timeMs: 0, text: '过去', translation: 'past' },
    { timeMs: 1000, text: '当前', translation: 'current' },
    { timeMs: 2000, text: '未来', translation: 'future' }
  ];
  const rows = playbackLyricRows(lines, 1500, 3, true);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((line) => line.text), ['过去', '当前', 'current']);
  assert.deepEqual(playbackLyricRows(lines, 1500, 0, true), []);
  assert.deepEqual(playbackLyricRows(lines, 1500, 1, true).map((line) => line.text), ['当前']);
  assert.deepEqual(playbackLyricRows(lines, 1500, 2, true).map((line) => line.text), ['当前', 'current']);
  assert.deepEqual(playbackLyricRows(lines, 1500, 4, true).map((line) => line.text), ['过去', '当前', 'current', '未来']);
});

test('没有翻译时切换键保持关闭并提示暂无翻译', () => {
  assert.deepEqual(toggleTranslationState(false, false), { showTranslation: false, indicator: '暂无翻译' });
  assert.deepEqual(toggleTranslationState(true, false), { showTranslation: false, indicator: '暂无翻译' });
  assert.deepEqual(toggleTranslationState(true, true), { showTranslation: false, indicator: '翻译 已关闭' });
  assert.deepEqual(toggleTranslationState(false, true), { showTranslation: true, indicator: '翻译 已开启' });
});
