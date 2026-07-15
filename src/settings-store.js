import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';
import { QUALITY_LEVELS } from './parsers.js';

export const DEFAULT_QUALITY = 'standard';

export function settingsFilePath(env = process.env, platform = process.platform) {
  return path.join(path.dirname(configFilePath(env, platform)), 'settings.json');
}

export async function loadSettings(file = settingsFilePath()) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return {
      quality: QUALITY_LEVELS.includes(data.quality) ? data.quality : DEFAULT_QUALITY
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { quality: DEFAULT_QUALITY };
    throw error;
  }
}

export async function saveSettings(settings, file = settingsFilePath()) {
  if (!QUALITY_LEVELS.includes(settings.quality)) throw new Error(`不支持的音质等级：${settings.quality}`);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ quality: settings.quality, updatedAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await chmod(file, 0o600);
  } catch {
    // Windows 的 ACL 不完全映射 POSIX mode。
  }
  return file;
}
