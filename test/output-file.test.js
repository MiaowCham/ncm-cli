import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exportExtension, safeFileStem, writeExport } from '../src/output-file.js';

test('目录输出自动生成安全文件名和正确扩展名', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-output-'));
  try {
    const target = path.join(directory, 'lyrics');
    await mkdir(target);
    const first = await writeExport({
      target, content: '内容', kind: 'lyrics', format: 'lrc', title: '歌:曲?', artists: ['歌手']
    });
    const second = await writeExport({
      target, content: '内容2', kind: 'lyrics', format: 'lrc', title: '歌:曲?', artists: ['歌手']
    });
    assert.equal(path.basename(first), '歌_曲_ - 歌手.lrc');
    assert.equal(path.basename(second), '歌_曲_ - 歌手 (2).lrc');
    assert.equal(await readFile(first, 'utf8'), '内容\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('空路径在当前目录自动命名且格式映射稳定', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-output-'));
  try {
    const file = await writeExport({ target: '', content: 'a,b', kind: 'playlist', format: 'csv', title: '列表', cwd: directory });
    assert.equal(file, path.join(directory, '列表.csv'));
    assert.equal(exportExtension('lyrics', 'plain'), '.txt');
    assert.equal(exportExtension('playlist', 'tsv'), '.tsv');
    assert.equal(safeFileStem('CON'), '_CON');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
