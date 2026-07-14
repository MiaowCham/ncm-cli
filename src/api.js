import { normalizeSong } from './parsers.js';

export const DEFAULT_BASE_URL = 'https://ncmapi.miaowcham.com';

function cookieFromHeaders(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return values.map((item) => item.split(';')[0]).filter(Boolean).join('; ');
}

export class NcmApi {
  constructor({ baseUrl = process.env.NCM_API_BASE_URL || DEFAULT_BASE_URL, cookie = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookie = cookie;
  }

  setCookie(cookie) {
    this.cookie = cookie;
  }

  async request(endpoint, params = {}, { timeoutMs = 20000 } = {}) {
    const url = new URL(endpoint, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries({ ...params, timestamp: Date.now() })) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'ncm-cli-player/1.0',
          ...(this.cookie ? { cookie: this.cookie } : {})
        },
        signal: controller.signal
      });
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
      return { data, setCookie: cookieFromHeaders(response.headers) };
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('API 请求超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(keywords, limit = 10) {
    const { data } = await this.request('/cloudsearch', { keywords, limit, type: 1 });
    return (data.result?.songs || []).map(normalizeSong);
  }

  async searchLyrics(keywords, limit = 10) {
    const { data } = await this.request('/cloudsearch', { keywords, limit, type: 1006 });
    return (data.result?.songs || []).map((raw) => ({
      ...normalizeSong(raw),
      lyricMatches: (raw.lyrics || [])
        .map((item) => (typeof item === 'string' ? item : item.txt || item.lyric || '').replace(/<[^>]+>/g, ''))
        .filter(Boolean)
    }));
  }

  async songDetail(id) {
    const { data } = await this.request('/song/detail', { ids: id });
    const raw = data.songs?.[0];
    if (!raw) throw new Error(`没有找到歌曲 ID ${id}`);
    return normalizeSong(raw);
  }

  async lyrics(id) {
    const { data } = await this.request('/lyric', { id });
    return {
      original: data.lrc?.lyric || '',
      translated: data.tlyric?.lyric || '',
      romanized: data.romalrc?.lyric || ''
    };
  }

  async songUrl(id) {
    for (const [endpoint, params] of [
      ['/song/url/v1', { id, level: 'standard' }],
      ['/song/url', { id, br: 320000 }]
    ]) {
      try {
        const { data } = await this.request(endpoint, params);
        const item = data.data?.[0];
        if (item?.code === 200 && item.url) return item;
      } catch (error) {
        if (endpoint === '/song/url') throw error;
      }
    }
    return null;
  }

  async qrKey() {
    const { data } = await this.request('/login/qr/key');
    const key = data.data?.unikey;
    if (!key) throw new Error('无法获取二维码登录 key');
    return key;
  }

  async qrCreate(key) {
    const { data } = await this.request('/login/qr/create', { key, qrimg: 1 });
    if (!data.data?.qrurl) throw new Error('无法生成二维码登录链接');
    return data.data;
  }

  async qrCheck(key) {
    const result = await this.request('/login/qr/check', { key, noCookie: true });
    return {
      ...result.data,
      cookie: result.data.cookie || result.setCookie || null
    };
  }

  async loginStatus() {
    const { data } = await this.request('/login/status');
    return data.data?.profile || data.profile || null;
  }
}
