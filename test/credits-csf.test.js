import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDITS_CSF_SCORE,
  CREDITS_FONT_HINT_DURATION_MS,
  creditsEasterEggFrame,
  creditsFontRecommendation,
  easterEggForSong,
  parseCsfMeta,
  parseCsfPart
} from '../src/credits-csf.js';

test('Credits EX 的数字或字符串 ID 都会启用原始 CSF 彩蛋', () => {
  assert.equal(easterEggForSong({ id: 405372425 })?.mode, 'credits-csf');
  assert.equal(easterEggForSong({ id: '405372425' })?.currentLyricOnly, true);
  assert.equal(easterEggForSong({ id: 1 }), null);
});

test('Credits EX 提供持续十秒的推荐字体提示', () => {
  assert.match(creditsFontRecommendation({ id: 405372425 }), /NCM Credits VGA16/);
  assert.equal(creditsFontRecommendation({ id: '405372425' }).includes('assets/fonts'), true);
  assert.equal(creditsFontRecommendation({ id: 1 }), '');
  assert.equal(CREDITS_FONT_HINT_DURATION_MS, 10000);
});

test('加载上游完整 CSF 元数据和 14 个 part', () => {
  assert.deepEqual(parseCsfMeta('BPM: 179\nAudioOffsetSec: 1.341\n'), { bpm: 179, offsetMs: 1341 });
  assert.equal(CREDITS_CSF_SCORE.bpm, 179);
  assert.equal(CREDITS_CSF_SCORE.offsetMs, 1341);
  assert.equal(CREDITS_CSF_SCORE.parts.length, 14);
  assert.equal(CREDITS_CSF_SCORE.totalBars, 72);
  assert.deepEqual(
    CREDITS_CSF_SCORE.parts.map((part) => part.zIndex),
    [...CREDITS_CSF_SCORE.parts.map((part) => part.zIndex)].sort((left, right) => left - right)
  );
});

test('part 解析保持坐标、层级、data 引用和上游左右镜像行为', () => {
  const contents = new Map([['shape', 'AB C\n D ']]);
  const part = parseCsfPart([
    '# ZINDEX 3',
    '# MOVETO 2 4',
    'shape',
    '---',
    '# FLIP vertical on',
    'shape'
  ].join('\n'), contents);
  assert.equal(part.zIndex, 3);
  assert.deepEqual(part.bars[0].items[0], { x: 2, y: 4, content: 'AB C\n D ' });
  assert.deepEqual(part.bars[1].items[0], { x: 2, y: 4, content: 'C BA\n D ' });
});

test('帧选择按一小节等分，空格透明且高 z-index 覆盖低层', () => {
  const score = {
    offsetMs: 100,
    barDurationMs: 1000,
    parts: [
      { zIndex: 0, bars: [{ items: [{ x: 0, y: 0, content: 'ABC' }, { x: 0, y: 0, content: 'DEF' }] }] },
      { zIndex: 1, bars: [{ items: [{ x: 0, y: 0, content: ' X ' }] }] }
    ]
  };
  assert.deepEqual(creditsEasterEggFrame(100, 4, 1, score), ['']);
  assert.deepEqual(creditsEasterEggFrame(101, 4, 1, score), ['AXC']);
  assert.deepEqual(creditsEasterEggFrame(600, 4, 1, score), ['DXF']);
  assert.deepEqual(creditsEasterEggFrame(1100, 4, 1, score), ['']);
});

test('原始时间轴不循环，并在窄终端安全裁剪', () => {
  const opening = creditsEasterEggFrame(1342, 40, 20).join('\n');
  assert.match(opening, /THE BMS OF FIGHTERS ULTIMATE/);
  const narrow = creditsEasterEggFrame(1342, 12, 5);
  assert.equal(narrow.length, 5);
  assert.ok(narrow.every((line) => line.length <= 12));
  const afterScore = 1341 + CREDITS_CSF_SCORE.barDurationMs * CREDITS_CSF_SCORE.totalBars + 1;
  assert.ok(creditsEasterEggFrame(afterScore, 40, 20).every((line) => line === ''));
});
