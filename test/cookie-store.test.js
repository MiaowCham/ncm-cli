import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
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
