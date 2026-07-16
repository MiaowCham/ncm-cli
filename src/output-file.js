import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safeFileStem(value, fallback = 'output') {
  let stem = String(value || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!stem) stem = fallback;
  if (RESERVED.test(stem)) stem = `_${stem}`;
  return stem.slice(0, 120).replace(/[. ]+$/g, '') || fallback;
}

export function exportExtension(kind, format) {
  if (kind === 'lyrics') return format === 'plain' ? '.txt' : '.lrc';
  return format === 'csv' ? '.csv' : format === 'tsv' ? '.tsv' : '.txt';
}

async function pathKind(file) {
  try {
    const info = await stat(file);
    return info.isDirectory() ? 'directory' : 'file';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

export async function writeExport({ target, content, kind, format, title, artists = [], cwd = process.cwd() }) {
  const extension = exportExtension(kind, format);
  const entered = String(target || '').trim();
  const raw = ((entered.startsWith('"') && entered.endsWith('"'))
    || (entered.startsWith("'") && entered.endsWith("'"))) ? entered.slice(1, -1) : entered;
  let resolved = path.resolve(cwd, raw || '.');
  const existing = await pathKind(resolved);
  const directoryTarget = !raw || existing === 'directory'
    || (existing === 'missing' && (/[\\/]$/.test(raw) || path.extname(resolved) === ''));
  if (!directoryTarget) {
    if (existing === 'file') throw new Error(`目标文件已存在，未覆盖：${resolved}`);
    await mkdir(path.dirname(resolved), { recursive: true });
    if (!path.extname(resolved)) resolved += extension;
    await writeFile(resolved, `${content}\n`, { encoding: 'utf8', flag: 'wx' });
    return resolved;
  }
  await mkdir(resolved, { recursive: true });
  const artistText = Array.isArray(artists) ? artists.filter(Boolean).join('、') : String(artists || '');
  const suggested = kind === 'lyrics' && artistText ? `${title} - ${artistText}` : title;
  const stem = safeFileStem(suggested, kind === 'lyrics' ? '歌词' : '歌单');
  for (let number = 1; ; number += 1) {
    const suffix = number === 1 ? '' : ` (${number})`;
    const file = path.join(resolved, `${stem}${suffix}${extension}`);
    try {
      await writeFile(file, `${content}\n`, { encoding: 'utf8', flag: 'wx' });
      return file;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}
