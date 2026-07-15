import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeCookie } from './parsers.js';

export function configFilePath(env = process.env, platform = process.platform) {
  if (env.NCM_CLI_CONFIG_DIR) return path.join(env.NCM_CLI_CONFIG_DIR, 'cookie.json');
  if (platform === 'win32' && env.LOCALAPPDATA) {
    return path.join(env.LOCALAPPDATA, 'ncm-cli', 'cookie.json');
  }
  const root = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(root, 'ncm-cli', 'cookie.json');
}

export async function loadCookie(file = configFilePath()) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (typeof data.cookie !== 'string') return null;
    let normalized;
    try {
      normalized = normalizeCookie(data.cookie);
    } catch {
      return null;
    }
    if (normalized !== data.cookie) await saveCookie(normalized, file);
    return normalized;
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function saveCookie(cookie, file = configFilePath()) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ cookie, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows 的 ACL 不完全映射 POSIX mode；写入时仍请求最小权限。
  }
  return file;
}

export async function clearCookie(file = configFilePath()) {
  try {
    await unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
