import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { addLyricInterludes, adjustPlaybackOffset, ansiImageLimits, attachLyricTranslations, compactPlaybackRequiredRow, createLatestDebounce, createLatestTerminalWriter, createPlaybackClock, displayPosition, findPlayer, imageProtocolOrder, isTermuxEnvironment, LOOP_MODES, lyricPosition, lyricTone, lyricViewport, nextRefreshDelay, planCoverSize, planPlaybackVerticalLayout, playbackAction, playbackChromeRows, playbackCoverRowBudget, playbackCreditsConfig, playbackDynamicRows, playbackEntrySequence, playbackImportPromptSequence, playbackLyricRows, playbackMetadataRows, playbackMouseTrackingSequence, playbackPlaylistModeRows, playbackPlaylistModeText, playbackPlaylistOverlayRows, playbackPrioritizedRows, playbackProgressSegments, playbackProgressText, playbackPureOverlayLayout, playbackRowsWithTopSpacer, playbackShortcutRows, playbackShortcutText, playbackTerminalModeSequence, playerArguments, playerBackendLabel, playerCommandsForBackend, playlistViewport, prepareSixelRender, RANDOM_MODES, rawPosition, resolveCommandExecutable, runPlaybackExitSequence, shouldSyncPlayerPosition, shuffledPlaylistOrder, sixelCursorBox, smtcTimeline, startTrackWithPreparedHeader, supportsSixelEnvironment, terminatePlayer, toggleTranslationState, waitWithSignal, wrapTerminalText } from '../src/media.js';
import stringWidth from 'string-width';
import { createTrackOffsetSession } from '../src/media.js';

test('SIXEL 只在已确认支持的终端环境启用', () => {
  assert.equal(supportsSixelEnvironment({ env: { WT_SESSION: 'session' }, platform: 'win32', windowsTerminalVersion: '1.21.9999.0' }), false);
  assert.equal(supportsSixelEnvironment({ env: { WT_SESSION: 'session' }, platform: 'win32', windowsTerminalVersion: '1.22.10352.0' }), true);
  assert.equal(supportsSixelEnvironment({ env: {}, platform: 'win32', windowsTerminalVersion: '1.24.0' }), false);
  assert.equal(supportsSixelEnvironment({ env: {}, platform: 'linux', detectedSixel: true }), true);
});

test('图像协议优先原生图形并保留安全降级顺序', () => {
  assert.deepEqual(imageProtocolOrder({ kitty: true, sixel: true, chafa: true }), ['kitty', 'sixel', 'symbols', 'ansi']);
  assert.deepEqual(imageProtocolOrder({ nativeGraphics: false, sixel: true, chafa: false }), ['ansi']);
  assert.deepEqual(imageProtocolOrder({ nativeGraphics: false, sixel: false, chafa: true }), ['symbols', 'ansi']);
  assert.deepEqual(imageProtocolOrder({ preference: 'sixel', sixel: true, chafa: true }), ['sixel', 'ansi']);
  assert.deepEqual(imageProtocolOrder({ preference: 'sixel', sixel: false, chafa: true }), ['sixel', 'ansi']);
  assert.deepEqual(imageProtocolOrder({ preference: 'sixel', sixel: true, chafa: false }), ['ansi']);
  assert.deepEqual(imageProtocolOrder({ preference: 'kitty', kitty: false }), ['ansi']);
  assert.deepEqual(imageProtocolOrder({ preference: 'ansi256' }), ['ansi256']);
  assert.deepEqual(imageProtocolOrder({ preference: 'none' }), []);
});

test('刷新间隔取下一秒与下一行歌词中的较早者', () => {
  const lines = [{ timeMs: 1800, text: 'next' }];
  assert.equal(nextRefreshDelay(1500, lines), 300);
  assert.equal(nextRefreshDelay(3500, lines, false, 2000), 300);
  assert.equal(nextRefreshDelay(1000, [], false), 1000);
  assert.equal(nextRefreshDelay(1500, lines, true), 1000);
  assert.equal(nextRefreshDelay(1500, lines, false, 0, 16), 16);
});

test('普通播放器和彩蛋都把内容放在底部控制区之前', () => {
  const rows = {
    progress: '进度条',
    modeRows: ['随机/循环'],
    shortcutRows: ['快捷键'],
    indicatorRow: '状态',
    contentRows: ['动画 1', '动画 2'],
    availableRows: 6
  };
  assert.deepEqual(playbackDynamicRows(rows), [
    '动画 1', '动画 2', '状态', '进度条', '随机/循环', '快捷键'
  ]);
  assert.deepEqual(playbackDynamicRows({ ...rows, contentRows: ['当前歌词'], availableRows: 7 }), [
    '当前歌词', '', '', '状态', '进度条', '随机/循环', '快捷键'
  ]);
});

test('普通歌词顶部预留空行且极小容量优先保留歌词', () => {
  assert.deepEqual(playbackRowsWithTopSpacer(['当前歌词', '未来歌词'], 4), [
    '', '当前歌词', '未来歌词'
  ]);
  assert.deepEqual(playbackRowsWithTopSpacer(['当前歌词'], 1), ['当前歌词']);
  assert.deepEqual(playbackRowsWithTopSpacer(['当前歌词'], 0), []);
});

test('极矮播放器分阶段压缩未来歌词、歌曲信息、封面和控制区', () => {
  const full = {
    coverRows: 8,
    metadataRows: 5,
    metadataSpacerRows: 1,
    futureLyricRows: 4,
    modeRows: 1,
    shortcutRows: 2,
    statusRows: 1,
    currentLyricRows: 1,
    progressRows: 1
  };
  assert.deepEqual(planPlaybackVerticalLayout({ rows: 24, ...full }), {
    ...full, compactRequired: false, capacity: 24, unusedRows: 0
  });
  assert.equal(planPlaybackVerticalLayout({ rows: 23, ...full }).futureLyricRows, 3);
  assert.equal(planPlaybackVerticalLayout({ rows: 22, ...full }).futureLyricRows, 2);
  assert.equal(planPlaybackVerticalLayout({ rows: 21, ...full }).metadataRows, 4);
  assert.equal(planPlaybackVerticalLayout({ rows: 18, ...full }).metadataRows, 1);
  assert.deepEqual(
    (({ coverRows, metadataRows, metadataSpacerRows, futureLyricRows }) => (
      { coverRows, metadataRows, metadataSpacerRows, futureLyricRows }
    ))(
      planPlaybackVerticalLayout({ rows: 17, ...full })
    ),
    { coverRows: 7, metadataRows: 1, metadataSpacerRows: 1, futureLyricRows: 2 }
  );
  assert.equal(planPlaybackVerticalLayout({ rows: 16, ...full }).coverRows, 0);
  assert.equal(planPlaybackVerticalLayout({ rows: 10, ...full }).metadataSpacerRows, 1);
  assert.deepEqual(
    (({ metadataRows, metadataSpacerRows }) => ({ metadataRows, metadataSpacerRows }))(
      planPlaybackVerticalLayout({ rows: 9, ...full })
    ),
    { metadataRows: 0, metadataSpacerRows: 0 }
  );
  assert.equal(planPlaybackVerticalLayout({ rows: 8, ...full }).futureLyricRows, 2);
  assert.equal(planPlaybackVerticalLayout({ rows: 7, ...full }).futureLyricRows, 1);
  assert.equal(planPlaybackVerticalLayout({ rows: 6, ...full }).futureLyricRows, 0);
  assert.equal(planPlaybackVerticalLayout({ rows: 5, ...full }).modeRows, 0);
  assert.equal(planPlaybackVerticalLayout({ rows: 4, ...full }).shortcutRows, 0);
  assert.equal(planPlaybackVerticalLayout({ rows: 2, ...full }).statusRows, 0);
  assert.deepEqual(
    (({ currentLyricRows, progressRows, compactRequired }) => ({ currentLyricRows, progressRows, compactRequired }))(
      planPlaybackVerticalLayout({ rows: 1, ...full })
    ),
    { currentLyricRows: 0, progressRows: 1, compactRequired: false }
  );
});

test('播放器封面预算至少七行并随终端高度增长', () => {
  assert.equal(playbackCoverRowBudget(1), 0);
  assert.equal(playbackCoverRowBudget(6), 7);
  assert.equal(playbackCoverRowBudget(24), 9);
  assert.equal(playbackCoverRowBudget(100), 40);
});

test('歌曲信息只剩一行时合并显示歌曲名和歌手', () => {
  const song = { name: '歌曲名', artists: ['歌手甲', '歌手乙'], album: '专辑', id: 123 };
  assert.match(playbackMetadataRows(song, 'mpv', 80, 1)[0], /歌曲名 - 歌手甲\/歌手乙/);
  const narrow = playbackMetadataRows({ ...song, name: '特别特别长的歌曲名称' }, 'mpv', 18, 1)[0];
  assert.match(narrow, / - /);
  assert.match(narrow, / - …$/);
  assert.ok(stringWidth(narrow) <= 18);
  const titleFirst = playbackMetadataRows({
    ...song, name: '完整歌名', artists: ['特别特别长的歌手名称']
  }, 'mpv', 18, 1)[0];
  assert.match(titleFirst, /^完整歌名 - /);
  assert.ok(stringWidth(titleFirst) <= 18);
  assert.deepEqual(playbackMetadataRows(song, 'mpv', 80, 0), []);
  const pureMetadata = playbackMetadataRows(song, 'mpv', 80, 2);
  assert.equal(pureMetadata.length, 2);
  assert.match(pureMetadata[0], /歌曲名/);
  assert.match(pureMetadata[1], /^歌手：歌手甲\/歌手乙$/);
  assert.doesNotMatch(pureMetadata.join('\n'), /专辑|播放器|ID/);
});

test('动态播放器优先保留当前歌词和进度条并保持状态在进度条上方', () => {
  const rows = {
    progress: '进度',
    modeRows: ['歌单控制'],
    shortcutRows: ['歌曲控制一', '歌曲控制二'],
    indicatorRow: '状态',
    requiredContentRows: ['当前歌词'],
    optionalPrefixRows: [''],
    optionalSuffixRows: ['未来歌词一', '未来歌词二'],
    columns: 80
  };
  assert.deepEqual(playbackPrioritizedRows({ ...rows, availableRows: 8 }), [
    '', '当前歌词', '未来歌词一', '状态', '进度', '歌单控制', '歌曲控制一', '歌曲控制二'
  ]);
  assert.deepEqual(playbackPrioritizedRows({ ...rows, availableRows: 5 }), [
    '当前歌词', '状态', '进度', '歌曲控制一', '歌曲控制二'
  ]);
  assert.deepEqual(playbackPrioritizedRows({ ...rows, availableRows: 2 }), ['当前歌词', '进度']);
});

test('Credits EX 单行歌词按动态区域实际高度把控制区固定到底部', () => {
  const layout = planPlaybackVerticalLayout({
    rows: 24,
    coverRows: 8,
    metadataRows: 5,
    metadataSpacerRows: 1,
    futureLyricRows: 24,
    shortcutRows: 1,
    statusRows: 1,
    currentLyricRows: 1,
    progressRows: 1
  });
  const rows = playbackPrioritizedRows({
    progress: '进度',
    shortcutRows: ['歌曲控制'],
    indicatorRow: '状态',
    requiredContentRows: ['当前歌词'],
    optionalPrefixRows: [''],
    availableRows: 12,
    columns: 80,
    layout
  });
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.slice(-3), ['状态', '进度', '歌曲控制']);
});

test('歌曲信息消失后暂停时显示歌名，一行播放器只保留进度条', () => {
  assert.equal(compactPlaybackRequiredRow('当前歌词', '进度', 9), '当… 进度');
  assert.deepEqual(playbackPrioritizedRows({
    progress: '进度', requiredContentRows: ['当前歌词'], compactPausedRow: '歌曲名',
    paused: false, availableRows: 2, columns: 9
  }), ['当前歌词', '进度']);
  assert.deepEqual(playbackPrioritizedRows({
    progress: '进度', requiredContentRows: ['当前歌词'], compactPausedRow: '歌曲名 - 歌手名',
    paused: true, replacePausedContent: true, availableRows: 5, columns: 9
  }), ['歌曲名 - 歌手名', '', '', '', '进度']);
  assert.deepEqual(playbackPrioritizedRows({
    progress: '进度', requiredContentRows: ['当前歌词'], compactPausedRow: '歌曲名',
    paused: true, replacePausedContent: false, availableRows: 2, columns: 9,
    layout: planPlaybackVerticalLayout({
      rows: 4, metadataRows: 1, metadataSpacerRows: 1, currentLyricRows: 1, progressRows: 1
    })
  }), ['当前歌词', '进度']);
  assert.deepEqual(playbackPrioritizedRows({
    progress: '进度', requiredContentRows: ['当前歌词'], compactPausedRow: '歌曲名',
    paused: true, replacePausedContent: false, availableRows: 2, columns: 9,
    layout: planPlaybackVerticalLayout({
      rows: 2, metadataRows: 0, currentLyricRows: 1, progressRows: 1
    })
  }), ['当前歌词', '进度']);
  assert.deepEqual(playbackPrioritizedRows({
    progress: '进度', requiredContentRows: ['当前歌词'], compactPausedRow: '歌曲名 - 歌手名',
    paused: true, replacePausedContent: true, availableRows: 2, columns: 9
  }), ['歌曲名 - 歌手名', '进度']);
  assert.deepEqual(playbackPrioritizedRows({
    progress: '进度', requiredContentRows: ['当前歌词'], availableRows: 1, columns: 9
  }), ['进度']);
});

test('详情和播放器封面保持常规尺寸并随终端继续放大', () => {
  assert.deepEqual(planCoverSize({ columns: 80, rows: 48 }), { width: 38, height: 19 });
  assert.deepEqual(planCoverSize({ columns: 160, rows: 100 }), { width: 80, height: 40 });
  assert.deepEqual(planCoverSize({ columns: 240, rows: 180 }), { width: 144, height: 72 });
  assert.deepEqual(planCoverSize({ columns: 800, rows: 1000 }), { width: 798, height: 400 });
  assert.equal(playbackCoverRowBudget(100), 40);
});

test('窄长终端保留纵向预算但不拉伸封面且遵守性能上限', () => {
  assert.deepEqual(planCoverSize({ columns: 40, rows: 100, maxRows: 60 }), { width: 38, height: 40 });
  assert.deepEqual(planCoverSize({
    columns: 200, rows: 100, maxRows: 60, imageRenderMaxRows: 24
  }), { width: 48, height: 24 });
  assert.equal(playbackCoverRowBudget(100, 24), 24);
  assert.equal(playbackCoverRowBudget(100, 1), 7);
});

test('SIXEL 输出固定恢复并下移到约定图片高度', () => {
  const sixel = Buffer.from('\x1bPqpayload\x1b\\\x1b[?25h');
  assert.deepEqual(
    sixelCursorBox(sixel, 8),
    Buffer.concat([Buffer.from('\x1b7'), sixel, Buffer.from('\x1b8\x1b[8E')])
  );
});

test('纯净模式只保留两行歌曲信息并隐藏快捷键区域', () => {
  assert.deepEqual(playbackChromeRows({
    pureMode: true, metadataRows: 5, modeRows: 1, shortcutRows: 3
  }), {
    metadataRows: 2, metadataSpacerRows: 0, modeRows: 1, shortcutRows: 0
  });
  assert.deepEqual(playbackChromeRows({
    metadataRows: 5, modeRows: 2, shortcutRows: 3
  }), {
    metadataRows: 5, metadataSpacerRows: 1, modeRows: 2, shortcutRows: 3
  });
});

test('纯净模式为 Credits 单行歌词保留歌手后的空行', () => {
  const chrome = playbackChromeRows({
    pureMode: true,
    preserveLyricSpacer: playbackCreditsConfig({ id: 405372425 }, true)?.currentLyricOnly,
    metadataRows: 5,
    shortcutRows: 2
  });
  assert.deepEqual(chrome, {
    metadataRows: 2, metadataSpacerRows: 1, modeRows: 0, shortcutRows: 0
  });
  const layout = planPlaybackVerticalLayout({
    rows: 10,
    ...chrome,
    futureLyricRows: 10,
    statusRows: 1,
    currentLyricRows: 1,
    progressRows: 1
  });
  const dynamicRows = playbackPrioritizedRows({
    progress: '进度',
    indicatorRow: '状态',
    requiredContentRows: ['当前歌词'],
    optionalPrefixRows: [''],
    availableRows: 8,
    columns: 80,
    layout
  });
  assert.deepEqual(dynamicRows.slice(0, 2), ['', '当前歌词']);

  const compact = planPlaybackVerticalLayout({
    rows: 3,
    ...chrome,
    futureLyricRows: 3,
    statusRows: 1,
    currentLyricRows: 1,
    progressRows: 1
  });
  assert.equal(compact.metadataRows, 0);
  assert.equal(compact.metadataSpacerRows, 0);
});

test('纯净模式不禁用 Credits 彩蛋', () => {
  const timedCredits = playbackCreditsConfig({ id: 405372425 }, true);
  const directCredits = playbackCreditsConfig({ id: 2053695037 }, true);
  assert.equal(timedCredits?.mode, 'credits-csf');
  assert.equal(timedCredits?.currentLyricOnly, true);
  assert.equal(directCredits?.mode, 'credits-csf');
  assert.equal(directCredits?.directAnimation, true);
});

test('纯净模式展开歌单时仍在底部保留状态、进度和随机循环', () => {
  const layout = playbackPureOverlayLayout(10, 1);
  assert.equal(layout.futureLyricRows, 7);
  const rows = playbackPrioritizedRows({
    progress: '进度',
    modeRows: ['随机/循环'],
    indicatorRow: '状态',
    optionalSuffixRows: Array.from({ length: 7 }, (_, index) => `曲目${index + 1}`),
    availableRows: 10,
    columns: 80,
    layout
  });
  assert.deepEqual(rows.slice(-3), ['状态', '进度', '随机/循环']);
  assert.equal(rows.length, 10);
});

test('SIXEL 成功结果携带确定行数且不会被误判为协议失败', () => {
  const sixel = Buffer.from('\x1bPqpayload\x1b\\');
  assert.deepEqual(prepareSixelRender(sixel, 8), {
    output: sixelCursorBox(sixel, 8),
    resultRows: 8
  });
  assert.equal(prepareSixelRender('plain text', 8), null);
  assert.equal(prepareSixelRender(sixel, 0).resultRows, 1);
});

test('ANSI 256 色模式单独限制尺寸且真彩 ANSI 保留原始大小', () => {
  assert.equal(isTermuxEnvironment({ TERMUX_VERSION: '0.119' }), true);
  assert.equal(isTermuxEnvironment({ PREFIX: '/data/data/com.termux/files/usr' }), true);
  assert.deepEqual(ansiImageLimits(52, 20, true), {
    width: 32, rows: 12, compactColor: true
  });
  assert.deepEqual(ansiImageLimits(52, 20, false), {
    width: 52, rows: 20, compactColor: false
  });
});

test('慢终端输出只保留一个正在写入帧和最新待写帧', () => {
  class SlowStream extends EventEmitter {
    writes = [];
    callbacks = [];
    write(output, callback) {
      this.writes.push(output);
      this.callbacks.push(callback);
      return false;
    }
  }
  const stream = new SlowStream();
  const writer = createLatestTerminalWriter(stream);
  writer.write('frame-1');
  writer.write('frame-2');
  writer.write('frame-3');
  assert.deepEqual(stream.writes, ['frame-1']);
  stream.callbacks.shift()();
  assert.deepEqual(stream.writes, ['frame-1']);
  stream.emit('drain');
  assert.deepEqual(stream.writes, ['frame-1', 'frame-3']);
  writer.write('frame-4');
  writer.write('frame-5');
  stream.callbacks.shift()();
  stream.emit('drain');
  assert.deepEqual(stream.writes, ['frame-1', 'frame-3', 'frame-5']);
  writer.close();
  assert.equal(stream.listenerCount('drain'), 0);
});

test('终端写入器聚合记录阻塞时长和被替换帧数', () => {
  class DelayedStream extends EventEmitter {
    writes = [];
    callbacks = [];
    write(output, callback) {
      this.writes.push(output);
      this.callbacks.push(callback);
      return true;
    }
  }
  let clock = 0;
  const diagnostics = [];
  const stream = new DelayedStream();
  const writer = createLatestTerminalWriter(stream, {
    now: () => clock,
    diagnosticThresholdMs: 250,
    onDiagnostic: (entry) => diagnostics.push(entry)
  });
  writer.write('frame-1');
  writer.write('frame-2');
  writer.write('frame-3');
  clock = 400;
  stream.callbacks.shift()();
  clock = 600;
  stream.callbacks.shift()();
  writer.close();
  assert.deepEqual(stream.writes, ['frame-1', 'frame-3']);
  assert.equal(diagnostics[0].type, 'backpressure');
  assert.equal(diagnostics[0].durationMs, 600);
  assert.equal(diagnostics[0].droppedFrames, 1);
  assert.equal(diagnostics.at(-1).type, 'summary');
  assert.equal(diagnostics.at(-1).droppedFrames, 1);
});

test('退出阶段失败不会阻止后续清理和最终完成', async () => {
  const events = [];
  await runPlaybackExitSequence({
    stop: async () => { events.push('stop'); throw new Error('stop failed'); },
    transition: async () => { events.push('transition'); throw new Error('transition failed'); },
    onError: async (_error, stage) => { events.push(`error:${stage}`); }
  });
  assert.deepEqual(events, ['stop', 'error:stop', 'transition', 'error:transition']);
});

test('直接彩蛋等待页面转场完成后才启动音频', async () => {
  const events = [];
  let releaseHeader;
  const headerReady = new Promise((resolve) => { releaseHeader = resolve; });
  const starting = startTrackWithPreparedHeader({
    directAnimation: true,
    drawHeader: async () => {
      events.push('transition:start');
      await headerReady;
      events.push('transition:complete');
    },
    startPlayback: async () => { events.push('playback:start'); }
  });
  await Promise.resolve();
  assert.deepEqual(events, ['transition:start']);
  releaseHeader();
  await starting;
  assert.deepEqual(events, ['transition:start', 'transition:complete', 'playback:start']);
});

test('取消直接彩蛋的头部准备后不会再启动音频', async () => {
  const controller = new AbortController();
  const events = [];
  let observedSignal;
  const starting = startTrackWithPreparedHeader({
    directAnimation: true,
    signal: controller.signal,
    drawHeader: async (signal) => {
      observedSignal = signal;
      events.push('header:start');
      await new Promise(() => {});
    },
    startPlayback: async () => { events.push('playback:start'); }
  });
  await Promise.resolve();
  controller.abort(new DOMException('测试取消', 'AbortError'));
  const started = await starting;
  assert.equal(observedSignal, controller.signal);
  assert.equal(started, false);
  assert.deepEqual(events, ['header:start']);
});

test('彩蛋时间可由普通播放 offset 校准', () => {
  assert.equal(displayPosition(5000, 2000), 3000);
  assert.equal(displayPosition(5000, -500), 5500);
});

test('歌词位置默认无偏移并支持正负毫秒偏移', () => {
  assert.equal(lyricPosition(0), 0);
  assert.equal(lyricPosition(3000), 3000);
  assert.equal(lyricPosition(3000, 0), 3000);
  assert.equal(lyricPosition(3000, -500), 3500);
  assert.equal(lyricPosition(3000, Number.NaN), 3000);
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
  assert.equal(lyricViewport(lines, lyricPosition(2999, 2000), 2)[0].text, '第一行');
  assert.equal(lyricViewport(lines, lyricPosition(3000, 2000), 2)[0].text, '第二行');
  assert.equal(lyricViewport(lines, lyricPosition(500, -500), 2)[0].text, '第二行');
});

test('播放器偏移参数覆盖 ffplay/mpv/vlc', () => {
  assert.deepEqual(playerArguments('ffplay', 'song.mp3', 5, 80).slice(-5), ['-ss', '5', '-volume', '80', 'song.mp3']);
  assert.ok(playerArguments('mpv', 'song.mp3', 5).includes('--start=5'));
  assert.ok(playerArguments('vlc', 'song.mp3', 5).includes('--start-time=5'));
  assert.ok(playerArguments('mpv', 'song.mp3', 5, 80).includes('--volume=80'));
  assert.ok(playerArguments('vlc', 'song.mp3', 5, 80).includes('--volume=205'));
});

test('播放器后端标签区分常驻控制与兼容模式', () => {
  assert.equal(playerBackendLabel('mpv'), 'mpv（JSON IPC）');
  assert.equal(playerBackendLabel('vlc'), 'VLC（oldrc）');
  assert.equal(playerBackendLabel('media-player'), 'Windows MediaPlayer（WinRT）');
  assert.equal(playerBackendLabel('cvlc', { persistent: false }), 'VLC（兼容模式）');
  assert.equal(playerBackendLabel('ffplay'), 'ffplay（兼容模式）');
  assert.equal(playerBackendLabel(null), '未找到');
});

test('播放器设置映射到受限候选列表', () => {
  assert.deepEqual(playerCommandsForBackend('auto', { platform: 'win32' }), ['mpv', 'vlc', 'cvlc', 'media-player', 'ffplay']);
  assert.deepEqual(playerCommandsForBackend('auto', { platform: 'linux' }), ['mpv', 'vlc', 'cvlc', 'ffplay']);
  assert.deepEqual(playerCommandsForBackend('mpv'), ['mpv']);
  assert.deepEqual(playerCommandsForBackend('vlc'), ['vlc', 'cvlc']);
  assert.deepEqual(playerCommandsForBackend('media-player'), ['media-player']);
  assert.deepEqual(playerCommandsForBackend('ffplay'), ['ffplay']);
});

test('Windows 明确解析 exe，避免裸 mpv 优先命中 mpv.com', () => {
  const calls = [];
  const executable = resolveCommandExecutable('mpv', {
    platform: 'win32',
    probe(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: 'F:\\mpv\\mpv.exe\r\n' };
    }
  });
  assert.equal(executable, 'F:\\mpv\\mpv.exe');
  assert.deepEqual(calls, [{ command: 'where.exe', args: ['mpv.exe'] }]);
});

test('播放快捷键解析退出、刷新、暂停、跳转、音量、翻译与 Ctrl+C', () => {
  assert.deepEqual(playbackAction('q'), { type: 'quit' });
  assert.deepEqual(playbackAction('r'), { type: 'refresh' });
  assert.deepEqual(playbackAction('i'), { type: 'import_lyrics' });
  assert.deepEqual(playbackAction('m'), { type: 'toggle_pure_mode' });
  assert.deepEqual(playbackAction('M'), { type: 'toggle_pure_mode' });
  assert.deepEqual(playbackAction('R'), { type: 'refresh' });
  assert.deepEqual(playbackAction(' '), { type: 'toggle_pause' });
  assert.deepEqual(playbackAction('\u001b[D'), { type: 'seek', deltaMs: -5000 });
  assert.deepEqual(playbackAction('\u001b[C'), { type: 'seek', deltaMs: 5000 });
  assert.deepEqual(playbackAction('\u001b[A'), { type: 'volume', delta: 5 });
  assert.deepEqual(playbackAction('\u001b[B'), { type: 'volume', delta: -5 });
  assert.deepEqual(playbackAction('t'), { type: 'toggle_translation' });
  assert.deepEqual(playbackAction('f'), { type: 'favorite' });
  assert.deepEqual(playbackAction('F'), { type: 'favorite' });
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

test('歌单覆盖层接管上下键、Enter、q 和 Esc', () => {
  const options = { playlistOpen: true, playlistSelection: 3 };
  assert.deepEqual(playbackAction('\u001b[A', options), { type: 'playlist_move', delta: -1 });
  assert.deepEqual(playbackAction('\u001b[B', options), { type: 'playlist_move', delta: 1 });
  assert.deepEqual(playbackAction('\u001b[1;5A', options), { type: 'offset', deltaMs: 50 });
  assert.deepEqual(playbackAction('\u001b[1;5B', options), { type: 'offset', deltaMs: -50 });
  assert.deepEqual(playbackAction('\r', options), { type: 'playlist_select', index: 3 });
  assert.deepEqual(playbackAction('q', options), { type: 'close_playlist' });
  assert.deepEqual(playbackAction('Q', options), { type: 'close_playlist' });
  assert.deepEqual(playbackAction('\u001b', options), { type: 'close_playlist' });
  assert.deepEqual(playbackAction('\u001b[A'), { type: 'volume', delta: 5 });
});

test('播放页用两个独立按键切换随机和循环模式', () => {
  assert.deepEqual(playbackAction('s'), { type: 'cycle_random_mode' });
  assert.deepEqual(playbackAction('l'), { type: 'cycle_loop_mode' });
  assert.deepEqual(RANDOM_MODES, ['off', 'random', 'shuffle']);
  assert.deepEqual(LOOP_MODES, ['sequence', 'list', 'single']);
});

test('打乱列表保留当前歌曲为起点且每首只出现一次', () => {
  const values = [0.1, 0.8, 0.3];
  const order = shuffledPlaylistOrder(5, 2, () => values.shift() ?? 0);
  assert.equal(order[0], 2);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
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

test('直接彩蛋入场保留调用页，普通播放器仍会清屏', () => {
  assert.doesNotMatch(playbackEntrySequence(true), /\x1b\[2J/);
  assert.match(playbackEntrySequence(false), /\x1b\[2J\x1b\[H/);
});

test('常驻快捷提示不混入歌单操作', () => {
  assert.equal(playbackShortcutText().includes('歌单'), false);
  assert.equal(playbackShortcutText({ hasPlaylist: true }).includes('歌单'), false);
  assert.match(playbackShortcutText(), /Ctrl\+↑\/↓ 偏移/);
  assert.match(playbackShortcutText(), /m 纯净模式/);
  assert.match(playbackShortcutText(), /r 刷新/);
  assert.equal(playbackShortcutText().includes('收藏'), false);
  assert.match(playbackShortcutText({ canFavorite: true }), /f 收藏/);
  assert.match(playbackShortcutText({ canFavorite: true, favorited: true }), /f 取消收藏/);
});

test('随机循环指示器包含按键和歌单播放操作', () => {
  const closed = playbackPlaylistModeText({ randomLabel: '纯随机', loopLabel: '列表循环' });
  assert.match(closed, /\[s 随机：纯随机\]/);
  assert.match(closed, /\[l 循环：列表循环\]/);
  assert.match(closed, /p 歌单/);
  const open = playbackPlaylistModeText({ randomLabel: '不随机', loopLabel: '顺序播放', playlistOpen: true });
  assert.match(open, /Enter 播放/);
  assert.match(open, /p\/Esc 关闭/);
  const pure = playbackPlaylistModeText({
    randomLabel: '打乱列表', loopLabel: '单曲循环', pureMode: true
  });
  assert.equal(pure, '[随机：打乱列表]  [循环：单曲循环]');
  assert.doesNotMatch(pure, /\[(?:s|l|p) /);
  assert.doesNotMatch(pure, /选择|切歌|播放/);
});

test('歌单控制指示器按完整控制项自动换行', () => {
  const rows = playbackPlaylistModeRows({
    randomLabel: '打乱列表', loopLabel: '列表循环', playlistOpen: true
  }, 34);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((row) => stringWidth(row) <= 34));
  assert.equal(rows.join('  ').includes('[Enter 播放]'), true);
  assert.equal(rows.join('  ').includes('[s 随机：打乱列表]'), true);
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

test('终端文本优先按英文词边界换行并按宽度拆分中文', () => {
  assert.deepEqual(wrapTerminalText('hello wonderful world', 12), ['hello', 'wonderful', 'world']);
  assert.deepEqual(wrapTerminalText('hello world', 11), ['hello world']);
  assert.deepEqual(wrapTerminalText('一二三四五六', 6), ['一二三', '四五六']);
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

test('歌词导入期间可独立暂停并恢复鼠标报告', () => {
  assert.equal(playbackMouseTrackingSequence(false), '\u001b[?1000l\u001b[?1006l');
  assert.equal(playbackMouseTrackingSequence(true), '\u001b[?1000h\u001b[?1006h');
});

test('普通逐行歌词插入间隔提示后仍只高亮一行', () => {
  const lines = addLyricInterludes([
    { timeMs: 10000, text: '甲' }, { timeMs: 20000, text: '乙' }, { timeMs: 30000, text: '丙' }
  ]);
  assert.deepEqual(lyricViewport(lines, 25000, 3).filter((line) => line.current).map((line) => line.text), ['乙']);
  assert.deepEqual(lyricViewport(lines, 5000, 3).filter((line) => line.current).map((line) => line.text), ['● ● ●']);
});

test('播放器支持按需显示歌词导入快捷键', () => {
  assert.doesNotMatch(playbackShortcutText(), /i 导入歌词/);
  assert.match(playbackShortcutText({ canImportLyrics: true }), /i 导入歌词/);
});

test('播放器歌词导入提示固定定位且光标紧跟提示文本', () => {
  assert.equal(
    playbackImportPromptSequence(24),
    '\x1b[24;1H\x1b[0J\x1b[?25h请输入歌词路径：'
  );
});

test('MediaPlayer 仅在 Windows helper 存在时可被选择', () => {
  assert.equal(findPlayer(['media-player'], { platform: 'linux', mediaPlayerAvailable: true }), null);
  assert.equal(findPlayer(['media-player'], { platform: 'win32', mediaPlayerAvailable: false }), null);
  assert.equal(
    findPlayer(['media-player'], { platform: 'win32', mediaPlayerAvailable: true })?.command,
    'media-player'
  );
});

test('播放器快捷键偏移只作用于当前曲目并在切歌后恢复设置值', () => {
  const offset = createTrackOffsetSession(2000);
  assert.equal(offset.adjust(50), 2050);
  assert.equal(offset.adjust(-100), 1950);
  assert.equal(offset.reset(), 2000);
  assert.equal(offset.value, 2000);
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

test('连续播放器控制只应用最后一次待处理重启', async () => {
  const values = [];
  const debounce = createLatestDebounce((value) => values.push(value), 10);
  debounce.schedule(10);
  debounce.schedule(20);
  debounce.schedule(30);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(values, [30]);
  debounce.schedule(40);
  debounce.cancel();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.deepEqual(values, [30]);
});

test('播放器收到终止信号后不会继续等待退出超时', async () => {
  class SignalExitChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    pid = 12345;
    killCalls = 0;
    kill() {
      this.killCalls += 1;
      this.signalCode = 'SIGTERM';
      this.emit('exit', null, 'SIGTERM');
      return true;
    }
  }
  const child = new SignalExitChild();
  const startedAt = performance.now();
  await terminatePlayer(child);
  assert.equal(child.killCalls, 1);
  assert.ok(performance.now() - startedAt < 250);
});

test('暂停时取消文字标记并只为时间应用黄色样式', () => {
  const yellow = (value) => `<yellow>${value}</yellow>`;
  assert.equal(
    playbackProgressText({ bar: '=>', timeText: '00:12 / 03:45', paused: true, columns: 80, colorizePaused: yellow }),
    '=> <yellow>00:12 / 03:45</yellow>'
  );
  assert.equal(
    playbackProgressText({ bar: '>', timeText: '00:12 / 03:45', paused: true, columns: 12, colorizePaused: yellow }),
    '> <yellow>00:12 / 0…</yellow>'
  );
  assert.equal(playbackProgressText({ bar: '=>', timeText: '00:12 / 03:45', columns: 80 }), '=> 00:12 / 03:45');
  assert.equal(playbackProgressText({ bar: '█', timeText: '00:12 / 03:45', columns: 1 }), '█');
});

test('进度条使用整块、八分之一细分块和背景色未播放槽', () => {
  assert.deepEqual(playbackProgressSegments(0, 4), {
    played: '', partial: '', unplayed: '    '
  });
  assert.deepEqual(playbackProgressSegments(0.30, 4), {
    played: '█', partial: '▎', unplayed: '  '
  });
  assert.deepEqual(playbackProgressSegments(1, 4), {
    played: '████', partial: '', unplayed: ''
  });
  assert.equal(stringWidth(Object.values(playbackProgressSegments(0.30, 4)).join('')), 4);
});

test('mpv 时间位置仅在明显偏离本地时钟时触发同步', () => {
  assert.equal(shouldSyncPlayerPosition(10_000, 10.4), false);
  assert.equal(shouldSyncPlayerPosition(10_000, 10.75), true);
  assert.equal(shouldSyncPlayerPosition(10_000, 42), true);
  assert.equal(shouldSyncPlayerPosition(10_000, Number.NaN), false);
});

test('切歌等待可被独立信号立即取消', async () => {
  let resolveSource;
  const source = new Promise((resolve) => { resolveSource = resolve; });
  const controller = new AbortController();
  const waiting = waitWithSignal(source, controller.signal);
  controller.abort(new DOMException('退出播放', 'AbortError'));
  await assert.rejects(waiting, { name: 'AbortError' });
  resolveSource('迟到的结果');
  await Promise.resolve();
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

test('播放器歌单覆盖动态下半屏并保持选中项在视窗原位置', () => {
  const tracks = Array.from({ length: 10 }, (_, index) => ({ name: `song-${index}` }));
  const rows = playbackPlaylistOverlayRows({
    playlist: { name: '测试歌单', tracks },
    selectedIndex: 8,
    currentIndex: 2,
    availableRows: 7,
    columns: 80
  });
  assert.equal(rows.length, 7);
  assert.equal(rows[0], '');
  assert.match(rows[1], /歌单：测试歌单/);
  assert.equal(rows.findIndex((row) => row.includes('song-8')), 5);
  assert.match(rows[5], /^› .*song-8/);
  assert.equal(rows.filter((row) => row.startsWith('› ')).length, 1);
  assert.deepEqual(
    rows.slice(2).map((row) => row.match(/song-\d+/)?.[0]),
    ['song-5', 'song-6', 'song-7', 'song-8', 'song-9']
  );
  assert.match(playbackPlaylistOverlayRows({
    playlist: { name: '测试歌单', tracks },
    selectedIndex: 8,
    currentIndex: 2,
    availableRows: 1,
    columns: 80
  })[0], /song-8/);
  const movedRows = playbackPlaylistOverlayRows({
    playlist: { name: '测试歌单', tracks },
    selectedIndex: 7,
    currentIndex: 2,
    availableRows: 7,
    columns: 80
  });
  assert.match(movedRows.find((row) => row.includes('song-7')), /^› .*song-7/);
  assert.doesNotMatch(movedRows.find((row) => row.includes('song-8')), /^›/);
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

test('歌词开头超过五秒时从歌曲开始显示间隔提示', () => {
  const firstLine = { timeMs: 10000, text: '第一行' };
  const lines = addLyricInterludes([firstLine]);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1], firstLine);
  assert.deepEqual(lines[0], {
    timeMs: 800,
    endTimeMs: 9500,
    text: '● ● ●',
    interlude: true,
    syllables: [
      { text: '● ', startTime: 800, endTime: 9500 },
      { text: '● ', startTime: 3700, endTime: 9500 },
      { text: '●', startTime: 6600, endTime: 9500 }
    ]
  });
});

test('非开头间隔提示在上一行结束 1.5 秒后开始并于下一行前 0.5 秒结束', () => {
  const lines = addLyricInterludes([
    { timeMs: 1000, endTimeMs: 3000, text: '第一行' },
    { timeMs: 13000, endTimeMs: 15000, text: '第二行' }
  ]);
  assert.equal(lines[1].text, '● ● ●');
  assert.equal(lines[1].timeMs, 4500);
  assert.equal(lines[1].endTimeMs, 12500);
});

test('间隔提示仅在实际可见时间至少七秒时生成', () => {
  assert.equal(addLyricInterludes([{ timeMs: 8299, text: '第一行' }]).length, 1);
  assert.equal(addLyricInterludes([{ timeMs: 8300, text: '第一行' }]).length, 2);
});

test('歌词开头恰好五秒时不显示间隔提示', () => {
  const firstLine = { timeMs: 5000, text: '第一行' };
  assert.deepEqual(addLyricInterludes([firstLine]), [firstLine]);
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

test('播放歌词按词换行且所有续行继承当前行高亮', () => {
  const lines = [{ timeMs: 0, text: 'hello wonderful world', translation: '' }];
  const rows = playbackLyricRows(lines, 1000, 3, false, 10);
  assert.deepEqual(rows.map((line) => line.text), ['hello', 'wonderful', 'world']);
  assert.ok(rows.every((line) => line.current));
  assert.deepEqual(rows.map((line) => line.continuation), [false, true, true]);
});

test('彩蛋歌词模式只显示当前行及其翻译', () => {
  const lines = [
    { timeMs: 1000, text: '当前行', translation: 'current line' },
    { timeMs: 2000, text: '未来行', translation: 'future line' }
  ];
  assert.deepEqual(
    playbackLyricRows(lines, 1500, 6, true, 80, true).map((line) => line.text),
    ['当前行', 'current line']
  );
  assert.deepEqual(playbackLyricRows(lines, 500, 6, true, 80, true), []);
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
