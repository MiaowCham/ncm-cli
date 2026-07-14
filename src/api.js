import { normalizeSong } from './parsers.js';

export const DEFAULT_BASE_URL = 'https://ncmapi.miaowcham.com';

function cookieFromHeaders(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return values.map((item) => item.split(';')[0]).filter(Boolean).join('; ');
}

export class NcmApi {
  constructor({ baseUrl = process.env.NCM_API_BASE_URL || DEFAULT_BASE_URL, cookie = null, logger = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookie = cookie;
    this.logger = logger;
  }

  setCookie(cookie) {
    this.cookie = cookie;
  }

  async request(endpoint, params = {}, { timeoutMs = 20000, signal } = {}) {
    const url = new URL(endpoint, `${this.baseUrl}/`);
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

  async search(keywords, limit = 10, options = {}) {
    const { data } = await this.request('/cloudsearch', { keywords, limit, type: 1 }, options);
    return (data.result?.songs || []).map(normalizeSong);
  }

  async searchLyrics(keywords, limit = 10, options = {}) {
    const { data } = await this.request('/cloudsearch', { keywords, limit, type: 1006 }, options);
    return (data.result?.songs || []).map((raw) => ({
      ...normalizeSong(raw),
      lyricMatches: (raw.lyrics || [])
        .map((item) => (typeof item === 'string' ? item : item.txt || item.lyric || '').replace(/<[^>]+>/g, ''))
        .filter(Boolean)
    }));
  }

  async songDetail(id, options = {}) {
    const { data } = await this.request('/song/detail', { ids: id }, options);
    const raw = data.songs?.[0];
    if (!raw) throw new Error(`没有找到歌曲 ID ${id}`);
    return normalizeSong(raw);
  }

  async lyrics(id, options = {}) {
    const { data } = await this.request('/lyric', { id }, options);
    return {
      original: data.lrc?.lyric || '',
      translated: data.tlyric?.lyric || '',
      romanized: data.romalrc?.lyric || ''
    };
  }

  async songUrl(id, options = {}) {
    const attempts = [];
    for (const [endpoint, params] of [
      ['/song/url/v1', { id, level: 'standard' }],
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
}
