import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const required = process.argv.includes('--required');
const force = process.argv.includes('--force');
const buildAll = process.argv.includes('--all');
const runtimeByArch = { x64: 'win-x64', arm64: 'win-arm64' };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'native', 'smtc-bridge');
const targets = buildAll
  ? [{ runtime: 'win-x64', goarch: 'amd64' }, { runtime: 'win-arm64', goarch: 'arm64' }]
  : runtimeByArch[process.arch]
    ? [{ runtime: runtimeByArch[process.arch], goarch: process.arch === 'arm64' ? 'arm64' : 'amd64' }]
    : [];

if (process.platform !== 'win32' && !buildAll) process.exit(0);
if (!targets.length) {
  const message = `当前 Node.js 架构 ${process.arch} 不支持 SMTC helper；仅支持 x64 和 arm64。`;
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

let failed = false;
for (const { runtime, goarch } of targets) {
  const output = path.join(project, 'publish', runtime);
  const executable = path.join(output, 'ncm-cli-smtc-bridge.exe');
  if (!force && existsSync(executable)) {
    console.log(`使用预编译 SMTC helper：${runtime}`);
    continue;
  }

  mkdirSync(output, { recursive: true });
  const temporary = `${executable}.tmp`;
  rmSync(temporary, { force: true });
  const result = spawnSync('go', [
    'build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', temporary, '.'
  ], {
    cwd: project,
    env: { ...process.env, GOOS: 'windows', GOARCH: goarch },
    stdio: 'inherit', windowsHide: true, shell: false
  });
  if (result.status === 0) {
    rmSync(executable, { force: true });
    renameSync(temporary, executable);
    console.log(`已构建 SMTC helper：${runtime}`);
    continue;
  }
  rmSync(temporary, { force: true });
  failed = true;
  const message = `SMTC helper ${runtime} 构建失败；已有预编译文件不会被删除。请安装 Go 1.25 或更高版本后重试。`;
  if (required) console.error(message);
  else console.warn(message);
}

if (failed && required) process.exit(1);
