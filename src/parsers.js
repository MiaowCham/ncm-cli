export function parseIdCommand(input) {
  const match = input.trim().match(/^\/?id\s*(?::|=|\s)\s*(\d+)\s*$/i);
  return match ? match[1] : null;
}

export function parseLoginCommand(input) {
  const match = input.trim().match(/^\/login(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const argument = match[1]?.trim() || null;
  if (!argument) return { action: 'qr', cookie: null };
  if (/^status$/i.test(argument)) return { action: 'status', cookie: null };
  return { action: 'cookie', cookie: argument };
}

export function parseSignoutCommand(input) {
  return /^\/signout$/i.test(input.trim());
}

export function parseClearCommand(input) {
  return /^\/clear$/i.test(input.trim());
}

export function parseCacheCommand(input) {
  const match = String(input).trim().match(/^\/cache(?:\s+(\d+))?$/i);
  return match ? { megabytes: match[1] == null ? null : Number(match[1]) } : null;
}

export function parseClearCacheCommand(input) {
  const match = String(input).trim().match(/^\/clrcache(?:\s+(covers|musics|other))?$/i);
  return match ? { group: match[1]?.toLowerCase() || null } : null;
}

export function parseListPlaylistsCommand(input) {
  return /^\/lspl$/i.test(input.trim());
}

export function parsePlaylistCommand(input) {
  const match = input.trim().match(/^\/pl\s+(\d+)\s*$/i);
  return match ? match[1] : null;
}

export const QUALITY_LEVELS = Object.freeze([
  'standard', 'higher', 'exhigh', 'lossless', 'hires', 'jyeffect', 'sky', 'dolby', 'jymaster'
]);

export const PLAYER_BACKENDS = Object.freeze(['auto', 'mpv', 'vlc', 'media-player', 'ffplay']);
export const IMAGE_PROTOCOLS = Object.freeze([
  'auto', 'sixel', 'kitty', 'iterm2', 'symbols', 'ansi', 'ansi256', 'none'
]);

export function parseQualityCommand(input) {
  const match = input.trim().match(/^\/quality(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { level: match[1]?.trim().toLowerCase() || null };
}

export function parsePlayerCommand(input) {
  const match = input.trim().match(/^\/player(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { backend: match[1]?.trim().toLowerCase() || null };
}

export function parseImageCommand(input) {
  const match = input.trim().match(/^\/image(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { protocol: match[1]?.trim().toLowerCase() || null };
}

export function parseOffsetCommand(input) {
  const match = input.trim().match(/^\/offset(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const argument = match[1]?.trim();
  if (!argument) return { milliseconds: null };
  if (!/^[+-]?\d+$/.test(argument)) {
    return { milliseconds: null, error: '播放时间偏移量必须是整数毫秒' };
  }
  return { milliseconds: Number(argument) };
}

export function parseApiCommand(input) {
  const match = input.trim().match(/^\/api(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { url: match[1]?.trim() || null };
}

const LYRIC_FORMATS = new Set(['plain', 'lrc', 'trans', 'all']);

export function splitOutputRedirect(input) {
  const match = input.match(/^(.*?)\s+(?:>|\|)\s*(.+)$/);
  if (!match) return { command: input.trim(), output: null };
  return { command: match[1].trim(), output: match[2].trim() || null };
}

export function parseLyricDirectCommand(input) {
  const { command, output } = splitOutputRedirect(input.trim());
  const match = command.match(/^\/idlyric\s+(\d+)(?:\s+(plain|lrc|trans|all))?$/i);
  if (!match) return null;
  return { id: match[1], format: match[2]?.toLowerCase() || 'plain', output };
}

export function parseLyricSearchCommand(input) {
  const { command, output } = splitOutputRedirect(input.trim());
  const match = command.match(/^\/lyrics?\s+(.+)$/i);
  if (!match) return null;
  const tokens = match[1].trim().split(/\s+/);
  let format = null;
  const candidate = tokens.at(-1)?.toLowerCase();
  if (tokens.length > 1 && LYRIC_FORMATS.has(candidate)) format = tokens.pop().toLowerCase();
  const query = tokens.join(' ').trim();
  return query ? { query, format, output } : null;
}

export function parseNumberSelection(input) {
  const { command, output } = splitOutputRedirect(input.trim());
  if (/^q$/i.test(command)) return { quit: true, index: null, output };
  if (!/^\d+$/.test(command)) return null;
  return { quit: false, index: Number(command) - 1, output };
}

export function parseLyricFormatSelection(input) {
  const { command, output } = splitOutputRedirect(input.trim());
  if (/^q$/i.test(command)) return { quit: true, format: null, output };
  const formats = { '1': 'plain', '2': 'lrc', '3': 'trans', '4': 'all' };
  const format = formats[command] || command.toLowerCase();
  if (!LYRIC_FORMATS.has(format)) return null;
  return { quit: false, format, output };
}

export function normalizeCookie(raw) {
  let value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  if (!value || !value.includes('=')) {
    throw new Error('Cookie 格式无效，应类似 MUSIC_U=xxx; __csrf=xxx');
  }
  value = value.replace(/[\r\n]/g, '').trim();
  const attributes = new Set([
    'path', 'expires', 'max-age', 'domain', 'secure', 'httponly',
    'samesite', 'priority', 'partitioned'
  ]);
  const cookies = new Map();
  const parts = value.split(/;\s*|,\s*(?=[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (!name || !cookieValue || attributes.has(name.toLowerCase())) continue;
    cookies.set(name, cookieValue);
  }
  if (!cookies.size) throw new Error('Cookie 中没有可用的键值对');
  return [...cookies].map(([name, cookieValue]) => `${name}=${cookieValue}`).join('; ');
}

export function normalizeSong(raw) {
  const artists = raw.ar || raw.artists || [];
  const album = raw.al || raw.album || {};
  return {
    id: String(raw.id),
    name: raw.name || '未知歌曲',
    artists: artists.map((item) => item.name).filter(Boolean),
    album: album.name || '未知专辑',
    cover: album.picUrl || album.artist?.img1v1Url || null,
    durationMs: raw.dt || raw.duration || 0,
    fee: raw.fee ?? null
  };
}
