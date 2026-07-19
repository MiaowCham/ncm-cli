import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearDataCache, dataCacheKey, dataCachePath, inspectDataCache, loadCachedData, writeCachedData } from '../src/data-cache.js';

test('缓存键按类型、ID 和 variant 隔离且不暴露原始 ID', () => {
  const base = dataCacheKey({ type: 'lyrics', id: '../347230', variant: 'original' });
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.notEqual(base, dataCacheKey({ type: 'lyrics', id: '../347230', variant: 'translated' }));
  assert.notEqual(base, dataCacheKey({ type: 'track', id: '../347230', variant: 'original' }));
});

test('缓存类型映射到稳定的可读命名空间路径', () => {
  const root = path.join('cache-root');
  assert.equal(dataCachePath({ type: 'track-cover', id: '1' }, root), path.join(root, 'Covers', 'song', '1.png'));
  assert.equal(dataCachePath({ type: 'playlist-cover', id: '2' }, root), path.join(root, 'Covers', 'playlist', '2.png'));
  assert.equal(dataCachePath({ type: 'song-music', id: '3' }, root), path.join(root, 'Musics', 'song', '3.cache'));
  assert.equal(dataCachePath({ type: 'song-lyrics', id: '4' }, root), path.join(root, 'Lyrics', 'song', '4', 'lyric.lrc'));
  assert.equal(dataCachePath({ type: 'song-metadata', id: '5' }, root), path.join(root, 'Metadata', 'song', '5.metadata'));
});

test('缓存统计和分类清理遵守 covers、musics、other 边界', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  try {
    for (const identity of [
      { type: 'track-cover', id: '1' }, { type: 'song-music', id: '1' },
      { type: 'song-lyrics', id: '1' }, { type: 'song-metadata', id: '1' }
    ]) {
      await loadCachedData(identity, { directory, maxBytes: 1024, loader: async () => Buffer.from('1234') });
    }
    assert.deepEqual(await inspectDataCache(directory), { covers: 4, musics: 4, other: 8, total: 16, files: 4 });
    await clearDataCache('other', directory);
    assert.deepEqual(await inspectDataCache(directory), { covers: 4, musics: 4, other: 0, total: 8, files: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('清理 other 缓存时完整保留 UserLyrics 并删除远端歌词', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  try {
    const source = '[00:01]手工歌词';
    const userFile = path.join(directory, 'Lyrics', 'UserLyrics', 'manual', '任意名称.lrc');
    await import('node:fs/promises').then(async ({ mkdir, writeFile }) => {
      await mkdir(path.dirname(userFile), { recursive: true });
      await writeFile(userFile, source, 'utf8');
    });
    await writeCachedData({ type: 'song-lyrics', id: 'remote' }, '[00:01]远端歌词', { directory });
    await clearDataCache('other', directory);
    assert.equal(await readFile(userFile, 'utf8'), source);
    await assert.rejects(readFile(dataCachePath({ type: 'song-lyrics', id: 'remote' }, directory)), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('相同稳定身份并发加载只执行一次 loader', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  let loads = 0;
  try {
    const options = {
      directory,
      maxBytes: 1024,
      loader: async () => { loads += 1; return Buffer.from('data'); }
    };
    const identity = { type: 'track', id: '1' };
    const [first, second] = await Promise.all([
      loadCachedData(identity, options), loadCachedData(identity, options)
    ]);
    assert.deepEqual(first, Buffer.from('data'));
    assert.deepEqual(second, Buffer.from('data'));
    assert.equal(loads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('相同身份在不同缓存目录之间不会共享内存或进行中任务', async () => {
  const firstDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-a-'));
  const secondDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-b-'));
  let loads = 0;
  try {
    const identity = { type: 'lyrics', id: '2' };
    const load = (directory, value) => loadCachedData(identity, {
      directory, maxBytes: 1024,
      loader: async () => { loads += 1; return Buffer.from(value); }
    });
    assert.deepEqual(await load(firstDirectory, 'first'), Buffer.from('first'));
    assert.deepEqual(await load(secondDirectory, 'second'), Buffer.from('second'));
    assert.equal(loads, 2);
  } finally {
    await rm(firstDirectory, { recursive: true, force: true });
    await rm(secondDirectory, { recursive: true, force: true });
  }
});

test('统一容量限制按最近使用时间淘汰缓存项', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  try {
    for (const id of ['old', 'new']) {
      await loadCachedData({ type: 'track-cover', id }, {
        directory, maxBytes: 100, loader: async () => Buffer.alloc(80, id === 'old' ? 1 : 2)
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal((await readdir(directory, { recursive: true })).filter((name) => /\.(?:cache|png|lrc)$/.test(name)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('缓存日志只记录键摘要而不暴露原始 ID', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  const records = [];
  const secretId = 'https://example.test/qr?secret=credential';
  const logger = { info(event, data) { records.push({ event, data }); } };
  try {
    await loadCachedData({ type: 'image-url', id: secretId }, {
      directory, maxBytes: 1024, logger, loader: async () => Buffer.from('data')
    });
    assert.doesNotMatch(JSON.stringify(records), /secret=credential/);
    assert.match(JSON.stringify(records), /"key":"[a-f0-9]{12}"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('内存命中会更新磁盘访问时间以保留热缓存', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  const identity = { type: 'track-cover', id: 'hot' };
  const key = dataCacheKey(identity);
  try {
    const options = { directory, maxBytes: 1024, loader: async () => Buffer.from('hot') };
    await loadCachedData(identity, options);
    const file = dataCachePath(identity, directory);
    const before = (await stat(file)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await loadCachedData(identity, options);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok((await stat(file)).mtimeMs > before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
