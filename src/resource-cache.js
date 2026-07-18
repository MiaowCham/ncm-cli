import { dataCachePath, loadCachedData, readCachedData } from './data-cache.js';

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
  if (!(maxBytes > 0)) return loader();
  const validate = (buffer) => {
    try {
      const value = JSON.parse(buffer.toString('utf8'));
      return value?.version === 1 && Number.isFinite(value.cachedAt)
        && Date.now() - value.cachedAt <= ttlMs && 'payload' in value;
    } catch { return false; }
  };
  const buffer = await loadCachedData(identity, {
    signal, maxBytes, logger, directory, validate,
    loader: async () => Buffer.from(JSON.stringify({
      version: 1, cachedAt: Date.now(), payload: await loader()
    }), 'utf8')
  });
  return JSON.parse(buffer.toString('utf8')).payload;
}

export async function loadCachedLyrics(id, loader, options = {}) {
  if (!(options.maxBytes > 0)) return loader();
  let shared;
  const fetchLyrics = () => (shared ||= loader());
  const loadTrack = async (type, field) => (await loadCachedData({ type, id }, {
    ...options,
    validate: () => true,
    loader: async () => Buffer.from((await fetchLyrics())[field] || '', 'utf8')
  })).toString('utf8');
  const [original, translated, romanized] = await Promise.all([
    loadTrack('song-lyrics', 'original'),
    loadTrack('song-lyrics-translated', 'translated'),
    loadTrack('song-lyrics-romanized', 'romanized')
  ]);
  return { original, translated, romanized };
}

export async function cacheSongMusic(id, source, options = {}) {
  if (!(options.maxBytes > 0)) return source;
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:') return source;
  const buffer = await loadCachedData({ type: 'song-music', id }, {
    ...options,
    validate: (buffer) => buffer.length > 0,
    loader: async () => {
      const timeout = AbortSignal.timeout(120000);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await (options.fetchImpl || fetch)(source, { signal });
      if (!response.ok) throw new Error(`歌曲下载失败：HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (/json|html|text/i.test(type)) throw new Error('歌曲下载响应不是音频');
      return Buffer.from(await response.arrayBuffer());
    }
  });
  if (buffer.length > options.maxBytes) return source;
  return dataCachePath({ type: 'song-music', id });
}
