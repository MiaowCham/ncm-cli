import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerPlayerSession } from './player-registry.js';

const watchdogPath = fileURLToPath(new URL('./player-watchdog.js', import.meta.url));

export function guardPlayerProcess(child, {
  spawnProcess = spawn, nodePath = process.execPath, command = '', marker = '', registerSession = registerPlayerSession
} = {}) {
  if (!Number.isInteger(child?.pid) || child.pid <= 0) return null;

  let guardian;
  try {
    guardian = spawnProcess(nodePath, [watchdogPath, String(child.pid)], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      detached: process.platform === 'win32'
    });
  } catch {
    return null;
  }

  guardian.once?.('error', () => {});
  guardian.unref?.();
  guardian.channel?.unref?.();
  registerSession(child, { command, marker });

  const disarm = () => {
    try { guardian.send?.('disarm', () => {}); } catch {}
    try { guardian.disconnect?.(); } catch {}
  };
  child.once?.('exit', disarm);
  child.once?.('error', () => {
    if (child.pid == null) disarm();
  });
  return guardian;
}
