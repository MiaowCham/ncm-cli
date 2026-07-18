import { normalizeSong } from './parsers.js';
import { removeCachedData } from './data-cache.js';
import { loadCachedJson, loadCachedLyrics, readCachedJson } from './resource-cache.js';

export function normalizeApiBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('API 地址不能为空');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('API 地址格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址仅支持 http 或 https');
  if (url.username || url.password) throw new Error('API 地址不能包含用户名或密码');
  if (url.search || url.hash) throw new Error('API 地址不能包含查询参数或片段');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`;
}

function cookieFromHeaders(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return values.map((item) => item.split(';')[0]).filter(Boolean).join('; ');
}

function normalizePlaylist(raw = {}) {
  const creator = raw.creator || {};
  return {
    id: String(raw.id),
    name: raw.name || '未命名歌单',
    cover: raw.coverImgUrl || raw.picUrl || null,
    description: raw.description || '',
    creator: {
      id: creator.userId == null ? null : String(creator.userId),
      nickname: creator.nickname || '未知用户',
      avatar: creator.avatarUrl || null
    },
    trackCount: Number(raw.trackCount) || 0,
    playCount: Number(raw.playCount) || 0,
    subscribedCount: Number(raw.subscribedCount ?? raw.bookCount) || 0,
    shareCount: Number(raw.shareCount) || 0,
    commentCount: Number(raw.commentCount) || 0,
    createTime: Number(raw.createTime) || 0,
    updateTime: Number(raw.updateTime) || 0,
    specialType: Number(raw.specialType) || 0,
    subscribed: Boolean(raw.subscribed),
    tracks: Array.isArray(raw.tracks) ? raw.tracks.map(normalizeSong) : []
  };
}

function isLikedPlaylist(playlist) {
  return playlist.specialType === 5 || /喜欢的音乐\s*$/.test(playlist.name);
}

export class NcmApi {
  constructor({ baseUrl, cookie = null, logger = null, quality = 'standard', cacheMaxBytes = 0 } = {}) {
    if (!baseUrl) throw new Error('尚未配置 API 地址，请先设置兼容 api-enhanced 的服务地址');
    this.baseUrl = normalizeApiBaseUrl(baseUrl);
    this.cookie = cookie;
    this.logger = logger;
    this.quality = quality;
    this.cacheMaxBytes = cacheMaxBytes;
  }

  setCookie(cookie) {
    this.cookie = cookie;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeApiBaseUrl(baseUrl);
  }

  setQuality(quality) {
    this.quality = quality;
  }

  setCacheMaxBytes(cacheMaxBytes) {
    this.cacheMaxBytes = cacheMaxBytes;
  }

  cacheOptions(options = {}) {
    return { signal: options.signal, maxBytes: this.cacheMaxBytes, logger: this.logger };
  }

  async request(endpoint, params = {}, { timeoutMs = 20000, signal } = {}) {
    const relativeEndpoint = String(endpoint).replace(/^\/+/, '');
    const url = new URL(relativeEndpoint, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries({ ...params, timestamp: Date.now() })) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const startedAt = Date.now();
    let status = null;
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'ncm-cli-player/1.0',
          ...(this.cookie ? { cookie: this.cookie } : {})
        },
        signal: requestSignal
      });
      status = response.status;
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`API 返回了非 JSON 内容（HTTP ${response.status}）`);
      }
      if (!response.ok) {
        throw new Error(data.message || `API 请求失败（HTTP ${response.status}）`);
      }
      void this.logger?.info('api_request', { endpoint, status, durationMs: Date.now() - startedAt });
      return { data, setCookie: cookieFromHeaders(response.headers) };
    } catch (error) {
      void this.logger?.warn('api_request_failed', { endpoint, status, durationMs: Date.now() - startedAt, error });
      if (signal?.aborted) throw signal.reason || new DOMException('操作已取消', 'AbortError');
      if (controller.signal.aborted) throw new Error('API 请求超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(keywords, limit = 30, options = {}) {
    const { data } = await this.request('/cloudsearch', { keywords, limit, type: 1 }, options);
    return (data.result?.songs || []).map(normalizeSong);
  }

  async searchLyrics(keywords, limit = 30, options = {}) {
    const { data } = await this.request('/cloudsearch', { keywords, limit, type: 1006 }, options);
    return (data.result?.songs || []).map((raw) => ({
      ...normalizeSong(raw),
      lyricMatches: (raw.lyrics || [])
        .map((item) => (typeof item === 'string' ? item : item.txt || item.lyric || '').replace(/<[^>]+>/g, ''))
        .filter(Boolean)
    }));
  }

  async songDetail(id, options = {}) {
    return loadCachedJson({ type: 'song-metadata', id }, async () => {
      const { data } = await this.request('/song/detail', { ids: id }, options);
      const raw = data.songs?.[0];
      if (!raw) throw new Error(`没有找到歌曲 ID ${id}`);
      return normalizeSong(raw);
    }, this.cacheOptions(options));
  }

  async userPlaylists(uid, options = {}) {
    const {
      pageSize: requestedPageSize = 1000,
      maxPlaylists: requestedMaxPlaylists = 10000,
      ...requestOptions
    } = options;
    const pageSize = Math.max(1, Math.min(1000, Math.trunc(Number(requestedPageSize)) || 1000));
    const maxPlaylists = Math.max(1, Math.min(10000, Math.trunc(Number(requestedMaxPlaylists)) || 10000));
    return loadCachedJson({ type: 'user-playlists-metadata', id: uid }, async () => {
    const playlists = [];
    const seenIds = new Set();
    let offset = 0;

    while (offset < maxPlaylists) {
      const limit = Math.min(pageSize, maxPlaylists - offset);
      const { data } = await this.request('/user/playlist', { uid, limit, offset }, requestOptions);
      const page = Array.isArray(data.playlist) ? data.playlist : [];
      let added = 0;
      for (const raw of page) {
        const playlist = normalizePlaylist(raw);
        if (seenIds.has(playlist.id)) continue;
        seenIds.add(playlist.id);
        playlists.push(playlist);
        added += 1;
        if (playlists.length >= maxPlaylists) break;
      }
      if (!page.length || added === 0 || playlists.length >= maxPlaylists || data.more === false) break;
      if (data.more !== true && page.length < limit) break;
      offset += page.length;
    }

    return [
      ...playlists.filter(isLikedPlaylist),
      ...playlists.filter((playlist) => !isLikedPlaylist(playlist))
    ];
    }, { ...this.cacheOptions(options), ttlMs: 5 * 60 * 1000 });
  }

  async playlistDetail(id, options = {}) {
    return loadCachedJson({ type: 'playlist-metadata', id }, async () => {
      const { data } = await this.request('/playlist/detail', { id }, options);
      if (!data.playlist) throw new Error(`没有找到歌单 ID ${id}`);
      return normalizePlaylist(data.playlist);
    }, { ...this.cacheOptions(options), ttlMs: 10 * 60 * 1000 });
  }

  async playlistTracks(id, options = {}) {
    const {
      pageSize: requestedPageSize = 500,
      maxTracks: requestedMaxTracks = 10000,
      ...requestOptions
    } = options;
    const pageSize = Math.max(1, Math.min(1000, Math.trunc(Number(requestedPageSize)) || 500));
    const maxTracks = Math.max(1, Math.min(10000, Math.trunc(Number(requestedMaxTracks)) || 10000));
    return loadCachedJson({ type: 'playlist-tracks-metadata', id }, async () => {
    const tracks = [];
    const seenIds = new Set();

    for (let offset = 0; offset < maxTracks; offset += pageSize) {
      const limit = Math.min(pageSize, maxTracks - offset);
      const { data } = await this.request('/playlist/track/all', { id, limit, offset }, requestOptions);
      const page = Array.isArray(data.songs) ? data.songs : [];
      let added = 0;
      for (const raw of page) {
        const song = normalizeSong(raw);
        if (seenIds.has(song.id)) continue;
        seenIds.add(song.id);
        tracks.push(song);
        added += 1;
        if (tracks.length >= maxTracks) break;
      }
      if (page.length < limit || added === 0 || tracks.length >= maxTracks) break;
    }
    return tracks;
    }, { ...this.cacheOptions(options), ttlMs: 5 * 60 * 1000 });
  }

  async lyrics(id, options = {}) {
    return loadCachedLyrics(id, async () => {
      const { data } = await this.request('/lyric', { id }, options);
      return {
        original: data.lrc?.lyric || '', translated: data.tlyric?.lyric || '',
        romanized: data.romalrc?.lyric || ''
      };
    }, this.cacheOptions(options));
  }

  async updatePlaylistTracks(playlistId, songIds, operation = 'add', options = {}) {
    const tracks = (Array.isArray(songIds) ? songIds : [songIds]).map(String).filter(Boolean);
    if (!tracks.length) throw new Error(operation === 'del' ? '没有可删除的歌曲' : '没有可添加的歌曲');
    const { data } = await this.request('/playlist/tracks', {
      op: operation, pid: playlistId, tracks: tracks.join(',')
    }, options);
    // API Enhanced 的反向代理可能把上游响应放在 body 中，也可能直接返回上游响应。
    const payload = data?.body && typeof data.body === 'object' ? data.body : data;
    const code = Number(payload?.code);
    const message = String(payload?.message || '');
    const alreadyPresent = operation === 'add' && code === 502 && /重复|已存在/.test(message);
    if (code !== 200 && !alreadyPresent) {
      const action = operation === 'del' ? '从歌单删除歌曲' : '添加歌曲至歌单';
      throw new Error(message || `${action}失败（code=${payload?.code ?? 'unknown'}）`);
    }
    if (this.cacheMaxBytes > 0) {
      await Promise.all([
        removeCachedData({ type: 'playlist-metadata', id: playlistId }),
        removeCachedData({ type: 'playlist-tracks-metadata', id: playlistId })
      ]);
    }
    return { code, playlistId: String(playlistId), tracks, alreadyPresent };
  }

  async isSongLiked(uid, songId, options = {}) {
    const playlists = await readCachedJson({ type: 'user-playlists-metadata', id: uid });
    if (!Array.isArray(playlists)) return false;
    const liked = playlists.find(isLikedPlaylist);
    if (!liked) return false;
    const tracks = await readCachedJson({ type: 'playlist-tracks-metadata', id: liked.id });
    if (!Array.isArray(tracks)) return false;
    return tracks.some((song) => String(song.id) === String(songId));
  }

  async addPlaylistTracks(playlistId, songIds, options = {}) {
    return this.updatePlaylistTracks(playlistId, songIds, 'add', options);
  }

  async removePlaylistTracks(playlistId, songIds, options = {}) {
    return this.updatePlaylistTracks(playlistId, songIds, 'del', options);
  }

  async songUrl(id, options = {}) {
    const attempts = [];
    for (const [endpoint, params] of [
      ['/song/url/v1', { id, level: this.quality }],
      ['/song/url', { id, br: 320000 }]
    ]) {
      try {
        const { data } = await this.request(endpoint, params, options);
        const item = data.data?.[0];
        attempts.push({ endpoint, code: item?.code ?? data.code ?? null, message: item?.message || data.message || null });
        if (item?.code === 200 && item.url) {
          const result = { ...item, attempts };
          void this.logger?.info('song_url_result', { songId: id, success: true, code: item.code, level: item.level, type: item.type });
          return result;
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        attempts.push({ endpoint, code: null, message: error.message });
        if (endpoint === '/song/url') throw error;
      }
    }
    const last = attempts.at(-1) || {};
    void this.logger?.warn('song_url_result', { songId: id, success: false, code: last.code, attempts });
    return { url: null, code: last.code ?? null, message: last.message || null, attempts };
  }

  async qrKey(options = {}) {
    const { data } = await this.request('/login/qr/key', {}, options);
    const key = data.data?.unikey;
    if (!key) throw new Error('无法获取二维码登录 key');
    return key;
  }

  async qrCreate(key, options = {}) {
    const { data } = await this.request('/login/qr/create', { key, qrimg: 1 }, options);
    if (!data.data?.qrurl) throw new Error('无法生成二维码登录链接');
    return data.data;
  }

  async qrCheck(key, options = {}) {
    const result = await this.request('/login/qr/check', { key, noCookie: true }, options);
    return {
      ...result.data,
      cookie: result.data.cookie || result.setCookie || null
    };
  }

  async loginStatus(options = {}) {
    const { data } = await this.request('/login/status', {}, options);
    const account = data.data?.account || data.account || null;
    const profile = data.data?.profile || data.profile || null;
    return { loggedIn: Boolean(account && profile), account, profile, code: data.data?.code || data.code || null };
  }

  async userLevel(options = {}) {
    const { data } = await this.request('/user/level', {}, options);
    return data.data || null;
  }

  async logout(options = {}) {
    const { data } = await this.request('/logout', {}, options);
    return { code: data.code ?? null };
  }
}
