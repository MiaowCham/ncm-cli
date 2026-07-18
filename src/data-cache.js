import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';

const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const memory = new Map();
const inflight = new Map();
let memoryBytes = 0;

export function dataCacheDirectory(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'data-cache');
}

export function dataCacheKey({ type, id, variant = 'default' }) {
  const values = [type, id, variant].map((value) => String(value ?? '').trim());
  if (values.some((value) => !value)) throw new TypeError('缓存 type、id 和 variant 不能为空');
  return createHash('sha256').update(`v1\0${values.join('\0')}`).digest('hex');
}

function scopedKey(directory, key) {
  return `${path.resolve(directory)}\0${key}`;
}

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

function waitForConsumer(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('操作已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); }
    );
  });
}

async function prune(directory, maxBytes, logger) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.cache$/.test(entry.name)) continue;
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
      void logger?.info('data_cache_evicted', { bytes: file.size, totalBytes });
    } catch {}
  }
}

async function store(directory, key, buffer, maxBytes, logger) {
  if (maxBytes <= 0 || buffer.length > maxBytes) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${key}.cache`);
  const temporary = path.join(directory, `.${key}-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, buffer, { mode: 0o600 });
    try { await chmod(temporary, 0o600); } catch {}
    await rename(temporary, target);
    await prune(directory, maxBytes, logger);
  } finally {
    try { await rm(temporary, { force: true }); } catch {}
  }
}

async function readValid(file, validate) {
  const buffer = await readFile(file);
  if (!validate(buffer)) throw Object.assign(new Error('缓存内容无效'), { code: 'INVALID_CACHE' });
  const now = new Date();
  void utimes(file, now, now).catch(() => {});
  return buffer;
}

function touch(directory, key) {
  const now = new Date();
  void utimes(path.join(directory, `${key}.cache`), now, now).catch(() => {});
}

export function peekCachedData(identity, { directory = dataCacheDirectory() } = {}) {
  try {
    const key = scopedKey(directory, dataCacheKey(identity));
    const buffer = memory.get(key);
    if (!buffer) return null;
    memory.delete(key);
    memory.set(key, buffer);
    touch(directory, dataCacheKey(identity));
    return buffer;
  } catch { return null; }
}

export async function loadCachedData(identity, {
  signal,
  maxBytes = 100 * 1024 * 1024,
  directory = dataCacheDirectory(),
  logger = null,
  loader,
  validate = () => true,
  legacyFiles = []
} = {}) {
  if (typeof loader !== 'function') throw new TypeError('缓存 loader 必须是函数');
  const key = dataCacheKey(identity);
  const memoryId = scopedKey(directory, key);
  const memoryHit = memory.get(memoryId);
  if (memoryHit) {
    memory.delete(memoryId);
    memory.set(memoryId, memoryHit);
    if (maxBytes > 0) touch(directory, key);
    void logger?.info('data_cache_hit', {
      layer: 'memory', type: identity.type, key: key.slice(0, 12),
      variant: identity.variant ?? 'default', bytes: memoryHit.length
    });
    return waitForConsumer(Promise.resolve(memoryHit), signal);
  }
  let shared = inflight.get(memoryId);
  if (!shared) {
    shared = (async () => {
      if (maxBytes > 0) {
        const primary = path.join(directory, `${key}.cache`);
        for (const candidate of [primary, ...legacyFiles]) {
          try {
            const buffer = await readValid(candidate, validate);
            remember(memoryId, buffer);
            const legacy = candidate !== primary;
            void logger?.info('data_cache_hit', {
              layer: legacy ? 'legacy-disk' : 'disk', type: identity.type,
              key: key.slice(0, 12), variant: identity.variant ?? 'default', bytes: buffer.length
            });
            if (legacy) await store(directory, key, buffer, maxBytes, logger);
            return buffer;
          } catch (error) {
            if (!['ENOENT', 'INVALID_CACHE'].includes(error.code)) {
              void logger?.warn('data_cache_read_failed', {
                type: identity.type, key: key.slice(0, 12), error
              });
            }
            if (error.code === 'INVALID_CACHE') try { await rm(candidate, { force: true }); } catch {}
          }
        }
      }
      void logger?.info('data_cache_miss', {
        type: identity.type, key: key.slice(0, 12), variant: identity.variant ?? 'default'
      });
      const buffer = Buffer.from(await loader());
      if (!validate(buffer)) throw new Error('加载的缓存内容无效');
      remember(memoryId, buffer);
      await store(directory, key, buffer, maxBytes, logger);
      return buffer;
    })().finally(() => inflight.delete(memoryId));
    inflight.set(memoryId, shared);
  }
  return waitForConsumer(shared, signal);
}
