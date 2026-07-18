import { createHash } from 'node:crypto';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';
import { dataCacheDirectory, loadCachedData, peekCachedData } from './data-cache.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageCacheDirectory(env = process.env, platform = process.platform) {
  return dataCacheDirectory(env, platform);
}

function legacyImageCacheDirectory(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'image-cache');
}

function legacyCacheKey(source) {
  const url = new URL(source);
  url.hash = '';
  return createHash('sha256').update(url.href).digest('hex');
}

function imageIdentity(source, identity) {
  if (identity) return identity;
  const url = new URL(source);
  url.hash = '';
  return { type: 'image-url', id: url.href };
}

export function peekCachedImage(source, { identity, directory = imageCacheDirectory() } = {}) {
  try { return peekCachedData(imageIdentity(source, identity), { directory }); } catch { return null; }
}

export async function loadCachedImage(source, {
  signal,
  maxBytes = 100 * 1024 * 1024,
  directory = imageCacheDirectory(),
  logger = null,
  fetchImpl = fetch,
  identity = null,
  legacyDirectory = legacyImageCacheDirectory()
} = {}) {
  const parsed = new URL(source);
  if (parsed.protocol !== 'https:') throw new Error('只加载 HTTPS 图片');
  const cacheIdentity = imageIdentity(source, identity);
  return loadCachedData(cacheIdentity, {
    signal,
    maxBytes,
    directory,
    logger,
    legacyFiles: [path.join(legacyDirectory, `${legacyCacheKey(source)}.img`)],
    validate: (buffer) => buffer.length <= MAX_IMAGE_BYTES,
    loader: async () => {
      const startedAt = Date.now();
      const response = await fetchImpl(source, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);
      const type = response.headers.get('content-type') || '';
      if (!type.startsWith('image/')) throw new Error('响应不是图片');
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('图片超过 5 MiB');
      void logger?.info('image_cache_downloaded', {
        type: cacheIdentity.type,
        bytes: buffer.length, durationMs: Date.now() - startedAt
      });
      return buffer;
    }
  });
}
