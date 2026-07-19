import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dataCachePath } from '../src/data-cache.js';
import { loadCachedImage } from '../src/image-cache.js';

function imageResponse(buffer) {
  return new Response(buffer, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-length': String(buffer.length) }
  });
}

test('相同封面并发请求只下载一次并写入持久缓存', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-cache-'));
  let fetchCount = 0;
  const buffer = Buffer.from('cached image');
  try {
    const options = {
      directory,
      maxBytes: 1024,
      fetchImpl: async () => { fetchCount += 1; return imageResponse(buffer); }
    };
    const [first, second] = await Promise.all([
      loadCachedImage('https://example.test/cover-a.png', options),
      loadCachedImage('https://example.test/cover-a.png', options)
    ]);
    assert.deepEqual(first, buffer);
    assert.deepEqual(second, buffer);
    assert.equal(fetchCount, 1);
    assert.equal((await readdir(directory, { recursive: true })).filter((name) => name.endsWith('.cache')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('取消一个页面等待不会取消共享封面下载', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-cache-'));
  const controller = new AbortController();
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const options = { directory, maxBytes: 1024, fetchImpl: () => response };
  try {
    const cancelled = loadCachedImage('https://example.test/cover-b.png', {
      ...options, signal: controller.signal
    });
    const surviving = loadCachedImage('https://example.test/cover-b.png', options);
    controller.abort();
    release(imageResponse(Buffer.from('shared image')));
    await assert.rejects(cancelled, /aborted|取消/i);
    assert.deepEqual(await surviving, Buffer.from('shared image'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('磁盘缓存超过隐藏容量设置后淘汰旧文件', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-cache-'));
  try {
    const options = {
      directory,
      maxBytes: 100,
      fetchImpl: async () => imageResponse(Buffer.alloc(80, 1))
    };
    await loadCachedImage('https://example.test/cover-c.png', {
      ...options,
      identity: { type: 'track-cover', id: 'cover-c' }
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await loadCachedImage('https://example.test/cover-d.png', {
      ...options,
      identity: { type: 'track-cover', id: 'cover-d' }
    });
    assert.equal((await readdir(directory, { recursive: true })).filter((name) => /\.(?:cache|png|lrc)$/.test(name)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('相同曲目 ID 在封面链接刷新后继续命中稳定缓存', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-cache-'));
  let fetchCount = 0;
  try {
    const options = {
      directory,
      maxBytes: 1024,
      identity: { type: 'track-cover', id: '347230' },
      fetchImpl: async () => { fetchCount += 1; return imageResponse(Buffer.from('stable')); }
    };
    await loadCachedImage('https://example.test/old-cover.png?token=old', options);
    assert.deepEqual(
      await loadCachedImage('https://cdn.example.test/new-cover.png?token=new', options),
      Buffer.from('stable')
    );
    assert.equal(fetchCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('不同资源 ID 即使链接相同也使用独立缓存身份', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-cache-'));
  let fetchCount = 0;
  try {
    const options = {
      directory, maxBytes: 1024,
      fetchImpl: async () => imageResponse(Buffer.from(`image-${++fetchCount}`))
    };
    await loadCachedImage('https://example.test/shared.png', {
      ...options, identity: { type: 'track-cover', id: '1' }
    });
    await loadCachedImage('https://example.test/shared.png', {
      ...options, identity: { type: 'track-cover', id: '2' }
    });
    assert.equal(fetchCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧 URL 哈希图片缓存命中后提升到统一缓存目录', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-data-cache-'));
  const legacyDirectory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-cache-'));
  const source = 'https://example.test/legacy.png#ignored';
  const normalized = new URL(source);
  normalized.hash = '';
  const legacyKey = createHash('sha256').update(normalized.href).digest('hex');
  try {
    await writeFile(path.join(legacyDirectory, `${legacyKey}.img`), Buffer.from('legacy'));
    const result = await loadCachedImage(source, {
      directory,
      legacyDirectory,
      maxBytes: 1024,
      identity: { type: 'track-cover', id: 'legacy-track' },
      fetchImpl: async () => { throw new Error('不应重新下载'); }
    });
    assert.deepEqual(result, Buffer.from('legacy'));
    assert.equal((await readdir(directory, { recursive: true })).filter((name) => name.endsWith('.png')).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(legacyDirectory, { recursive: true, force: true });
  }
});
