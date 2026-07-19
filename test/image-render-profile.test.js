import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createImageRenderPerformance, loadImageRenderProfile, saveImageRenderProfile
} from '../src/image-render-profile.js';

test('图片性能档案按协议持久化并修复非法字段', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-image-profile-'));
  const file = path.join(directory, 'profile.json');
  try {
    await saveImageRenderProfile({
      limits: { symbols: 24, invalid: 10, ansi: 5000 },
      resolved: { auto: 'symbols', bad: 'invalid' }
    }, file);
    assert.deepEqual(await loadImageRenderProfile(file), {
      version: 1, limits: { symbols: 24 }, resolved: { auto: 'symbols' }
    });
    await saveImageRenderProfile({ limits: { ansi: 18 }, resolved: { auto: 'ansi' } }, file);
    assert.deepEqual(await loadImageRenderProfile(file), {
      version: 1, limits: { ansi: 18 }, resolved: { auto: 'ansi' }
    });
    await writeFile(file, '{broken');
    assert.deepEqual(await loadImageRenderProfile(file), { version: 1, limits: {}, resolved: {} });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('连续慢样本降档，连续快速满档样本逐步恢复', async () => {
  const saved = [];
  const performance = createImageRenderPerformance(null, {
    persist: async (profile) => saved.push(profile)
  });
  assert.equal(performance.maxRows('auto'), Infinity);
  performance.observe({
    requestedProtocol: 'auto', selectedProtocol: 'symbols', renderMs: 400, height: 40, resultRows: 20
  });
  assert.equal(performance.observe({
    requestedProtocol: 'auto', selectedProtocol: 'symbols', renderMs: 420, height: 40, resultRows: 20
  }), 15);
  assert.equal(performance.maxRows('auto'), 15);
  for (let index = 0; index < 3; index += 1) {
    performance.observe({
      requestedProtocol: 'auto', selectedProtocol: 'symbols', renderMs: 80, height: 15
    });
  }
  assert.equal(performance.maxRows('auto'), 18);
  await performance.flush();
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.at(-1).limits, { symbols: 18 });
});

test('下载等待或占位不会作为性能样本进入控制器', () => {
  const performance = createImageRenderPerformance(null);
  performance.observe({ requestedProtocol: 'auto', selectedProtocol: 'symbols', renderMs: 500, height: 0 });
  performance.observe({ requestedProtocol: 'auto', selectedProtocol: 'unknown', renderMs: 500, height: 40 });
  assert.equal(performance.maxRows('auto'), Infinity);
});
