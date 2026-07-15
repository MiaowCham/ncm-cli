import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCookie, saveCookie } from '../src/cookie-store.js';
import { loadSettings, saveSettings, settingsFilePath } from '../src/settings-store.js';

test('音质设置使用独立文件并可持久化', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-settings-'));
  const file = settingsFilePath({ NCM_CLI_CONFIG_DIR: directory });
  const cookieFile = path.join(directory, 'cookie.json');
  try {
    await saveCookie('MUSIC_U=secret', cookieFile);
    await saveSettings({ quality: 'lossless' }, file);
    assert.deepEqual(await loadSettings(file), { quality: 'lossless' });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).quality, 'lossless');
    assert.equal(await loadCookie(cookieFile), 'MUSIC_U=secret');
    assert.notEqual(file, cookieFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('缺失或非法音质设置回退 standard，保存时拒绝非法值', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    assert.deepEqual(await loadSettings(file), { quality: 'standard' });
    await writeFile(file, '{"quality":"unsupported"}');
    assert.deepEqual(await loadSettings(file), { quality: 'standard' });
    await assert.rejects(saveSettings({ quality: 'unsupported' }, file), /不支持的音质等级/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
