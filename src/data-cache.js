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

const NAMESPACE_TYPES = Object.freeze({
  'track-cover': ['Covers', 'song', 'png'],
  'playlist-cover': ['Covers', 'playlist', 'png'],
  'song-music': ['Musics', 'song', 'cache'],
  'song-lyrics': ['Lyrics', 'song', 'lyric.lrc'],
  'song-lyrics-qrc': ['Lyrics', 'song', 'lyric.qrc'],
  'song-lyrics-lys': ['Lyrics', 'song', 'lyric.lys'],
  'song-lyrics-yrc': ['Lyrics', 'song', 'lyric.yrc'],
  'song-lyrics-translated': ['Lyrics', 'song', 'trans.lrc'],
  'song-lyrics-romanized': ['Lyrics', 'song', 'roman.lrc'],
  'song-metadata': ['Metadata', 'song', 'metadata'],
  'playlist-metadata': ['Metadata', 'playlist', 'metadata'],
  'playlist-tracks-metadata': ['Metadata', 'playlist-tracks', 'metadata'],
  'user-playlists-metadata': ['Metadata', 'user-playlists', 'metadata'],
  'liked-music-metadata': ['Metadata', 'liked-music', 'metadata']
});

function safePathPart(value, label) {
  const part = String(value ?? '').trim();
  if (!part || part === '.' || part === '..' || /[\\/\0]/.test(part)) {
    throw new TypeError(`缓存 ${label} 无效`);
  }
  return part;
}

export function dataCachePath(identity, directory = dataCacheDirectory()) {
  const mapped = NAMESPACE_TYPES[identity.type];
  const [namespace, kind, extension] = mapped || [
    safePathPart(identity.namespace || identity.type, 'namespace'),
    safePathPart(identity.kind || 'item', 'kind'),
    safePathPart(identity.extension || 'cache', 'extension')
  ];
  let id;
  try {
    id = safePathPart(identity.id, 'id');
  } catch {
    // URL-based temporary identities cannot be used as path components.
    id = createHash('sha256').update(String(identity.id ?? '')).digest('hex');
  }
  if (namespace === 'Lyrics') return path.join(directory, namespace, kind, id, extension);
  return path.join(directory, namespace, kind, `${id}.${extension}`);
}

function scopedKey(directory, key) {
  return `${path.resolve(directory)}\0${key}`;
}

function remember(key, buffer) {
  if (buffer.length > MAX_MEMORY_BYTES) return;
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
  const files = [];
  async function collect(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile() && !entry.name.startsWith('.')
          && /\.(?:png|cache)$/.test(entry.name)
          && ['Covers', 'Musics'].includes(path.relative(directory, file).split(path.sep)[0])) {
        try {
          const info = await stat(file);
          files.push({ file, size: info.size, mtimeMs: info.mtimeMs });
        } catch {}
      }
    }
  }
  await collect(directory);
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

async function store(target, buffer, maxBytes, logger, directory) {
  if (maxBytes <= 0 || buffer.length > maxBytes) return;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}-${process.pid}-${Date.now()}.tmp`);
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

function touch(file) {
  const now = new Date();
  void utimes(file, now, now).catch(() => {});
}

export function peekCachedData(identity, { directory = dataCacheDirectory() } = {}) {
  try {
    const key = scopedKey(directory, dataCacheKey(identity));
    const buffer = memory.get(key);
    if (!buffer) return null;
    memory.delete(key);
    memory.set(key, buffer);
    touch(dataCachePath(identity, directory));
    return buffer;
  } catch { return null; }
}

export async function readCachedData(identity, { directory = dataCacheDirectory() } = {}) {
  const memoryHit = peekCachedData(identity, { directory });
  if (memoryHit) return memoryHit;
  try {
    const buffer = await readFile(dataCachePath(identity, directory));
    remember(scopedKey(directory, dataCacheKey(identity)), buffer);
    return buffer;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
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
  maxBytes = maxBytes == null ? Infinity : maxBytes;
  const key = dataCacheKey(identity);
  const memoryId = scopedKey(directory, key);
  const memoryHit = memory.get(memoryId);
  if (memoryHit) {
    memory.delete(memoryId);
    memory.set(memoryId, memoryHit);
    if (maxBytes > 0) touch(dataCachePath(identity, directory));
    void logger?.info('data_cache_hit', {
      layer: 'memory', type: identity.type, key: key.slice(0, 12),
      variant: identity.variant ?? 'default', bytes: memoryHit.length, path: dataCachePath(identity, directory)
    });
    return waitForConsumer(Promise.resolve(memoryHit), signal);
  }
  let shared = inflight.get(memoryId);
  if (!shared) {
    shared = (async () => {
      if (maxBytes > 0) {
        const primary = dataCachePath(identity, directory);
        for (const candidate of [primary, ...legacyFiles]) {
          try {
            const buffer = await readValid(candidate, validate);
            remember(memoryId, buffer);
            const legacy = candidate !== primary;
            void logger?.info('data_cache_hit', {
              layer: legacy ? 'legacy-disk' : 'disk', type: identity.type,
              key: key.slice(0, 12), variant: identity.variant ?? 'default', bytes: buffer.length,
              path: candidate
            });
            if (legacy) await store(primary, buffer, maxBytes, logger, directory);
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
        type: identity.type, key: key.slice(0, 12), variant: identity.variant ?? 'default',
        path: dataCachePath(identity, directory), maxBytes
      });
      const buffer = Buffer.from(await loader());
      if (!validate(buffer)) throw Object.assign(new Error('加载的缓存内容无效'), { code: 'INVALID_CACHE' });
      remember(memoryId, buffer);
      await store(dataCachePath(identity, directory), buffer, maxBytes, logger, directory);
      return buffer;
    })().finally(() => inflight.delete(memoryId));
    inflight.set(memoryId, shared);
  }
  return waitForConsumer(shared, signal);
}

export async function removeCachedData(identity, { directory = dataCacheDirectory() } = {}) {
  const key = dataCacheKey(identity);
  const memoryId = scopedKey(directory, key);
  const existing = memory.get(memoryId);
  if (existing) {
    memory.delete(memoryId);
    memoryBytes -= existing.length;
  }
  await rm(dataCachePath(identity, directory), { force: true });
}

async function collectCacheFiles(directory) {
  const files = [];
  async function collect(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await collect(target);
      else if (entry.isFile() && !entry.name.startsWith('.')) {
        try { files.push({ file: target, size: (await stat(target)).size }); } catch {}
      }
    }
  }
  await collect(directory);
  return files;
}

export async function inspectDataCache(directory = dataCacheDirectory()) {
  const files = await collectCacheFiles(directory);
  const groups = { covers: 0, musics: 0, other: 0 };
  for (const entry of files) {
    const namespace = path.relative(directory, entry.file).split(path.sep)[0].toLowerCase();
    const group = namespace === 'covers' ? 'covers' : namespace === 'musics' ? 'musics' : 'other';
    groups[group] += entry.size;
  }
  return { ...groups, total: groups.covers + groups.musics + groups.other, files: files.length };
}

export async function clearDataCache(group, directory = dataCacheDirectory()) {
  if (!['covers', 'musics', 'other'].includes(group)) {
    throw new Error('缓存分类必须是 covers、musics 或 other');
  }
  if (group !== 'other') {
    const name = group === 'covers' ? 'Covers' : 'Musics';
    await rm(path.join(directory, name), { recursive: true, force: true });
  } else {
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || ['covers', 'musics'].includes(entry.name.toLowerCase())) continue;
      await rm(path.join(directory, entry.name), { recursive: true, force: true });
    }
    // 日志与数据缓存同属本地运行产物，归入 other 一并清理。
    await rm(path.join(path.dirname(configFilePath()), 'logs'), { recursive: true, force: true });
  }
  for (const [key, buffer] of memory) {
    if (!key.startsWith(`${path.resolve(directory)}\0`)) continue;
    memory.delete(key);
    memoryBytes -= buffer.length;
  }
}
