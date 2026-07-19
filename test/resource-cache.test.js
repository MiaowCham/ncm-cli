import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataCachePath } from '../src/data-cache.js';
import { loadCachedJson, loadCachedLyrics, readSongUserState, updateSongUserState } from '../src/resource-cache.js';

test('JSON 元数据立即返回缓存并在后台刷新', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-resource-cache-'));
  let loads = 0;
  try {
    const options = { directory, maxBytes: 1024 };
    const identity = { type: 'song-metadata', id: '1' };
    const loader = async () => ({ id: String(++loads), name: 'song' });
    assert.equal((await loadCachedJson(identity, loader, options)).id, '1');
    assert.equal((await loadCachedJson(identity, loader, options)).id, '1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(loads, 2);
    assert.equal(JSON.parse(await readFile(dataCachePath(identity, directory), 'utf8')).payload.name, 'song');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('歌曲歌词偏移写入曲目元数据', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-resource-cache-'));
  try {
    await loadCachedJson({ type: 'song-metadata', id: 'state' }, async () => ({ id: 'state' }), { directory });
    await updateSongUserState('state', { lyricOffsetMs: 350 }, { directory });
    assert.deepEqual(await readSongUserState('state', { directory }), { lyricOffsetMs: 350 });
    assert.equal(JSON.parse(await readFile(
      dataCachePath({ type: 'song-metadata', id: 'state' }, directory), 'utf8'
    )).payload.id, 'state');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('歌词三轨分别写入 LRC 命名空间并共享一次请求', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-resource-cache-'));
  let loads = 0;
  try {
    const result = await loadCachedLyrics('2', async () => {
      loads += 1;
      return { original: '[00:00]原文', translated: '[00:00]翻译', romanized: '[00:00]roman' };
    }, { directory, maxBytes: 1024 });
    assert.equal(result.translated, '[00:00]翻译');
    assert.equal(loads, 1);
    assert.equal(await readFile(dataCachePath({ type: 'song-lyrics', id: '2' }, directory), 'utf8'), '[00:00]原文');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
