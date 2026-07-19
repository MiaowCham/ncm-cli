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
          romanized: path.relative(path.dirname(configFilePath()), dataCachePath({ type: 'song-lyrics-romanized', id: identity.id }, directory)),
          yrc: path.relative(path.dirname(configFilePath()), dataCachePath({ type: 'song-lyrics-yrc', id: identity.id }, directory))
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
      if (value.length > 0) {
        if (type === 'song-lyrics-yrc') {
          try {
            const payload = JSON.parse(value);
            if (payload?.yrc?.lyric) return payload.yrc.lyric;
          } catch { /* 原始 YRC 文本 */ }
        }
        return value;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return null;
  };
  const localFormats = await Promise.all([
    ['song-lyrics-lys', 'lys'], ['song-lyrics-qrc', 'qrc'], ['song-lyrics-yrc', 'yrc']
  ].map(async ([type, field]) => [field, await readLocal(type)]));
  const local = Object.fromEntries(localFormats);
  for (const [field, value] of Object.entries(local)) {
    void options.logger?.info(value ? 'lyrics_advanced_cache_hit' : 'lyrics_advanced_cache_miss', {
      songId: id, format: field, bytes: value ? Buffer.byteLength(value) : 0
    });
  }
  if (local.lys || local.qrc || local.yrc) {
    const original = await readLocal('song-lyrics');
    const translated = await readLocal('song-lyrics-translated');
    const romanized = await readLocal('song-lyrics-romanized');
    return { original: original || '', translated: translated || '', romanized: romanized || '', ...local };
  }
  const loadTrack = async (type, field) => {
    const local = await readLocal(type);
    if (local != null) {
      void options.logger?.info('lyrics_local_file_hit', { songId: id, type, bytes: Buffer.byteLength(local) });
      return local;
    }
    void options.logger?.info('lyrics_local_file_miss', { songId: id, type });
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

  const [original, translated, romanized, yrc] = await Promise.all([
    loadTrack('song-lyrics', 'original'),
    loadTrack('song-lyrics-translated', 'translated'),
    loadTrack('song-lyrics-romanized', 'romanized'),
    loadTrack('song-lyrics-yrc', 'yrc')
  ]);
  return { original, translated, romanized, lys: '', qrc: '', yrc };
}

export async function cacheSongMusic(id, source, options = {}) {
  if (options.maxBytes === 0) {
    void options.logger?.info('song_cache_bypassed', { songId: id, reason: 'disabled' });
    return source;
  }
  const localPath = dataCachePath({ type: 'song-music', id }, options.directory);
  void options.logger?.info('song_cache_lookup', { songId: id, path: localPath, sourcePresent: Boolean(source) });
  try {
    await access(localPath);
    void options.logger?.info('song_cache_hit', { songId: id, path: localPath });
    return localPath;
  } catch (error) {
    void options.logger?.info('song_cache_miss', { songId: id, reason: error.code || 'unavailable' });
  }
  if (!source) {
    void options.logger?.info('song_cache_bypassed', { songId: id, reason: 'no_source' });
    return null;
  }
  const parsed = new URL(source);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    void options.logger?.info('song_cache_bypassed', { songId: id, reason: 'unsupported_protocol', protocol: parsed.protocol });
    return source;
  }
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
  if (Number.isFinite(options.maxBytes) && buffer.length > options.maxBytes) {
    void options.logger?.info('song_cache_bypassed', {
      songId: id, reason: 'over_limit', bytes: buffer.length, maxBytes: options.maxBytes
    });
    return source;
  }
  void options.logger?.info('song_cache_ready', { songId: id, path: localPath, bytes: buffer.length });
  return localPath;
}
