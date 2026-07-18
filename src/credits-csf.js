import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CREDITS_PLAYER_SWITCH_MS, CREDITS_PLAYER_TRANSITION_REFRESH_MS, creditsPlayerTransitionTiming } from './credits-player-transition.js';

const CREDITS_EX_ID = '405372425';
const CREDITS_DIRECT_ID = '2053695037';
const CREDITS_EASTER_EGG_IDS = new Set([CREDITS_EX_ID, CREDITS_DIRECT_ID]);
const ASSET_ROOT = fileURLToPath(new URL('../assets/credits-csf/', import.meta.url));

export const CREDITS_FONT_RECOMMENDATION = '推荐使用字体：NCM Credits VGA16（见 assets/fonts）';
export const CREDITS_LINUX_FONT_RECOMMENDATION = '请按照 sititou70/frums-credits-cli-nosound 的说明调整 Linux 控制台字体';
export const CREDITS_FONT_HINT_DURATION_MS = 10000;

function walkFiles(root, relative = '') {
  const directory = path.join(root, relative);
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const child = path.join(relative, entry.name);
      return entry.isDirectory() ? walkFiles(root, child) : [child];
    });
}

export function parseCsfMeta(source) {
  const value = (key) => String(source).match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  const bpm = Number(value('BPM'));
  const audioOffsetSec = Number(value('AudioOffsetSec'));
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(audioOffsetSec)) {
    throw new Error('Credits CSF meta.yaml 无效');
  }
  return { bpm, offsetMs: audioOffsetSec * 1000 };
}

function reverseLines(content) {
  return String(content).split('\n').map((line) => [...line].reverse().join('')).join('\n');
}

export function parseCsfPart(source, contents = new Map(), order = 0, sourcePath = '') {
  const part = { bars: [], zIndex: 0, order, sourcePath };
  const position = { x: 0, y: 0 };
  let flipHorizontal = false;

  for (const barSource of String(source).split('---')) {
    const bar = { items: [] };
    part.bars.push(bar);
    for (const rawLine of barSource.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      if (line.startsWith('/')) continue;
      if (line.startsWith('#')) {
        const [command, ...args] = line.slice(2).split(' ');
        if (command === 'MOVETO') {
          position.x = Number.parseInt(args[0], 10);
          position.y = Number.parseInt(args[1], 10);
        } else if (command === 'ZINDEX') {
          part.zIndex = Number.parseInt(args[0], 10);
        } else if (command === 'FLIP' && args[0] === 'vertical') {
          // 上游函数名为 vertical，实际行为是逐行左右镜像。
          flipHorizontal = args[1] === 'on';
        }
        continue;
      }

      let key = line.startsWith('"') ? line.slice(1, -1) : line;
      if (!contents.has(key)) contents.set(key, key);
      let content = contents.get(key);
      if (flipHorizontal) content = reverseLines(content);
      bar.items.push({ x: position.x, y: position.y, content });
    }
  }
  return part;
}

export function loadCsfScore(root = ASSET_ROOT) {
  const meta = parseCsfMeta(readFileSync(path.join(root, 'meta.yaml'), 'utf8'));
  const contents = new Map();
  for (const relative of walkFiles(path.join(root, 'data'))) {
    const content = readFileSync(path.join(root, 'data', relative), 'utf8')
      // Windows 的 Git checkout 可能把上游 LF 转成 CRLF；CSF 内容按仓库 blob 的 LF 解释。
      .replaceAll('\r\n', '\n');
    contents.set(relative.replaceAll('\\', '/'), content);
  }
  const scoreFiles = walkFiles(path.join(root, 'scores')).filter((file) => file.endsWith('.part'));
  const parts = scoreFiles.map((relative, order) => parseCsfPart(
    readFileSync(path.join(root, 'scores', relative), 'utf8'), contents, order, relative.replaceAll('\\', '/')
  ));
  parts.sort((left, right) => left.zIndex - right.zIndex || left.order - right.order);
  return Object.freeze({
    ...meta,
    parts,
    barDurationMs: 240000 / meta.bpm,
    totalBars: Math.max(0, ...parts.map((part) => part.bars.length))
  });
}

export const CREDITS_CSF_SCORE = loadCsfScore();

export const CREDITS_CSF_START_DELAY_MS = 46800;
export const CREDITS_DIRECT_FRAME_OFFSET_MS = 1400;
const CREDITS_EASTER_EGG = Object.freeze({
  mode: 'credits-csf',
  currentLyricOnly: true,
  directAnimation: false,
  usesPlaybackOffset: true
});
const CREDITS_DIRECT_EASTER_EGG = Object.freeze({
  mode: 'credits-csf',
  currentLyricOnly: true,
  directAnimation: true,
  usesPlaybackOffset: false
});

export function easterEggForSong(song) {
  const id = String(song?.id ?? '');
  if (id === CREDITS_EX_ID) return CREDITS_EASTER_EGG;
  if (id === CREDITS_DIRECT_ID) return CREDITS_DIRECT_EASTER_EGG;
  return null;
}

export function creditsFontRecommendation(song, platform = process.platform) {
  if (!CREDITS_EASTER_EGG_IDS.has(String(song?.id ?? ''))) return '';
  return platform === 'linux' ? CREDITS_LINUX_FONT_RECOMMENDATION : CREDITS_FONT_RECOMMENDATION;
}

export function creditsCsfDurationMs(score = CREDITS_CSF_SCORE) {
  return score.offsetMs + score.barDurationMs * score.totalBars;
}

export function creditsEasterEggTimeline(elapsedMs, transitionRowCount = 0) {
  const elapsed = Number(elapsedMs);
  const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
  const transitionDurationMs = creditsPlayerTransitionTiming(transitionRowCount).durationMs;
  const animationStartMs = CREDITS_CSF_START_DELAY_MS + transitionDurationMs;
  const transitionEndMs = CREDITS_PLAYER_SWITCH_MS + transitionDurationMs;

  if (safeElapsed < CREDITS_CSF_START_DELAY_MS) {
    return {
      phase: 'player-intro', frameElapsedMs: safeElapsed - CREDITS_CSF_START_DELAY_MS,
      refreshIntervalMs: Infinity, nextChangeDelayMs: CREDITS_CSF_START_DELAY_MS - safeElapsed
    };
  }
  if (safeElapsed < animationStartMs) {
    return {
      phase: 'egg-transition',
      frameElapsedMs: safeElapsed - CREDITS_CSF_START_DELAY_MS,
      transitionElapsedMs: safeElapsed - CREDITS_CSF_START_DELAY_MS,
      refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS,
      nextChangeDelayMs: animationStartMs - safeElapsed
    };
  }
  if (safeElapsed < CREDITS_PLAYER_SWITCH_MS) {
    return {
      phase: 'animation', frameElapsedMs: safeElapsed - CREDITS_CSF_START_DELAY_MS,
      refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS,
      nextChangeDelayMs: CREDITS_PLAYER_SWITCH_MS - safeElapsed
    };
  }
  if (safeElapsed < transitionEndMs) {
    return {
      phase: 'player-transition',
      frameElapsedMs: CREDITS_PLAYER_SWITCH_MS - CREDITS_CSF_START_DELAY_MS,
      transitionElapsedMs: safeElapsed - CREDITS_PLAYER_SWITCH_MS,
      refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS,
      nextChangeDelayMs: transitionEndMs - safeElapsed
    };
  }
  return {
    phase: 'player', transitionElapsedMs: transitionDurationMs,
    refreshIntervalMs: Infinity, nextChangeDelayMs: Infinity
  };
}

export function creditsEasterEggShowsFrame(timeline) {
  return timeline?.phase === 'animation';
}

export function creditsEasterEggTimelineForSong(song, rawElapsedMs, adjustedElapsedMs, transitionRowCount = 0) {
  const config = easterEggForSong(song);
  if (!config) return null;
  if (!config.directAnimation) return creditsEasterEggTimeline(adjustedElapsedMs, transitionRowCount);
  const elapsed = Number(rawElapsedMs);
  const safeElapsed = Number.isFinite(elapsed) ? elapsed : 0;
  return {
    phase: 'animation',
    frameElapsedMs: safeElapsed + CREDITS_DIRECT_FRAME_OFFSET_MS,
    refreshIntervalMs: CREDITS_PLAYER_TRANSITION_REFRESH_MS,
    nextChangeDelayMs: Infinity
  };
}


function drawContent(cells, item, width, height) {
  let x = 0;
  let y = 0;
  for (const character of [...String(item.content)]) {
    if (character === '\n') {
      x = 0;
      y += 1;
      continue;
    }
    const column = item.x + x;
    const row = item.y + y;
    // 与上游 tcell 实现一致：空格透明，不擦除较低图层。
    if (character !== ' ' && row >= 0 && row < height && column >= 0 && column < width) {
      cells[row][column] = character;
    }
    x += 1;
  }
}

/** 按上游 DrawFrame 的小节/帧算法渲染原始 CSF 数据。 */
export function creditsEasterEggFrame(elapsedMs, width, height, score = CREDITS_CSF_SCORE) {
  const safeWidth = Math.max(1, Math.floor(Number(width) || 1));
  const safeHeight = Math.max(0, Math.floor(Number(height) || 0));
  if (!safeHeight) return [];
  const cells = Array.from({ length: safeHeight }, () => Array(safeWidth).fill(' '));
  const localMs = Number(elapsedMs) - score.offsetMs;
  if (!Number.isFinite(localMs) || localMs <= 0) return cells.map(() => '');
  const playedBars = localMs / score.barDurationMs;
  const barIndex = Math.floor(playedBars);
  const barFraction = playedBars - barIndex;

  for (const part of score.parts) {
    const bar = part.bars[barIndex];
    if (!bar?.items.length) continue;
    const itemIndex = Math.min(bar.items.length - 1, Math.floor(bar.items.length * barFraction));
    drawContent(cells, bar.items[itemIndex], safeWidth, safeHeight);
  }
  return cells.map((row) => row.join('').trimEnd());
}
