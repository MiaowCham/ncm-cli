import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';

export const MIN_IMAGE_RENDER_MAX_ROWS = 7;
const MAX_STORED_IMAGE_RENDER_ROWS = 512;
const PROFILE_VERSION = 1;
const SLOW_RENDER_MS = 300;
const FAST_RENDER_MS = 150;
const VALID_PROTOCOLS = new Set(['kitty', 'iterm2', 'sixel', 'symbols', 'ansi', 'ansi256']);

export function imageRenderProfilePath(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'image-render-profile.json');
}

function validLimit(value) {
  return Number.isInteger(value)
    && value >= MIN_IMAGE_RENDER_MAX_ROWS
    && value <= MAX_STORED_IMAGE_RENDER_ROWS;
}

export function normalizeImageRenderProfile(value) {
  const limits = {};
  for (const [protocol, limit] of Object.entries(value?.limits || {})) {
    if (VALID_PROTOCOLS.has(protocol) && validLimit(limit)) limits[protocol] = limit;
  }
  const resolved = {};
  for (const [preference, protocol] of Object.entries(value?.resolved || {})) {
    if (VALID_PROTOCOLS.has(protocol)) resolved[preference] = protocol;
  }
  return { version: PROFILE_VERSION, limits, resolved };
}

export async function loadImageRenderProfile(file = imageRenderProfilePath()) {
  try {
    return normalizeImageRenderProfile(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return normalizeImageRenderProfile(null);
    }
    throw error;
  }
}

export async function saveImageRenderProfile(profile, file = imageRenderProfilePath()) {
  const normalized = normalizeImageRenderProfile(profile);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ ...normalized, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600
    });
    await rename(temporary, file);
    try { await chmod(file, 0o600); } catch {}
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return file;
}

export function createImageRenderPerformance(profile, { persist, logger } = {}) {
  const current = normalizeImageRenderProfile(profile);
  const samples = new Map();
  let saveQueue = Promise.resolve();
  const queueSave = () => {
    if (typeof persist !== 'function') return;
    const snapshot = normalizeImageRenderProfile(current);
    saveQueue = saveQueue.then(() => persist(snapshot)).catch((error) => {
      void logger?.warn('image_render_profile_save_failed', { error });
    });
  };
  return {
    profile: current,
    maxRows(preference = 'auto') {
      const protocol = current.resolved[preference] || preference;
      return current.limits[protocol] || Infinity;
    },
    observe({ requestedProtocol = 'auto', selectedProtocol, renderMs, height, resultRows = height }) {
      if (!VALID_PROTOCOLS.has(selectedProtocol) || !Number.isFinite(renderMs)
          || !Number.isFinite(height) || height < 1
          || !Number.isFinite(resultRows) || resultRows < 1) return;
      current.resolved[requestedProtocol] = selectedProtocol;
      const state = samples.get(selectedProtocol) || { slow: 0, fast: 0 };
      state.slow = renderMs > SLOW_RENDER_MS ? state.slow + 1 : 0;
      state.fast = renderMs < FAST_RENDER_MS ? state.fast + 1 : 0;
      const oldLimit = current.limits[selectedProtocol] || Infinity;
      let nextLimit = oldLimit;
      if (state.slow >= 2) {
        nextLimit = Math.max(MIN_IMAGE_RENDER_MAX_ROWS, Math.floor(resultRows * 0.75));
        state.slow = 0;
        state.fast = 0;
      } else if (state.fast >= 3 && Number.isFinite(oldLimit) && height >= oldLimit - 1) {
        nextLimit = Math.max(oldLimit + 1, Math.ceil(oldLimit * 1.2));
        state.slow = 0;
        state.fast = 0;
      }
      samples.set(selectedProtocol, state);
      if (nextLimit !== oldLimit) {
        if (nextLimit > MAX_STORED_IMAGE_RENDER_ROWS) delete current.limits[selectedProtocol];
        else current.limits[selectedProtocol] = nextLimit;
        queueSave();
        void logger?.info('image_render_limit_changed', {
          selectedProtocol, oldLimit, nextLimit, renderMs, height
        });
      }
      return current.limits[selectedProtocol] || Infinity;
    },
    flush() {
      return saveQueue;
    }
  };
}
