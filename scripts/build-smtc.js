import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);

const required = process.argv.includes('--required');
const runtime = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'native', 'smtc-bridge');
const output = path.join(project, 'publish', runtime);
const executable = path.join(output, 'ncm-cli-smtc-bridge.exe');
mkdirSync(output, { recursive: true });
const result = spawnSync('go', [
  'build', '-trimpath', '-ldflags=-s -w', '-o', executable, '.'
], {
  cwd: project,
  env: { ...process.env, GOOS: 'windows', GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64' },
  stdio: 'inherit', windowsHide: true, shell: false
});

if (result.status === 0) {
  process.exit(0);
}
rmSync(executable, { force: true });
const message = 'SMTC helper 构建失败；播放仍可使用，但不会接入 Windows SMTC。请安装 Go 1.25 或更高版本后运行 npm run build:smtc。';
if (required) {
  console.error(message);
  process.exit(result.status || 1);
}
console.warn(message);
