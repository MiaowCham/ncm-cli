import { dataCachePath, loadCachedData, readCachedData } from './data-cache.js';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';

export async function readCachedJson(identity) {
  const buffer = await readCachedData(identity);
  if (!buffer) return null;
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    return value?.version === 1 && 'payload' in value ? value.payload : null;
  } catch { return null; }
}

export async function loadCachedJson(identity, loader, {
  signal, maxBytes, logger, directory, ttlMs = 24 * 60 * 60 * 1000
} = {}) {
  // 元数据始终缓存，不受封面/音频容量设置影响。
  const validate = (buffer) => {
    try {
      const value = JSON.parse(buffer.toString('utf8'));
      return value?.version === 1 && Number.isFinite(value.cachedAt)
        && Date.now() - value.cachedAt <= ttlMs && 'payload' in value;
    } catch { return false; }
  };
  const buffer = await loadCachedData(identity, {
    signal, maxBytes: Infinity, logger, directory, validate,
    loader: async () => Buffer.from(JSON.stringify({
      version: 1, cachedAt: Date.now(),
      cachePath: path.relative(path.dirname(configFilePath()), dataCachePath(identity, directory)),
      cachePaths: identity.type === 'song-metadata' ? {
        lyrics: {
          original: path.relative(path.dirname(configFilePath()), dataCachePath({ type: 'song-lyrics', id: identity.id }, directory)),
          translated: path.relative(path.dirname(configFilePath()), dataCachePath({ type: 'song-lyrics-translated', id: identity.id }, directory)),
          romanized: path.relative(path.dirname(configFilePath()), dataCachePath({ type: 'song-lyrics-romanized', id: identity.id }, directory))
        }
      } : undefined,
      payload: await loader()
    }), 'utf8')
  });
  return JSON.parse(buffer.toString('utf8')).payload;
}

export async function loadCachedLyrics(id, loader, options = {}) {
  let shared;
  const fetchLyrics = () => (shared ||= loader());
  const readLocal = async (type) => {
    try {
      const file = dataCachePath({ type, id }, options.directory);
      const value = await readFile(file, 'utf8');
      if (value.length > 0) return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return null;
  };
  const loadTrack = async (type, field) => {
    const local = await readLocal(type);
    if (local != null) {
      void options.logger?.info('lyrics_local_file_hit', { songId: id, type, bytes: Buffer.byteLength(local) });
      return local;
    }
    try {
      return (await loadCachedData({ type, id }, {
        ...options, maxBytes: Infinity,
        validate: (buffer) => buffer.length > 0,
        loader: async () => Buffer.from((await fetchLyrics())[field] || '', 'utf8')
      })).toString('utf8');
    } catch (error) {
      if (error.code === 'INVALID_CACHE') return '';
      throw error;
    }
  };

  const [original, translated, romanized] = await Promise.all([
    loadTrack('song-lyrics', 'original'),
    loadTrack('song-lyrics-translated', 'translated'),
    loadTrack('song-lyrics-romanized', 'romanized')
  ]);
  return { original, translated, romanized };
}

export async function cacheSongMusic(id, source, options = {}) {
  if (options.maxBytes === 0) return source;
  const localPath = dataCachePath({ type: 'song-music', id }, options.directory);
  void options.logger?.info('song_cache_lookup', { songId: id, path: localPath, sourcePresent: Boolean(source) });
  try {
    await access(localPath);
    void options.logger?.info('song_cache_hit', { songId: id, path: localPath });
    return localPath;
  } catch (error) {
    void options.logger?.info('song_cache_miss', { songId: id, reason: error.code || 'unavailable' });
  }
  if (!source) return null;
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:') return source;
  const buffer = await loadCachedData({ type: 'song-music', id }, {
    ...options,
    validate: (buffer) => buffer.length > 0,
    loader: async () => {
      void options.logger?.info('song_cache_download_start', { songId: id, source });
      const timeout = AbortSignal.timeout(120000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await (options.fetchImpl || fetch)(source, { signal });
      if (!response.ok) throw new Error(`歌曲下载失败：HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (/json|html|text/i.test(type)) throw new Error('歌曲下载响应不是音频');
      const data = Buffer.from(await response.arrayBuffer());
      void options.logger?.info('song_cache_download_complete', { songId: id, bytes: data.length });
      return data;
    }
  });
  if (Number.isFinite(options.maxBytes) && buffer.length > options.maxBytes) return source;
  void options.logger?.info('song_cache_ready', { songId: id, path: localPath, bytes: buffer.length });
  return localPath;
}
