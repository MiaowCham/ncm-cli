import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanupStalePlayerSessions, registerPlayerSession } from '../src/player-registry.js';

class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; }
}

test('播放器会话独立登记并在正常退出时删除', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-players-'));
  try {
    const child = new FakeChild(4321);
    const session = registerPlayerSession(child, {
      command: 'mpv.exe', marker: 'unique-ipc-marker', directory, ownerPid: 1234
    });
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(session.file, 'utf8'));
    assert.equal(record.playerPid, 4321);
    assert.equal(record.marker, 'unique-ipc-marker');
    child.emit('exit', 0, null);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('启动时只清理创建者消失且命令行标记匹配的播放器', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-players-'));
  try {
    const records = [
      { id: 'owned', ownerPid: 1, playerPid: 11, marker: 'marker-a' },
      { id: 'stale', ownerPid: 2, playerPid: 22, marker: 'marker-b' },
      { id: 'reused', ownerPid: 3, playerPid: 33, marker: 'marker-c' }
    ];
    for (const record of records) await writeFile(path.join(directory, `${record.id}.json`), JSON.stringify(record));
    const terminated = [];
    const result = await cleanupStalePlayerSessions({
      directory,
      isAlive: (pid) => [1, 11, 22, 33].includes(pid),
      commandLine: (pid) => pid === 22 ? 'mpv --input-ipc-server=marker-b' : 'unrelated mpv',
      terminate: async (pid) => terminated.push(pid)
    });
    assert.deepEqual(terminated, [22]);
    assert.deepEqual(result, { cleaned: 1, retained: 2 });
    assert.deepEqual((await readdir(directory)).sort(), ['owned.json', 'reused.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('损坏记录与已经退出的播放器会被安全移除', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ncm-cli-players-'));
  try {
    await writeFile(path.join(directory, 'broken.json'), '{');
    await writeFile(path.join(directory, 'dead.json'), JSON.stringify({ ownerPid: 2, playerPid: 3, marker: 'x' }));
    const result = await cleanupStalePlayerSessions({ directory, isAlive: () => false });
    assert.deepEqual(result, { cleaned: 0, retained: 0 });
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
