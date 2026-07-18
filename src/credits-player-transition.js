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
