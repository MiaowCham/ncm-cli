export const CREDITS_PLAYER_SWITCH_MS = 130000;
export const CREDITS_PLAYER_TRANSITION_REFRESH_MS = 33;

const TARGET_SWEEP_MS = 1500;
const FLASH_MS = 420;
const FLASH_INTERVAL_MS = 45;
const MIN_ROW_STAGGER_MS = 18;
const MAX_ROW_STAGGER_MS = 60;

export function creditsPlayerTransitionTiming(rowCount) {
  const rows = Math.max(1, Math.ceil(Number(rowCount) || 1));
  const staggerMs = Math.max(
    MIN_ROW_STAGGER_MS,
    Math.min(MAX_ROW_STAGGER_MS, Math.round((TARGET_SWEEP_MS - FLASH_MS) / Math.max(1, rows - 1)))
  );
  return {
    staggerMs,
    flashMs: FLASH_MS,
    flashIntervalMs: FLASH_INTERVAL_MS,
    durationMs: (rows - 1) * staggerMs + FLASH_MS
  };
}

export function creditsPlayerTransitionRowState(elapsedMs, rowIndex, rowCount) {
  const timing = creditsPlayerTransitionTiming(rowCount);
  const ageMs = Number(elapsedMs) - Math.max(0, Number(rowIndex) || 0) * timing.staggerMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'source';
  if (ageMs >= timing.flashMs) return 'target';
  const tick = Math.floor(ageMs / timing.flashIntervalMs) % 3;
  return tick === 0 ? 'flash-target' : tick === 1 ? 'source' : 'target-preview';
}

export function composeCreditsPlayerTransitionRows(sourceRows, targetRows, elapsedMs, rowCount) {
  const rows = Math.max(1, Math.ceil(Number(rowCount) || 1));
  return Array.from({ length: rows }, (_, index) => {
    const source = sourceRows[index] ?? '';
    const target = targetRows[index] ?? '';
    const state = creditsPlayerTransitionRowState(elapsedMs, index, rows);
    return { state, text: state === 'source' ? source : target };
  });
}

export function creditsPageRevealRows(targetRows, elapsedMs, rowCount) {
  const rows = Math.max(1, Math.ceil(Number(rowCount) || 1));
  const timing = creditsPlayerTransitionTiming(rows);
  return Array.from({ length: rows }, (_, index) => {
    const ageMs = Number(elapsedMs) - index * timing.staggerMs;
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;
    const state = creditsPlayerTransitionRowState(elapsedMs, index, rows);
    return {
      index,
      state: state === 'source' ? 'target' : state,
      text: targetRows[index] ?? ''
    };
  }).filter(Boolean);
}

async function waitForTransitionDelay(wait, delayMs, signal) {
  if (!signal) return wait(delayMs);
  if (signal.aborted) throw signal.reason ?? new DOMException('转场已取消', 'AbortError');
  await new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('转场已取消', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(wait(delayMs)).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); }
    );
  });
}

export async function playCreditsPlayerTransition(
  sourceRows,
  targetRows,
  rowCount,
  {
    writeFrame,
    signal,
    now = () => performance.now(),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    refreshIntervalMs = CREDITS_PLAYER_TRANSITION_REFRESH_MS
  } = {}
) {
  if (typeof writeFrame !== 'function') throw new TypeError('writeFrame 必须是函数');
  const timing = creditsPlayerTransitionTiming(rowCount);
  const startedAt = now();
  let frameCount = 0;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('转场已取消', 'AbortError');
    const elapsedMs = Math.min(timing.durationMs, Math.max(0, now() - startedAt));
    await writeFrame(composeCreditsPlayerTransitionRows(sourceRows, targetRows, elapsedMs, rowCount), elapsedMs);
    frameCount += 1;
    if (elapsedMs >= timing.durationMs) return { frameCount, durationMs: timing.durationMs };
    await waitForTransitionDelay(
      wait, Math.min(refreshIntervalMs, timing.durationMs - elapsedMs), signal
    );
  }
}

export async function playCreditsPageRevealTransition(
  targetRows,
  rowCount,
  {
    writeFrame,
    signal,
    now = () => performance.now(),
    wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    refreshIntervalMs = CREDITS_PLAYER_TRANSITION_REFRESH_MS
  } = {}
) {
  if (typeof writeFrame !== 'function') throw new TypeError('writeFrame 必须是函数');
  const timing = creditsPlayerTransitionTiming(rowCount);
  const startedAt = now();
  let frameCount = 0;
  while (true) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('转场已取消', 'AbortError');
    const elapsedMs = Math.min(timing.durationMs, Math.max(0, now() - startedAt));
    await writeFrame(creditsPageRevealRows(targetRows, elapsedMs, rowCount), elapsedMs);
    frameCount += 1;
    if (elapsedMs >= timing.durationMs) return { frameCount, durationMs: timing.durationMs };
    await waitForTransitionDelay(
      wait, Math.min(refreshIntervalMs, timing.durationMs - elapsedMs), signal
    );
  }
}
