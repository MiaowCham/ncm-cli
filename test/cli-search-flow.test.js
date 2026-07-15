import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { saveSettings } from '../src/settings-store.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCli(args, { env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, 'bin', 'ncm.js'), ...args], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let stage = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI 流程测试超时\n${stdout}\n${stderr}`));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stage === 0 && /选择序号/.test(stdout)) {
        stage = 1;
        child.stdin.write('1\n');
      } else if (stage === 1 && /\[p\]播放/.test(stdout)) {
        stage = 2;
        child.stdin.write('q\n');
      } else if (stage === 2 && /搜索歌曲、输入 ID 点歌/.test(stdout)) {
        stage = 3;
        child.stdin.end('/quit\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('普通搜索的歌曲详情退出后直接回到主页', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ncm-search-flow-'));
  const rawSong = {
    id: 1,
    name: '测试歌',
    ar: [{ name: '测试歌手' }],
    al: { name: '测试专辑', picUrl: null },
    dt: 1000
  };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/cloudsearch')) {
      response.end(JSON.stringify({ result: { songs: [rawSong] } }));
    } else if (request.url.startsWith('/song/detail')) {
      response.end(JSON.stringify({ songs: [rawSong] }));
    } else {
      response.statusCode = 404;
      response.end('{"message":"not found"}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await saveSettings({ apiBaseUrl: baseUrl }, path.join(directory, 'settings.json'));
    const result = await runCli(['测试'], {
      env: { NCM_CLI_CONFIG_DIR: directory, NCM_API_BASE_URL: '' }
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /无效序号/);
    assert.match(result.stdout, /搜索歌曲、输入 ID 点歌/);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(directory, { recursive: true, force: true });
  }
});
