import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS_CSF_START_DELAY_MS,
  creditsEasterEggFrame,
  creditsEasterEggTimeline,
  creditsEasterEggShowsFrame
} from '../src/credits-csf.js';
import {
  CREDITS_PLAYER_SWITCH_MS,
  composeCreditsPlayerTransitionRows,
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
