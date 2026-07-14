import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCookie, saveCookie } from '../src/cookie-store.js';

test('Cookie 可以缓存并重新加载', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-test-'));
  const file = path.join(directory, 'nested', 'cookie.json');
  try {
    await saveCookie('MUSIC_U=secret', file);
    assert.equal(await loadCookie(file), 'MUSIC_U=secret');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('加载时自动迁移旧版 Set-Cookie 缓存', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-test-'));
  const file = path.join(directory, 'cookie.json');
  try {
    await writeFile(file, JSON.stringify({ cookie: 'MUSIC_U=old; Path=/;; MUSIC_U=new; Max-Age=10; __csrf=csrf' }));
    assert.equal(await loadCookie(file), 'MUSIC_U=new; __csrf=csrf');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.cookie, 'MUSIC_U=new; __csrf=csrf');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('语义无效的 Cookie 缓存降级为未登录', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-test-'));
  const file = path.join(directory, 'cookie.json');
  try {
    await writeFile(file, JSON.stringify({ cookie: 'not-a-cookie' }));
    assert.equal(await loadCookie(file), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
