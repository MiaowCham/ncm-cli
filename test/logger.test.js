import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Logger } from '../src/logger.js';

test('日志写入 JSONL 并脱敏凭证和 URL', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-log-test-'));
  const file = path.join(directory, 'ncm-cli.log');
  try {
    const logger = new Logger({ file, maxBytes: 4096 });
    await logger.info('probe', {
      cookie: 'MUSIC_U=secret',
      error: new Error('failed MUSIC_U=secret https://example.test/song?token=abc')
    });
    await logger.flush();
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(content, /secret|example\.test|token=abc/);
    assert.match(content, /\[REDACTED\]|URL_REDACTED/);
    assert.doesNotThrow(() => JSON.parse(content.trim()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('日志超过上限时轮转', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-log-test-'));
  const file = path.join(directory, 'last.log');
  try {
    const logger = new Logger({ file, maxBytes: 120, now: () => Date.UTC(2026, 6, 18, 8) });
    await logger.info('first', { value: 'a'.repeat(80) });
    await logger.info('second', { value: 'b'.repeat(80) });
    await logger.flush();
    const archive = (await readdir(directory)).find((name) => name !== 'last.log');
    assert.match(await readFile(path.join(directory, archive), 'utf8'), /first/);
    assert.match(await readFile(file, 'utf8'), /second/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('每次启动归档 last.log 并删除一天前的历史日志', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-log-test-'));
  const file = path.join(directory, 'last.log');
  const expired = path.join(directory, '2026-07-16T08-00-00.000Z-1.log');
  const now = Date.UTC(2026, 6, 18, 8);
  try {
    await writeFile(file, 'previous session\n');
    await writeFile(expired, 'expired\n');
    await utimes(expired, new Date(now - 2 * 86400000), new Date(now - 2 * 86400000));
    const logger = new Logger({ file, now: () => now });
    await logger.info('current_session');
    await logger.flush();
    const names = await readdir(directory);
    assert.equal(names.includes(path.basename(expired)), false);
    const archive = names.find((name) => name !== 'last.log');
    assert.match(await readFile(path.join(directory, archive), 'utf8'), /previous session/);
    assert.doesNotMatch(await readFile(file, 'utf8'), /previous session/);
    assert.match(await readFile(file, 'utf8'), /current_session/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
