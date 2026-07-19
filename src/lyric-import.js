import path from 'node:path';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dataCacheDirectory, dataCachePath, removeCachedData } from './data-cache.js';
import { chooseLyricSource, parseLqe } from './lyrics.js';

const FORMATS = new Set(['lrc', 'qrc', 'yrc', 'lys', 'lqe']);
const FORMAT_PRIORITY = ['lqe', 'lys', 'qrc', 'yrc', 'lrc'];
const LEGACY_LYRIC_TYPES = [
  'song-lyrics', 'song-lyrics-translated', 'song-lyrics-romanized',
  'song-lyrics-qrc', 'song-lyrics-yrc', 'song-lyrics-lys', 'song-lyrics-lqe', 'song-lyrics-import'
];

export function userLyricsDirectory(songId, directory = dataCacheDirectory()) {
  const id = String(songId ?? '').trim();
  if (!id || id === '.' || id === '..' || /[\\/\0]/.test(id)) throw new TypeError('歌曲 ID 无效');
  return path.join(directory, 'Lyrics', 'UserLyrics', id);
}

export async function removeUserLyrics(songId, options = {}) {
  await rm(userLyricsDirectory(songId, options.directory), { recursive: true, force: true });
}

export function importedLyrics(format, source, translated = '', romanized = '') {
  if (format === 'lqe') {
    const parsed = parseLqe(source);
    return {
      original: parsed.original,
      translated: parsed.translated || translated,
      romanized: parsed.romanized || romanized,
      lqe: source
    };
  }
  if (format === 'yrc') {
    let original = '';
    try {
      const payload = JSON.parse(source);
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      original = data?.lrc?.lyric || '';
      translated ||= data?.ytlrc?.lyric || data?.tlyric?.lyric || '';
      romanized ||= data?.yromalrc?.lyric || data?.romalrc?.lyric || '';
    } catch {}
    return { original, translated, romanized, yrc: source };
  }
  return format === 'lrc'
    ? { original: source, translated, romanized }
    : { original: '', translated, romanized, [format]: source };
}

async function lyricFiles(songId, options = {}) {
  const directory = userLyricsDirectory(songId, options.directory);
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && FORMATS.has(path.extname(entry.name).slice(1).toLowerCase()))
    .map((entry) => ({
      name: entry.name,
      stem: path.basename(entry.name, path.extname(entry.name)).toLowerCase(),
      format: path.extname(entry.name).slice(1).toLowerCase(),
      file: path.join(directory, entry.name)
    }))
    .sort((a, b) => {
      const normalizedA = a.name.normalize('NFC').toLowerCase();
      const normalizedB = b.name.normalize('NFC').toLowerCase();
      return normalizedA < normalizedB ? -1 : normalizedA > normalizedB ? 1
        : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
}

export async function loadUserLyrics(songId, options = {}) {
  const files = await lyricFiles(songId, options);
  const special = async (stem) => {
    const file = files.find((entry) => entry.stem === stem && entry.format === 'lrc');
    return file ? readFile(file.file, 'utf8') : '';
  };
  const [translated, romanized] = await Promise.all([special('trans'), special('roman')]);
  for (const format of FORMAT_PRIORITY) {
    for (const file of files.filter((entry) => entry.format === format && !['trans', 'roman'].includes(entry.stem))) {
      const source = await readFile(file.file, 'utf8');
      const lyrics = importedLyrics(format, source, translated, romanized);
      const selected = chooseLyricSource(lyrics);
      if (selected.lines.length) return { format, path: file.file, lyrics, selected };
    }
  }
  return null;
}

export async function migrateLegacyImportedLyrics(songId, options = {}) {
  let record;
  try {
    record = JSON.parse(await readFile(dataCachePath({ type: 'song-lyrics-import', id: songId }, options.directory), 'utf8'));
  } catch { return null; }
  if (record?.version !== 1 || !FORMATS.has(record.format) || typeof record.source !== 'string') return null;
  const directory = userLyricsDirectory(songId, options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, `imported.${record.format}`), record.source, { encoding: 'utf8', mode: 0o600 });
  await Promise.all(LEGACY_LYRIC_TYPES.map((type) => removeCachedData(
    { type, id: songId }, { directory: options.directory }
  )));
  return loadUserLyrics(songId, options);
}

export async function importLyricsFile(songId, filePath, options = {}) {
  const inputPath = String(filePath ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  const extension = path.extname(inputPath);
  const format = extension.slice(1).toLowerCase();
  const stem = path.basename(inputPath, extension).toLowerCase();
  if (!FORMATS.has(format)) throw new Error('仅支持 lrc、qrc、yrc、lys、lqe 歌词文件');
  if (['trans', 'roman'].includes(stem)) throw new Error('trans 和 roman 是附加歌词保留文件名，不能作为主歌词导入');
  const source = await readFile(inputPath, 'utf8');
  const lyrics = importedLyrics(format, source);
  const selected = chooseLyricSource(lyrics);
  if (!selected.lines.length) throw new Error(`${format.toUpperCase()} 文件中没有可解析的歌词`);
  const directory = userLyricsDirectory(songId, options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `imported.${format}`);
  const temporary = path.join(directory, `.imported.${format}-${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(temporary, source, { encoding: 'utf8', mode: 0o600 });
    for (const file of await lyricFiles(songId, options)) {
      if (!['trans', 'roman'].includes(file.stem)) await rm(file.file, { force: true });
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return loadUserLyrics(songId, options);
}
