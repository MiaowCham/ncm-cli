import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);

const required = process.argv.includes('--required');
const runtime = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'native', 'smtc-bridge', 'NcmCli.SmtcBridge.csproj');
const output = path.join(root, 'native', 'smtc-bridge', 'publish', runtime);
const selfContained = process.env.NCM_SMTC_SELF_CONTAINED === '1';
const result = spawnSync('dotnet', [
  'publish', project,
  '--configuration', 'Release',
  '--runtime', runtime,
  '--self-contained', String(selfContained),
  '--output', output,
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true'
], { stdio: 'inherit', windowsHide: true, shell: false });

if (result.status === 0) {
  const projectDirectory = path.dirname(project);
  for (const directory of ['bin', 'obj']) {
    rmSync(path.join(projectDirectory, directory), { recursive: true, force: true });
  }
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === 'ncm-cli-smtc-bridge.exe') continue;
    rmSync(path.join(output, entry.name), { recursive: true, force: true });
  }
  process.exit(0);
}
const message = 'SMTC helper 构建失败；播放仍可使用，但不会接入 Windows SMTC。请安装 .NET 8 SDK 后运行 npm run build:smtc。';
if (required) {
  console.error(message);
  process.exit(result.status || 1);
}
console.warn(message);
