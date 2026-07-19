import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCookie, saveCookie } from '../src/cookie-store.js';
import {
  loadSettings, saveSettings, settingsFilePath, DEFAULT_LYRIC_OFFSET_MS, DEFAULT_SMTC_OFFSET_MS,
  DEFAULT_IMAGE_CACHE_MAX_BYTES, DEFAULT_IMAGE_PROTOCOL, DEFAULT_PLAYER_BACKEND, DEFAULT_SEARCH_LIMIT,
  DEFAULT_TRANSLATION_MODE
} from '../src/settings-store.js';

test('音质设置使用独立文件并可持久化', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-settings-'));
  const file = settingsFilePath({ NCM_CLI_CONFIG_DIR: directory });
  const cookieFile = path.join(directory, 'cookie.json');
  try {
    await saveCookie('MUSIC_U=secret', cookieFile);
    await saveSettings({
      quality: 'lossless', playerBackend: 'vlc', imageProtocol: 'sixel', cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES,
      lyricOffsetMs: 1500, smtcOffsetMs: 250, searchLimit: 40, translationMode: 'romanized',
      apiBaseUrl: 'https://api.example.com/v1/'
    }, file);
    assert.deepEqual(await loadSettings(file), {
      quality: 'lossless', playerBackend: 'vlc', imageProtocol: 'sixel',
      cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES, lyricOffsetMs: 1500, smtcOffsetMs: 250, searchLimit: 40,
      translationMode: 'romanized',
      apiBaseUrl: 'https://api.example.com/v1'
    });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).quality, 'lossless');
    assert.equal(await loadCookie(cookieFile), 'MUSIC_U=secret');
    assert.notEqual(file, cookieFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺失或非法设置回退默认值，保存时拒绝非法值', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    assert.deepEqual(await loadSettings(file), {
      quality: 'standard', playerBackend: DEFAULT_PLAYER_BACKEND, imageProtocol: DEFAULT_IMAGE_PROTOCOL,
      cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES, lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS,
      smtcOffsetMs: DEFAULT_SMTC_OFFSET_MS, searchLimit: DEFAULT_SEARCH_LIMIT,
      translationMode: DEFAULT_TRANSLATION_MODE, apiBaseUrl: null
    });
    await writeFile(file, '{"quality":"unsupported"}');
    assert.deepEqual(await loadSettings(file), {
      quality: 'standard', playerBackend: DEFAULT_PLAYER_BACKEND, imageProtocol: DEFAULT_IMAGE_PROTOCOL,
      cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES, lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS,
      smtcOffsetMs: DEFAULT_SMTC_OFFSET_MS, searchLimit: DEFAULT_SEARCH_LIMIT,
      translationMode: DEFAULT_TRANSLATION_MODE, apiBaseUrl: null
    });
    await writeFile(file, '{"quality":"standard","searchLimit":0}');
    assert.equal((await loadSettings(file)).searchLimit, DEFAULT_SEARCH_LIMIT);
    await assert.rejects(saveSettings({ quality: 'unsupported' }, file), /不支持的音质等级/);
    await assert.rejects(saveSettings({ playerBackend: 'unsupported' }, file), /不支持的播放器后端/);
    await assert.rejects(saveSettings({ imageProtocol: 'unsupported' }, file), /不支持的图片协议/);
    await assert.rejects(saveSettings({ cacheMaxBytes: -1 }, file), /整体缓存大小/);
    await assert.rejects(saveSettings({ lyricOffsetMs: 60001 }, file), /播放时间偏移量/);
    await assert.rejects(saveSettings({ smtcOffsetMs: -60001 }, file), /SMTC 额外偏移量/);
    await assert.rejects(saveSettings({ searchLimit: 0 }, file), /搜索返回数量/);
    await assert.rejects(saveSettings({ searchLimit: 1.5 }, file), /搜索返回数量/);
    await assert.rejects(saveSettings({ searchLimit: 101 }, file), /搜索返回数量/);
    await assert.rejects(saveSettings({ translationMode: 'unsupported' }, file), /歌词翻译模式/);
    await assert.rejects(saveSettings({ apiBaseUrl: 'https://user:pass@example.com' }, file), /用户名或密码/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧配置迁移默认偏移，部分保存不会覆盖另一项设置', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    await writeFile(file, '{"quality":"lossless"}');
    assert.deepEqual(await loadSettings(file), {
      quality: 'lossless', playerBackend: DEFAULT_PLAYER_BACKEND, imageProtocol: DEFAULT_IMAGE_PROTOCOL,
      cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES, lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS,
      smtcOffsetMs: DEFAULT_SMTC_OFFSET_MS, searchLimit: DEFAULT_SEARCH_LIMIT,
      translationMode: DEFAULT_TRANSLATION_MODE, apiBaseUrl: null
    });
    await saveSettings({ lyricOffsetMs: -500 }, file);
    assert.deepEqual(await loadSettings(file), {
      quality: 'lossless', playerBackend: DEFAULT_PLAYER_BACKEND, imageProtocol: DEFAULT_IMAGE_PROTOCOL,
      cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES, lyricOffsetMs: -500, smtcOffsetMs: DEFAULT_SMTC_OFFSET_MS,
      searchLimit: DEFAULT_SEARCH_LIMIT, translationMode: DEFAULT_TRANSLATION_MODE, apiBaseUrl: null
    });
    await saveSettings({ apiBaseUrl: 'https://api.example.com/' }, file);
    await saveSettings({ quality: 'higher' }, file);
    assert.deepEqual(await loadSettings(file), {
      quality: 'higher', playerBackend: DEFAULT_PLAYER_BACKEND, imageProtocol: DEFAULT_IMAGE_PROTOCOL,
      cacheMaxBytes: DEFAULT_IMAGE_CACHE_MAX_BYTES, lyricOffsetMs: -500,
      smtcOffsetMs: DEFAULT_SMTC_OFFSET_MS, searchLimit: DEFAULT_SEARCH_LIMIT,
      translationMode: DEFAULT_TRANSLATION_MODE,
      apiBaseUrl: 'https://api.example.com'
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
