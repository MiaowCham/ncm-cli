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

export function parseLyricAction(input) {
  const match = input.trim().match(/^\/?(?:l|lyric|歌词)(?:\s*(?:>|\|)\s*(.+))?$/i);
  if (!match) return null;
  return { output: match[1]?.trim() || null };
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
