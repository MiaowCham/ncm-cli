import assert from 'node:assert/strict';
import { NcmApi } from '../src/api.js';
import { loadSettings } from '../src/settings-store.js';

const settings = await loadSettings();
const baseUrl = process.env.NCM_API_BASE_URL?.trim() || settings.apiBaseUrl;
if (!baseUrl) {
  throw new Error('未配置 API 地址：请设置 NCM_API_BASE_URL，或先在 ncm-cli 中使用 /api <地址>');
}
const api = new NcmApi({ baseUrl });
const songs = await api.search('海阔天空', 2);
assert.ok(songs.length > 0, '搜索应返回歌曲');
const song = await api.songDetail(songs[0].id);
assert.ok(song.name && song.id, '歌曲详情应包含名称和 ID');
const lyrics = await api.lyrics(song.id);
assert.equal(typeof lyrics.original, 'string');
console.log(`API 冒烟测试通过：${song.name} [${song.id}]`);
