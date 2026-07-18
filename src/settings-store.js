import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';
import { IMAGE_PROTOCOLS, PLAYER_BACKENDS, QUALITY_LEVELS } from './parsers.js';
import { normalizeApiBaseUrl } from './api.js';

export const DEFAULT_QUALITY = 'standard';
export const DEFAULT_PLAYER_BACKEND = 'auto';
export const DEFAULT_IMAGE_PROTOCOL = 'auto';
export const DEFAULT_LYRIC_OFFSET_MS = 0;
export const DEFAULT_SMTC_OFFSET_MS = 0;
export const DEFAULT_SEARCH_LIMIT = 30;
export const DEFAULT_IMAGE_CACHE_MAX_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const MIN_SEARCH_LIMIT = 1;
export const MAX_SEARCH_LIMIT = 100;
export const MIN_LYRIC_OFFSET_MS = -60000;
export const MAX_LYRIC_OFFSET_MS = 60000;

function validLyricOffset(value) {
  return Number.isInteger(value) && value >= MIN_LYRIC_OFFSET_MS && value <= MAX_LYRIC_OFFSET_MS;
}

function validSearchLimit(value) {
  return Number.isInteger(value) && value >= MIN_SEARCH_LIMIT && value <= MAX_SEARCH_LIMIT;
}

function validImageCacheMaxBytes(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_IMAGE_CACHE_MAX_BYTES;
}

export function settingsFilePath(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'settings.json');
}

export async function loadSettings(file = settingsFilePath()) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    let apiBaseUrl = null;
    try {
      apiBaseUrl = data.apiBaseUrl == null ? null : normalizeApiBaseUrl(data.apiBaseUrl);
    } catch {
      apiBaseUrl = null;
    }
    return {
      quality: QUALITY_LEVELS.includes(data.quality) ? data.quality : DEFAULT_QUALITY,
      playerBackend: PLAYER_BACKENDS.includes(data.playerBackend) ? data.playerBackend : DEFAULT_PLAYER_BACKEND,
      imageProtocol: IMAGE_PROTOCOLS.includes(data.imageProtocol) ? data.imageProtocol : DEFAULT_IMAGE_PROTOCOL,
      imageCacheMaxBytes: validImageCacheMaxBytes(data.imageCacheMaxBytes)
        ? data.imageCacheMaxBytes : DEFAULT_IMAGE_CACHE_MAX_BYTES,
      lyricOffsetMs: validLyricOffset(data.lyricOffsetMs) ? data.lyricOffsetMs : DEFAULT_LYRIC_OFFSET_MS,
      smtcOffsetMs: validLyricOffset(data.smtcOffsetMs) ? data.smtcOffsetMs : DEFAULT_SMTC_OFFSET_MS,
      searchLimit: validSearchLimit(data.searchLimit) ? data.searchLimit : DEFAULT_SEARCH_LIMIT,
      apiBaseUrl
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) {
      return {
        quality: DEFAULT_QUALITY,
        playerBackend: DEFAULT_PLAYER_BACKEND,
        imageProtocol: DEFAULT_IMAGE_PROTOCOL,
        imageCacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES,
        lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS,
        smtcOffsetMs: DEFAULT_SMTC_OFFSET_MS,
        searchLimit: DEFAULT_SEARCH_LIMIT,
        apiBaseUrl: null
      };
    }
    throw error;
  }
}

export async function saveSettings(settings, file = settingsFilePath()) {
  const current = await loadSettings(file);
  const next = { ...current, ...settings };
  if (!QUALITY_LEVELS.includes(next.quality)) throw new Error(`不支持的音质等级：${next.quality}`);
  if (!PLAYER_BACKENDS.includes(next.playerBackend)) throw new Error(`不支持的播放器后端：${next.playerBackend}`);
  if (!IMAGE_PROTOCOLS.includes(next.imageProtocol)) throw new Error(`不支持的图片协议：${next.imageProtocol}`);
  if (!validImageCacheMaxBytes(next.imageCacheMaxBytes)) {
    throw new Error(`图片缓存大小必须是 0 到 ${MAX_IMAGE_CACHE_MAX_BYTES} 之间的整数`);
  }
  if (!validLyricOffset(next.lyricOffsetMs)) {
    throw new Error(`播放时间偏移量必须是 ${MIN_LYRIC_OFFSET_MS} 到 ${MAX_LYRIC_OFFSET_MS} 之间的整数毫秒`);
  }
  if (!validLyricOffset(next.smtcOffsetMs)) {
    throw new Error(`SMTC 额外偏移量必须是 ${MIN_LYRIC_OFFSET_MS} 到 ${MAX_LYRIC_OFFSET_MS} 之间的整数毫秒`);
  }
  if (!validSearchLimit(next.searchLimit)) {
    throw new Error(`搜索返回数量必须是 ${MIN_SEARCH_LIMIT} 到 ${MAX_SEARCH_LIMIT} 之间的整数`);
  }
  if (next.apiBaseUrl != null) next.apiBaseUrl = normalizeApiBaseUrl(next.apiBaseUrl);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ ...next, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows 的 ACL 不完全映射 POSIX mode。
  }
  return file;
}
