import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS_CSF_START_DELAY_MS,
  CREDITS_DIRECT_FRAME_OFFSET_MS,
  creditsEasterEggFrame,
  creditsEasterEggTimeline,
  creditsEasterEggTimelineForSong,
  creditsEasterEggShowsFrame
} from '../src/credits-csf.js';
import {
  CREDITS_PLAYER_SWITCH_MS,
  composeCreditsPlayerTransitionRows,
  creditsPageRevealRows,
  playCreditsPageRevealTransition,
  playCreditsPlayerTransition,
  creditsPlayerTransitionRowState,
  creditsPlayerTransitionTiming
} from '../src/credits-player-transition.js';
import { displayPosition } from '../src/media.js';

test('开场显示普通播放器，46800ms 切入彩蛋，并在 2:10 切回', () => {
  const timing = creditsPlayerTransitionTiming(24);
  assert.deepEqual(creditsEasterEggTimeline(CREDITS_CSF_START_DELAY_MS - 1, 24), {
    phase: 'player-intro', frameElapsedMs: -1, refreshIntervalMs: Infinity, nextChangeDelayMs: 1
  });
  const entering = creditsEasterEggTimeline(CREDITS_CSF_START_DELAY_MS, 24);
  assert.equal(entering.phase, 'egg-transition');
  assert.equal(entering.transitionElapsedMs, 0);
  assert.equal(creditsEasterEggTimeline(
    CREDITS_CSF_START_DELAY_MS + timing.durationMs, 24
  ).phase, 'animation');
  assert.equal(creditsEasterEggTimeline(CREDITS_PLAYER_SWITCH_MS - 1, 24).phase, 'animation');
  const transition = creditsEasterEggTimeline(CREDITS_PLAYER_SWITCH_MS, 24);
  assert.equal(transition.phase, 'player-transition');
  assert.equal(transition.frameElapsedMs, CREDITS_PLAYER_SWITCH_MS - CREDITS_CSF_START_DELAY_MS);
  assert.equal(transition.nextChangeDelayMs, timing.durationMs);
  assert.equal(creditsEasterEggTimeline(CREDITS_PLAYER_SWITCH_MS + timing.durationMs, 24).phase, 'player');
  assert.equal(creditsEasterEggShowsFrame({ phase: 'animation' }), true);
  assert.equal(creditsEasterEggShowsFrame(entering), false);
  assert.equal(creditsEasterEggShowsFrame(transition), false);
});

test('实际 CSF 帧以校准后的 46800ms 为时间原点', () => {
  const offsetAdjusted = creditsEasterEggTimeline(displayPosition(48800, 2000));
  assert.equal(offsetAdjusted.frameElapsedMs, 0);
  assert.equal(offsetAdjusted.phase, 'egg-transition');
  const switchAdjusted = creditsEasterEggTimeline(displayPosition(132000, 2000), 24);
  assert.equal(switchAdjusted.phase, 'player-transition');
  const timeline = creditsEasterEggTimeline(CREDITS_CSF_START_DELAY_MS + 1342);
  assert.equal(timeline.frameElapsedMs, 1342);
  assert.deepEqual(
    creditsEasterEggFrame(timeline.frameElapsedMs, 40, 20),
    creditsEasterEggFrame(1342, 40, 20)
  );
});

test('2053695037 从开头直接播放彩蛋且动画不使用播放 offset', () => {
  const timeline = creditsEasterEggTimelineForSong(
    { id: 2053695037 },
    5000,
    displayPosition(5000, 2000),
    24
  );
  assert.equal(timeline.phase, 'animation');
  assert.equal(timeline.frameElapsedMs, 5000 + CREDITS_DIRECT_FRAME_OFFSET_MS);
  assert.equal(timeline.nextChangeDelayMs, Infinity);
});

test('2053695037 的播放时间轴跳过独立入场转场并保持 2 秒画面偏移', () => {
  const timing = creditsPlayerTransitionTiming(24);
  const entering = creditsEasterEggTimelineForSong({ id: 2053695037 }, 0, -2000, 24);
  assert.equal(entering.phase, 'animation');
  assert.equal(entering.frameElapsedMs, CREDITS_DIRECT_FRAME_OFFSET_MS);
  const animated = creditsEasterEggTimelineForSong(
    { id: 2053695037 }, timing.durationMs, -2000, 24
  );
  assert.equal(animated.phase, 'animation');
  assert.equal(animated.frameElapsedMs, timing.durationMs + CREDITS_DIRECT_FRAME_OFFSET_MS);
});

test('双向切换从上往下交叠刷新、放慢并快速闪烁后稳定', () => {
  const fullScreenTiming = creditsPlayerTransitionTiming(24);
  assert.ok(fullScreenTiming.durationMs >= 1400);
  assert.ok(fullScreenTiming.durationMs <= 1600);
  assert.ok(fullScreenTiming.staggerMs < fullScreenTiming.flashMs);
  const timing = creditsPlayerTransitionTiming(4);
  assert.equal(creditsPlayerTransitionRowState(0, 0, 4), 'flash-target');
  assert.equal(creditsPlayerTransitionRowState(timing.staggerMs, 0, 4), 'source');
  assert.equal(creditsPlayerTransitionRowState(timing.staggerMs, 1, 4), 'flash-target');
  assert.equal(creditsPlayerTransitionRowState(2 * timing.flashIntervalMs, 0, 4), 'target-preview');
  assert.equal(creditsPlayerTransitionRowState(timing.flashMs, 0, 4), 'target');

  const source = ['旧1', '旧2', '旧3', '旧4'];
  const target = ['封面1', '封面2', '元数据', '进度与歌词'];
  const opening = composeCreditsPlayerTransitionRows(source, target, 0, 4);
  assert.equal(opening[0].text, '封面1');
  assert.equal(opening[1].text, '旧2');
  const completed = composeCreditsPlayerTransitionRows(source, target, timing.durationMs, 4);
  assert.deepEqual(completed.map((row) => row.state), Array(4).fill('target'));
  assert.deepEqual(completed.map((row) => row.text), target);
});

test('切换驱动等待最终稳定帧写出后才完成', async () => {
  let clockMs = 0;
  const frames = [];
  const result = await playCreditsPlayerTransition(['旧1', '旧2'], ['新1', '新2'], 2, {
    now: () => clockMs,
    wait: async (delayMs) => { clockMs += delayMs; },
    writeFrame: async (entries, elapsedMs) => { frames.push({ entries, elapsedMs }); }
  });
  assert.ok(result.frameCount > 2);
  assert.equal(frames[0].elapsedMs, 0);
  assert.deepEqual(frames.at(-1).entries.map((entry) => entry.state), ['target', 'target']);
  assert.deepEqual(frames.at(-1).entries.map((entry) => entry.text), ['新1', '新2']);
  assert.equal(frames.at(-1).elapsedMs, result.durationMs);
});

test('真实页面揭示转场只覆盖已经轮到刷新的目标行', () => {
  const timing = creditsPlayerTransitionTiming(4);
  const first = creditsPageRevealRows(['彩蛋一', '彩蛋二', '彩蛋三', '彩蛋四'], 0, 4);
  assert.deepEqual(first.map(({ index, text }) => [index, text]), [[0, '彩蛋一']]);
  const later = creditsPageRevealRows(
    ['彩蛋一', '彩蛋二', '彩蛋三', '彩蛋四'], timing.staggerMs + timing.flashIntervalMs, 4
  );
  assert.deepEqual(later.map(({ index }) => index), [0, 1]);
  assert.ok(later.every(({ text }) => text.startsWith('彩蛋')));
});

test('真实页面转场使用独立时钟并等待最终目标帧', async () => {
  let clockMs = 0;
  const frames = [];
  const result = await playCreditsPageRevealTransition(['新1', '新2'], 2, {
    now: () => clockMs,
    wait: async (delayMs) => { clockMs += delayMs; },
    writeFrame: async (entries, elapsedMs) => { frames.push({ entries, elapsedMs }); }
  });
  assert.ok(result.frameCount > 2);
  assert.equal(frames[0].elapsedMs, 0);
  assert.deepEqual(frames.at(-1).entries.map(({ index, text }) => [index, text]), [
    [0, '新1'], [1, '新2']
  ]);
  assert.equal(frames.at(-1).elapsedMs, result.durationMs);
});
