import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeCachedData } from '../src/data-cache.js';
import { importLyricsFile, loadUserLyrics, migrateLegacyImportedLyrics, removeUserLyrics, userLyricsDirectory } from '../src/lyric-import.js';
import { loadCachedLyrics } from '../src/resource-cache.js';

const samples = {
  lrc: '[00:01.00]逐行歌词',
  qrc: '[1000,1000]逐字(1000,1000)',
  yrc: '[1000,1000](1000,1000,0)逐字',
  lys: '[0]逐字(1000,1000)',
  lqe: '[lyrics:lys]\n[0]逐字(1000,1000)\n[translation:lrc]\n[00:01]翻译\n[romanization:lrc]\n[00:01]roman'
};

for (const [format, source] of Object.entries(samples)) {
  test(`导入 ${format} 歌词后写入 UserLyrics 并可立即解析`, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-lyric-import-'));
    const file = path.join(directory, `input.${format}`);
    try {
      await writeFile(file, source, 'utf8');
      await writeCachedData({ type: 'song-lyrics-qrc', id: '42' }, samples.qrc, { directory });
      const result = await importLyricsFile('42', `"${file}"`, { directory });
      assert.equal(result.format, format);
      assert.ok(result.selected.lines.length > 0);
      assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(
        path.join(userLyricsDirectory('42', directory), `imported.${format}`), 'utf8'
      )), source);
      let remoteLoads = 0;
      let visibleRefreshes = 0;
      const cached = await loadCachedLyrics('42', async () => {
        remoteLoads += 1;
        return { original: '[00:00]远端', yrc: samples.yrc };
      }, { directory, onCacheUpdated: () => { visibleRefreshes += 1; } });
      assert.equal(cached[format === 'lrc' ? 'original' : format], source);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(remoteLoads, 1);
      assert.equal(visibleRefreshes, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('歌词导入拒绝未知扩展名与不可解析内容', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-lyric-import-'));
  try {
    const txt = path.join(directory, 'input.txt');
    const lrc = path.join(directory, 'empty.lrc');
    await writeFile(txt, '[00:01]歌词', 'utf8');
    await writeFile(lrc, '没有时间戳', 'utf8');
    await assert.rejects(importLyricsFile('42', txt, { directory }), /仅支持/);
    await assert.rejects(importLyricsFile('42', lrc, { directory }), /没有可解析/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('旧版导入标记会迁移到 UserLyrics 命名空间', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-lyric-import-'));
  try {
    await writeCachedData(
      { type: 'song-lyrics-import', id: 'legacy' },
      JSON.stringify({ version: 1, format: 'lrc', source: samples.lrc }),
      { directory }
    );
    const result = await migrateLegacyImportedLyrics('legacy', { directory });
    assert.equal(result.format, 'lrc');
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(
      path.join(userLyricsDirectory('legacy', directory), 'imported.lrc'), 'utf8'
    )), samples.lrc);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('用户歌词支持任意主文件名、格式优先级和同格式无效回退', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-lyric-import-'));
  const target = userLyricsDirectory('88', directory);
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(target, { recursive: true }));
    await writeFile(path.join(target, 'a.lqe'), '无效 LQE', 'utf8');
    await writeFile(path.join(target, 'b.lqe'), samples.lqe, 'utf8');
    await writeFile(path.join(target, 'higher-name.lrc'), samples.lrc, 'utf8');
    const result = await loadUserLyrics('88', { directory });
    assert.equal(result.format, 'lqe');
    assert.equal(path.basename(result.path), 'b.lqe');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('trans 和 roman 仅作为 LRC 附加轨且不参与主歌词选择', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-lyric-import-'));
  const target = userLyricsDirectory('89', directory);
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(target, { recursive: true }));
    await writeFile(path.join(target, 'song.any.lrc'), samples.lrc, 'utf8');
    await writeFile(path.join(target, 'TRANS.LRC'), '[00:01]翻译', 'utf8');
    await writeFile(path.join(target, 'Roman.lrc'), '[00:01]roman', 'utf8');
    await writeFile(path.join(target, 'trans.qrc'), samples.qrc, 'utf8');
    const result = await loadUserLyrics('89', { directory });
    assert.equal(result.format, 'lrc');
    assert.equal(result.lyrics.translated, '[00:01]翻译');
    assert.equal(result.lyrics.romanized, '[00:01]roman');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('删除用户歌词只移除当前曲目目录并保留抓取歌词', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-lyric-import-'));
  try {
    await import('node:fs/promises').then(({ mkdir }) => mkdir(userLyricsDirectory('90', directory), { recursive: true }));
    await writeFile(path.join(userLyricsDirectory('90', directory), 'mine.lrc'), samples.lrc, 'utf8');
    await writeCachedData({ type: 'song-lyrics', id: '90' }, '[00:01]抓取歌词', { directory });
    await removeUserLyrics('90', { directory });
    assert.equal(await loadUserLyrics('90', { directory }), null);
    assert.equal((await loadCachedLyrics('90', async () => ({
      original: '[00:01]不应替换', translated: '', romanized: '', yrc: ''
    }), { directory })).original, '[00:01]抓取歌词');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
