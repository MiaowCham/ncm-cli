import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const file = path.join(directory, 'ncm-cli.log');
  try {
    const logger = new Logger({ file, maxBytes: 120, backups: 2 });
    await logger.info('first', { value: 'a'.repeat(80) });
    await logger.info('second', { value: 'b'.repeat(80) });
    await logger.flush();
    assert.match(await readFile(`${file}.1`, 'utf8'), /first/);
    assert.match(await readFile(file, 'utf8'), /second/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
