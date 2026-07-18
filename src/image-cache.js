import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const memory = new Map();
const inflight = new Map();
let memoryBytes = 0;

function remember(key, buffer) {
  const existing = memory.get(key);
  if (existing) memoryBytes -= existing.length;
  memory.delete(key);
  memory.set(key, buffer);
  memoryBytes += buffer.length;
  while (memoryBytes > MAX_MEMORY_BYTES && memory.size > 1) {
    const oldestKey = memory.keys().next().value;
    const oldest = memory.get(oldestKey);
    memory.delete(oldestKey);
    memoryBytes -= oldest.length;
  }
}

export function imageCacheDirectory(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'image-cache');
}

function cacheKey(source) {
  const url = new URL(source);
  url.hash = '';
  return createHash('sha256').update(url.href).digest('hex');
}

function waitForConsumer(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

async function prune(directory, maxBytes, logger) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.img$/.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    try {
      const info = await stat(file);
      files.push({ file, size: info.size, mtimeMs: info.mtimeMs });
    } catch {}
  }
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (totalBytes <= maxBytes) break;
    try {
      await rm(file.file, { force: true });
      totalBytes -= file.size;
      void logger?.info('image_cache_evicted', { bytes: file.size, totalBytes });
    } catch {}
  }
}

async function fetchAndStore(source, key, { directory, maxBytes, logger, fetchImpl }) {
  const startedAt = Date.now();
  const response = await fetchImpl(source, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);
  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw new Error('响应不是图片');
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB');
  remember(key, buffer);
  if (maxBytes > 0 && buffer.length <= maxBytes) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = path.join(directory, `${key}.img`);
    const temporary = path.join(directory, `.${key}-${process.pid}-${Date.now()}.tmp`);
    try {
      await writeFile(temporary, buffer, { mode: 0o600 });
      try { await chmod(temporary, 0o600); } catch {}
      await rename(temporary, target);
      void logger?.info('image_cache_stored', {
        key: key.slice(0, 12), bytes: buffer.length, durationMs: Date.now() - startedAt
      });
      await prune(directory, maxBytes, logger);
    } finally {
      try { await rm(temporary, { force: true }); } catch {}
    }
  }
  return buffer;
}

export function peekCachedImage(source) {
  try {
    const key = cacheKey(source);
    const buffer = memory.get(key);
    if (!buffer) return null;
    memory.delete(key);
    memory.set(key, buffer);
    return buffer;
  } catch { return null; }
}

export async function loadCachedImage(source, {
  signal,
  maxBytes = 100 * 1024 * 1024,
  directory = imageCacheDirectory(),
  logger = null,
  fetchImpl = fetch
} = {}) {
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:') throw new Error('只加载 HTTPS 图片');
  const key = cacheKey(source);
  const memoryHit = memory.get(key);
  if (memoryHit) {
    memory.delete(key);
    memory.set(key, memoryHit);
    void logger?.info('image_cache_hit', { layer: 'memory', key: key.slice(0, 12), bytes: memoryHit.length });
    return waitForConsumer(Promise.resolve(memoryHit), signal);
  }
  let shared = inflight.get(key);
  if (!shared) {
    shared = (async () => {
      if (maxBytes > 0) {
        const file = path.join(directory, `${key}.img`);
        try {
          const buffer = await readFile(file);
          if (buffer.length <= MAX_IMAGE_BYTES) {
            remember(key, buffer);
            const now = new Date();
            void utimes(file, now, now).catch(() => {});
            void logger?.info('image_cache_hit', {
              layer: 'disk', key: key.slice(0, 12), bytes: buffer.length
            });
            return buffer;
          }
          await rm(file, { force: true });
        } catch (error) {
          if (error.code !== 'ENOENT') void logger?.warn('image_cache_read_failed', { key: key.slice(0, 12), error });
        }
      }
      void logger?.info('image_cache_miss', { key: key.slice(0, 12) });
      return fetchAndStore(source, key, { directory, maxBytes, logger, fetchImpl });
    })().finally(() => inflight.delete(key));
    inflight.set(key, shared);
  }
  return waitForConsumer(shared, signal);
}
