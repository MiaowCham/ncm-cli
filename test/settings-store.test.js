import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCookie, saveCookie } from '../src/cookie-store.js';
import {
  loadSettings, saveSettings, settingsFilePath, DEFAULT_LYRIC_OFFSET_MS
} from '../src/settings-store.js';

test('音质设置使用独立文件并可持久化', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-settings-'));
  const file = settingsFilePath({ NCM_CLI_CONFIG_DIR: directory });
  const cookieFile = path.join(directory, 'cookie.json');
  try {
    await saveCookie('MUSIC_U=secret', cookieFile);
    await saveSettings({ quality: 'lossless', lyricOffsetMs: 1500 }, file);
    assert.deepEqual(await loadSettings(file), { quality: 'lossless', lyricOffsetMs: 1500 });
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
      quality: 'standard', lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS
    });
    await writeFile(file, '{"quality":"unsupported"}');
    assert.deepEqual(await loadSettings(file), {
      quality: 'standard', lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS
    });
    await assert.rejects(saveSettings({ quality: 'unsupported' }, file), /不支持的音质等级/);
    await assert.rejects(saveSettings({ lyricOffsetMs: 60001 }, file), /歌词偏移量/);
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
      quality: 'lossless', lyricOffsetMs: DEFAULT_LYRIC_OFFSET_MS
    });
    await saveSettings({ lyricOffsetMs: -500 }, file);
    assert.deepEqual(await loadSettings(file), { quality: 'lossless', lyricOffsetMs: -500 });
    await saveSettings({ quality: 'higher' }, file);
    assert.deepEqual(await loadSettings(file), { quality: 'higher', lyricOffsetMs: -500 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
