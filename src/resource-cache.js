import { dataCacheDirectory, dataCachePath, loadCachedData, readCachedData, removeCachedData, writeCachedData } from './data-cache.js';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';
import { loadUserLyrics, migrateLegacyImportedLyrics } from './lyric-import.js';

const userStateWrites = new Map();
const lyricsRevalidating = new Map();
const lyricsRevalidatedAt = new Map();

export async function readCachedJson(identity) {
  const buffer = await readCachedData(identity);
  if (!buffer) return null;
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    return value?.version === 1 && 'payload' in value ? value.payload : null;
  } catch { return null; }
}

export async function loadCachedJson(identity, loader, {
  signal, maxBytes, logger, directory, ttlMs = 24 * 60 * 60 * 1000, onCacheUpdated,
  forceRevalidate = false
} = {}) {
  // 元数据缓存命中后立即返回，并在后台重新校验远端内容。
  const validate = (buffer) => {
    try {
      const value = JSON.parse(buffer.toString('utf8'));
      return value?.version === 1 && Number.isFinite(value.cachedAt) && 'payload' in value;
    } catch { return false; }
  };
  const envelope = async (payload) => {
    let userState;
    if (identity.type === 'song-metadata') {
      try { userState = JSON.parse((await readCachedData(identity, { directory }))?.toString('utf8') || 'null')?.userState; } catch {}
    }
    return Buffer.from(JSON.stringify({
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
      ...(userState && typeof userState === 'object' ? { userState } : {}),
      payload
    }), 'utf8');
  };
  const buffer = await loadCachedData(identity, {
    signal, maxBytes: Infinity, logger, directory, validate, revalidate: true,
    forceRevalidate,
    revalidateIntervalMs: Math.max(30 * 1000, Math.min(ttlMs, 60 * 1000)),
    isEqual: (next, previous) => {
      try {
        return JSON.stringify(JSON.parse(next.toString('utf8')).payload)
          === JSON.stringify(JSON.parse(previous.toString('utf8')).payload);
      } catch { return false; }
    },
    onUpdated: (next, previous) => {
      try { onCacheUpdated?.(JSON.parse(next.toString('utf8')).payload, JSON.parse(previous.toString('utf8')).payload); } catch {}
    },
    loader: async () => envelope(await loader()),
    revalidateLoader: async () => envelope(await loader({ background: true }))
  });
  return JSON.parse(buffer.toString('utf8')).payload;
}

export async function readSongUserState(id, options = {}) {
  const buffer = await readCachedData({ type: 'song-metadata', id }, options);
  if (!buffer) return {};
  try {
    const state = JSON.parse(buffer.toString('utf8'))?.userState;
    return state && typeof state === 'object' ? state : {};
  } catch { return {}; }
}

export async function updateSongUserState(id, patch, options = {}) {
  const key = `${path.resolve(options.directory || '.')}:${id}`;
  const pending = (userStateWrites.get(key) || Promise.resolve()).then(async () => {
    const identity = { type: 'song-metadata', id };
    const buffer = await readCachedData(identity, options);
    let envelope = { version: 1, cachedAt: 0, payload: null };
    try {
      const parsed = JSON.parse(buffer?.toString('utf8') || 'null');
      if (parsed?.version === 1 && 'payload' in parsed) envelope = parsed;
    } catch {}
    envelope.userState = { ...(envelope.userState || {}), ...patch };
    await writeCachedData(identity, Buffer.from(JSON.stringify(envelope)), options);
    return envelope.userState;
  });
  userStateWrites.set(key, pending);
  try { return await pending; } finally {
    if (userStateWrites.get(key) === pending) userStateWrites.delete(key);
  }
}

export async function loadCachedLyrics(id, loader, options = {}) {
  const userLyrics = await loadUserLyrics(id, options) || await migrateLegacyImportedLyrics(id, options);
  const refreshKey = `${path.resolve(options.directory || dataCacheDirectory())}:${id}`;
  const scheduleRefresh = () => {
    if (lyricsRevalidating.has(refreshKey)
        || (!options.forceRevalidate
          && Date.now() - (lyricsRevalidatedAt.get(refreshKey) || 0) < 60 * 1000)) return;
    lyricsRevalidatedAt.set(refreshKey, Date.now());
    const task = Promise.resolve().then(async () => {
      const remote = await loader({ background: true });
      const tracks = [
        ['song-lyrics', 'original'],
        ['song-lyrics-translated', 'translated'],
        ['song-lyrics-romanized', 'romanized'],
        ['song-lyrics-yrc', 'yrc']
      ];
      let changed = false;
      for (const [type, field] of tracks) {
        const identity = { type, id };
        const next = Buffer.from(String(remote?.[field] || ''), 'utf8');
        const previous = await readCachedData(identity, options);
        if (previous?.equals(next) || (!previous && !next.length)) continue;
        changed = true;
        if (next.length) await writeCachedData(identity, next, options);
        else await removeCachedData(identity, options);
      }
      if (changed && !userLyrics) {
        try { options.onCacheUpdated?.(remote); } catch {}
      }
    }).catch((error) => {
      void options.logger?.warn('lyrics_cache_revalidate_failed', { songId: id, error });
    }).finally(() => lyricsRevalidating.delete(refreshKey));
    lyricsRevalidating.set(refreshKey, task);
  };
  if (userLyrics) {
    scheduleRefresh();
    void options.logger?.info('user_lyrics_hit', { songId: id, format: userLyrics.format });
    return userLyrics.lyrics;
  }
  let shared;
  const fetchLyrics = () => (shared ||= loader());
  const readLocal = async (type) => {
    try {
      const file = dataCachePath({ type, id }, options.directory);
      const value = await readFile(file, 'utf8');
      if (value.length > 0) {
        return value;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return null;
  };
  const localFormats = await Promise.all([
    ['song-lyrics-lqe', 'lqe'], ['song-lyrics-lys', 'lys'], ['song-lyrics-qrc', 'qrc'], ['song-lyrics-yrc', 'yrc']
  ].map(async ([type, field]) => [field, await readLocal(type)]));
  const local = Object.fromEntries(localFormats);
  if (Object.values(local).some(Boolean)) scheduleRefresh();
  for (const [field, value] of Object.entries(local)) {
    void options.logger?.info(value ? 'lyrics_advanced_cache_hit' : 'lyrics_advanced_cache_miss', {
      songId: id, format: field, bytes: value ? Buffer.byteLength(value) : 0
    });
  }
  if (local.lqe) {
    const parsed = (await import('./lyrics.js')).parseLqe(local.lqe);
    const original = await readLocal('song-lyrics');
    return { original: original || parsed.original, translated: parsed.translated || await readLocal('song-lyrics-translated') || '', romanized: parsed.romanized || await readLocal('song-lyrics-romanized') || '', ...local };
  }
  if (local.lys || local.qrc || local.yrc) {
    const original = await readLocal('song-lyrics');
    let translated = await readLocal('song-lyrics-translated');
    let romanized = await readLocal('song-lyrics-romanized');
    let embeddedOriginal = '';
    if (local.yrc) {
      try {
        const payload = JSON.parse(local.yrc);
        const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
        embeddedOriginal = source?.lrc?.lyric || '';
        if (!translated) translated = source?.ytlrc?.lyric || source?.tlyric?.lyric || '';
        if (!romanized) romanized = source?.yromalrc?.lyric || source?.romalrc?.lyric || '';
      } catch { /* 兼容纯文本 YRC */ }
    }
    return { original: original || embeddedOriginal, translated: translated || '', romanized: romanized || '', ...local };
  }
  const loadTrack = async (type, field) => {
    const local = await readLocal(type);
    if (local != null) {
      scheduleRefresh();
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
