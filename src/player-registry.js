import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { configFilePath } from './cookie-store.js';

export function playerRegistryDirectory(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'players');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function windowsCommandLine(pid) {
  const result = spawnSync('wmic.exe', ['process', 'where', `processid=${pid}`, 'get', 'CommandLine', '/value'], {
    encoding: 'utf8', windowsHide: true, timeout: 3000
  });
  return result.status === 0 ? result.stdout : '';
}

function unixCommandLine(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '); }
  catch { return ''; }
}

export function registerPlayerSession(child, {
  command, marker, directory = playerRegistryDirectory(), ownerPid = process.pid
} = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0 || !marker) return null;
  const id = randomUUID();
  const file = path.join(directory, `${id}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  const record = {
    version: 1, id, ownerPid, playerPid: child.pid,
    command: path.basename(String(command || '')), marker: String(marker),
    createdAt: new Date().toISOString()
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  } catch {
    try { rmSync(temporary, { force: true }); } catch {}
    return null;
  }
  const remove = () => { try { rmSync(file, { force: true }); } catch {} };
  child.once?.('exit', remove);
  child.once?.('error', () => { if (!processAlive(child.pid)) remove(); });
  return { file, record, remove };
}

async function killTree(pid, platform = process.platform) {
  if (platform === 'win32') {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    await once(child, 'exit').catch(() => {});
    return;
  }
  try { process.kill(pid, 'SIGTERM'); } catch {}
}

export async function cleanupStalePlayerSessions({
  directory = playerRegistryDirectory(), platform = process.platform,
  isAlive = processAlive,
  commandLine = platform === 'win32' ? windowsCommandLine : unixCommandLine,
  terminate = (pid) => killTree(pid, platform)
} = {}) {
  let files;
  try { files = readdirSync(directory).filter((name) => name.endsWith('.json')); }
  catch { return { cleaned: 0, retained: 0 }; }
  let cleaned = 0;
  let retained = 0;
  for (const name of files) {
    const file = path.join(directory, name);
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch { try { rmSync(file, { force: true }); } catch {}; continue; }
    if (isAlive(record.ownerPid)) { retained += 1; continue; }
    if (!isAlive(record.playerPid)) {
      try { rmSync(file, { force: true }); } catch {}
      continue;
    }
    const actualCommandLine = commandLine(record.playerPid);
    if (!actualCommandLine || !actualCommandLine.includes(record.marker)) {
      retained += 1;
      continue;
    }
    await terminate(record.playerPid);
    try { rmSync(file, { force: true }); } catch {}
    cleaned += 1;
  }
  return { cleaned, retained };
}
