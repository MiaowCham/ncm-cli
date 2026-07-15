import test from 'node:test';
import assert from 'node:assert/strict';
import { adjustPlaybackOffset, attachLyricTranslations, createPlaybackClock, displayPosition, imageProtocolOrder, lyricPosition, lyricTone, lyricViewport, nextRefreshDelay, playbackAction, playbackLyricRows, playbackShortcutRows, playbackShortcutText, playbackTerminalModeSequence, playerArguments, playlistViewport, rawPosition, smtcTimeline, supportsSixelEnvironment, toggleTranslationState, wrapTerminalText } from '../src/media.js';
import stringWidth from 'string-width';

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

test('刷新间隔取下一秒与下一行歌词中的较早者', () => {
  const lines = [{ timeMs: 1800, text: 'next' }];
  assert.equal(nextRefreshDelay(1500, lines), 300);
  assert.equal(nextRefreshDelay(3500, lines, false, 2000), 300);
  assert.equal(nextRefreshDelay(1000, [], false), 1000);
  assert.equal(nextRefreshDelay(1500, lines, true), 1000);
});

test('歌词位置默认延后两秒并支持正负毫秒偏移', () => {
  assert.equal(lyricPosition(0), -2000);
  assert.equal(lyricPosition(3000), 1000);
  assert.equal(lyricPosition(3000, 0), 3000);
  assert.equal(lyricPosition(3000, -500), 3500);
  assert.equal(lyricPosition(3000, Number.NaN), 1000);
});

test('全局 offset 在展示时间与播放器原始时间之间双向换算', () => {
  assert.equal(displayPosition(5000, 2000), 3000);
  assert.equal(rawPosition(3000, 2000), 5000);
  assert.equal(rawPosition(0, 2000), 0);
  assert.equal(rawPosition(-1000, 2000), 0);
  assert.equal(displayPosition(5000, -500), 5500);
  assert.equal(rawPosition(5500, -500), 5000);
  assert.equal(rawPosition(0, -500), 0);
  const rawDuration = 240000;
  const displayedDuration = displayPosition(rawDuration, 2000);
  assert.equal(rawPosition(displayedDuration, 2000, rawDuration), rawDuration);
  assert.equal(rawPosition(displayedDuration + 5000, 2000, rawDuration), rawDuration);
  assert.equal(displayPosition(5000 + 5000, 2000) - displayPosition(5000, 2000), 5000);
  assert.equal(displayPosition(Number.NaN, Number.NaN), 0);
  assert.equal(rawPosition(Number.NaN, Number.NaN), 0);
});

test('歌词偏移在时间戳边界精确切换当前行', () => {
  const lines = [
    { timeMs: 0, text: '第一行' },
    { timeMs: 1000, text: '第二行' }
  ];
  assert.equal(lyricViewport(lines, lyricPosition(2999), 2)[0].text, '第一行');
  assert.equal(lyricViewport(lines, lyricPosition(3000), 2)[0].text, '第二行');
  assert.equal(lyricViewport(lines, lyricPosition(500, -500), 2)[0].text, '第二行');
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
  assert.deepEqual(playbackAction('p'), { type: 'toggle_playlist' });
  assert.deepEqual(playbackAction('\u001b[1;5D'), { type: 'playlist_previous' });
  assert.deepEqual(playbackAction('\u001b[5D'), { type: 'playlist_previous' });
  assert.deepEqual(playbackAction('\u001b[1;5C'), { type: 'playlist_next' });
  assert.deepEqual(playbackAction('\u001b[5C'), { type: 'playlist_next' });
  assert.deepEqual(playbackAction('\u001b[1;5A'), { type: 'offset', deltaMs: 50 });
  assert.deepEqual(playbackAction('\u001b[5A'), { type: 'offset', deltaMs: 50 });
  assert.deepEqual(playbackAction('\u001b[1;5B'), { type: 'offset', deltaMs: -50 });
  assert.deepEqual(playbackAction('\u001b[5B'), { type: 'offset', deltaMs: -50 });
  assert.deepEqual(playbackAction(`prefix\u001b[1;5Dsuffix`), { type: 'playlist_previous' });
  assert.deepEqual(playbackAction(`\u001b[D\u001b[1;5C`), { type: 'playlist_next' });
  assert.deepEqual(playbackAction('quit'), { type: 'ignore' });
  assert.deepEqual(playbackAction('text'), { type: 'ignore' });
  assert.deepEqual(playbackAction('\u0003'), { type: 'interrupt' });
});

test('歌单覆盖层接管上下键、Enter 和 Esc', () => {
  const options = { playlistOpen: true, playlistSelection: 3 };
  assert.deepEqual(playbackAction('\u001b[A', options), { type: 'playlist_move', delta: -1 });
  assert.deepEqual(playbackAction('\u001b[B', options), { type: 'playlist_move', delta: 1 });
  assert.deepEqual(playbackAction('\u001b[1;5A', options), { type: 'offset', deltaMs: 50 });
  assert.deepEqual(playbackAction('\u001b[1;5B', options), { type: 'offset', deltaMs: -50 });
  assert.deepEqual(playbackAction('\r', options), { type: 'playlist_select', index: 3 });
  assert.deepEqual(playbackAction('\u001b', options), { type: 'close_playlist' });
  assert.deepEqual(playbackAction('\u001b[A'), { type: 'volume', delta: 5 });
});

test('SGR 滚轮只在歌单覆盖层中移动选择且不影响音量', () => {
  const open = { playlistOpen: true, playlistSelection: 3 };
  assert.deepEqual(playbackAction('\u001b[<64;10;5M', open), { type: 'playlist_move', delta: -1 });
  assert.deepEqual(playbackAction('\u001b[<65;10;5M', open), { type: 'playlist_move', delta: 1 });
  assert.deepEqual(playbackAction('\u001b[<68;10;5M', open), { type: 'playlist_move', delta: -1 });
  assert.deepEqual(playbackAction('\u001b[<81;10;5M', open), { type: 'playlist_move', delta: 1 });
  assert.deepEqual(playbackAction('\u001b[<64;10;5m', open), { type: 'ignore' });
  assert.deepEqual(playbackAction('\u001b[<64;10;5M'), { type: 'ignore' });
  assert.deepEqual(playbackAction('\u001b[<0;10;5M', open), { type: 'ignore' });
  assert.deepEqual(playbackAction('\u001b[<0;10;5m', open), { type: 'ignore' });
  assert.deepEqual(playbackAction('\u001b[A'), { type: 'volume', delta: 5 });
  assert.deepEqual(playbackAction('\u001b[B', open), { type: 'playlist_move', delta: 1 });
  assert.deepEqual(playbackAction('\u001b[<64;1;1M\u001b[1;5C', open), { type: 'playlist_next' });
});

test('播放页鼠标报告模式进入与退出序列成对恢复', () => {
  assert.equal(playbackTerminalModeSequence(true), '\u001b[?1007l\u001b[?1000h\u001b[?1006h');
  assert.equal(playbackTerminalModeSequence(false), '\u001b[?1000l\u001b[?1006l\u001b[?1007h');
});

test('只有存在播放队列时快捷提示才显示歌单操作', () => {
  assert.equal(playbackShortcutText().includes('歌单'), false);
  assert.match(playbackShortcutText({ hasPlaylist: true }), /p 歌单/);
  assert.match(playbackShortcutText({ hasPlaylist: true, playlistOpen: true }), /Enter 播放/);
  assert.equal(playbackShortcutText({ hasPlaylist: false, playlistOpen: true }).includes('歌单'), false);
  assert.match(playbackShortcutText(), /Ctrl\+↑\/↓ 偏移/);
  assert.match(playbackShortcutText({ hasPlaylist: true, playlistOpen: true }), /Ctrl\+↑\/↓ 偏移/);
});

test('窄窗口中的快捷键提示按显示宽度换行而不是省略', () => {
  const source = playbackShortcutText({ hasPlaylist: true });
  const rows = playbackShortcutRows({ hasPlaylist: true }, 24);
  const segments = source.split(/\s{2,}/);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => stringWidth(row) <= 24));
  assert.equal(rows.join('').replaceAll(' ', ''), source.replaceAll(' ', ''));
  assert.ok(segments.every((segment) => stringWidth(segment) > 24 || rows.some((row) => row.includes(segment))));
  assert.deepEqual(wrapTerminalText('中文abc', 4), ['中文', 'abc']);
});

test('SMTC offset 只修正位置且不缩短歌曲物理时长', () => {
  assert.deepEqual(smtcTimeline(5000, 240000, 2000), { positionMs: 3000, durationMs: 240000 });
  // 普通 offset 与仅供 SMTC 校准的 offset 在调用处叠加。
  assert.deepEqual(smtcTimeline(5000, 240000, 2000 + 350), { positionMs: 2650, durationMs: 240000 });
  assert.equal(rawPosition(2650, 2000 + 350, 240000), 5000);
  assert.deepEqual(smtcTimeline(1000, 240000, 2000), { positionMs: 0, durationMs: 240000 });
  assert.deepEqual(smtcTimeline(240000, 240000, 2000), { positionMs: 240000, durationMs: 240000 });
  assert.deepEqual(smtcTimeline(250000, 240000, -2000), { positionMs: 240000, durationMs: 240000 });
});

test('播放时间偏移每次调整 50ms 并限制在正负 60000ms', () => {
  assert.equal(adjustPlaybackOffset(2000, 50), 2050);
  assert.equal(adjustPlaybackOffset(2000, -50), 1950);
  assert.equal(adjustPlaybackOffset(59975, 50), 60000);
  assert.equal(adjustPlaybackOffset(60000, 50), 60000);
  assert.equal(adjustPlaybackOffset(-59975, -50), -60000);
  assert.equal(adjustPlaybackOffset(-60000, -50), -60000);
  assert.equal(adjustPlaybackOffset(Number.NaN, 50), 50);
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
  assert.equal(clock.seekTo(7500), 7500);
  assert.equal(clock.seekTo(20000), 10000);
});

test('播放器重启等待期间可冻结播放时钟避免吞掉音频片段', () => {
  let now = 0;
  const clock = createPlaybackClock(10000, () => now);
  now = 1200;
  clock.pause();
  now = 3200;
  assert.equal(clock.position(), 1200);
  clock.resume();
  now = 3700;
  assert.equal(clock.position(), 1700);
});

test('歌词视窗只显示当前行和未来行且不超过容量', () => {
  const lines = Array.from({ length: 10 }, (_, index) => ({ timeMs: index * 1000, text: `line-${index}` }));
  const viewport = lyricViewport(lines, 3500, 5);
  assert.equal(viewport.length, 5);
  assert.ok(viewport.some((line) => line.played));
  assert.ok(viewport.some((line) => !line.played));
  assert.equal(viewport.filter((line) => line.current).length, 1);
  assert.equal(viewport.filter((line) => line.played && !line.current).length, 0);
  assert.equal(viewport[0].text, 'line-3');
  assert.equal(lyricViewport(lines, 3500, 1)[0].text, 'line-3');
});

test('歌单视窗保持选择项可见并分别标记选择与正在播放', () => {
  const tracks = Array.from({ length: 10 }, (_, index) => ({ name: `song-${index}` }));
  const viewport = playlistViewport(tracks, 8, 2, 4);
  assert.equal(viewport.start, 6);
  assert.deepEqual(viewport.rows.map((row) => row.index), [6, 7, 8, 9]);
  assert.equal(viewport.rows.find((row) => row.selected)?.index, 8);
  assert.equal(viewport.rows.some((row) => row.current), false);

  const withCurrent = playlistViewport(tracks, 2, 2, 5);
  assert.equal(withCurrent.rows.find((row) => row.selected)?.current, true);
  assert.deepEqual(playlistViewport([], 0, 0, 3), { start: 0, selectedIndex: -1, rows: [] });
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
  assert.deepEqual(rows.map((line) => line.text), ['当前', 'current', '未来']);
  assert.deepEqual(playbackLyricRows(lines, 1500, 0, true), []);
  assert.deepEqual(playbackLyricRows(lines, 1500, 1, true).map((line) => line.text), ['当前']);
  assert.deepEqual(playbackLyricRows(lines, 1500, 2, true).map((line) => line.text), ['当前', 'current']);
  assert.deepEqual(playbackLyricRows(lines, 1500, 4, true).map((line) => line.text), ['当前', 'current', '未来', 'future']);
});

test('未播放的原文和翻译使用相同的颜色角色', () => {
  assert.equal(lyricTone({ current: false, played: false, translation: false }), 'future');
  assert.equal(lyricTone({ current: false, played: false, translation: true }), 'future');
});

test('没有翻译时切换键保持关闭并提示暂无翻译', () => {
  assert.deepEqual(toggleTranslationState(false, false), { showTranslation: false, indicator: '暂无翻译' });
  assert.deepEqual(toggleTranslationState(true, false), { showTranslation: false, indicator: '暂无翻译' });
  assert.deepEqual(toggleTranslationState(true, true), { showTranslation: false, indicator: '翻译 已关闭' });
  assert.deepEqual(toggleTranslationState(false, true), { showTranslation: true, indicator: '翻译 已开启' });
});
