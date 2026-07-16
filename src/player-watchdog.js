#!/usr/bin/env node

import { spawn } from 'node:child_process';

const targetPid = Number.parseInt(process.argv[2] || '', 10);
let armed = Number.isInteger(targetPid) && targetPid > 0;
let terminating = false;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function terminateTarget() {
  if (!armed || terminating || !isAlive(targetPid)) {
    process.exit(0);
    return;
  }
  terminating = true;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(targetPid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true
    });
    killer.once('error', () => {
      try { process.kill(targetPid, 'SIGKILL'); } catch {}
      process.exit(0);
    });
    killer.once('exit', () => process.exit(0));
    return;
  }
  try { process.kill(targetPid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    if (isAlive(targetPid)) {
      try { process.kill(targetPid, 'SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 750).unref();
}

process.on('message', (message) => {
  if (message === 'disarm') {
    armed = false;
    process.exit(0);
  }
});
process.once('disconnect', terminateTarget);
process.once('SIGTERM', terminateTarget);
process.once('SIGINT', terminateTarget);

const poll = setInterval(() => {
  if (!isAlive(targetPid)) {
    armed = false;
    clearInterval(poll);
    process.exit(0);
  }
}, 1000);

