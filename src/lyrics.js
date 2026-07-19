const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?\]/g;

const SYLLABLE_LINE = /^\[(\d+),(\d+)\](.*)$/;
const SYLLABLE_TOKEN = /(.*?)\((\d+),(\d+)(?:,\d+)?\)/g;

function tagTimeMs(tag, offset) {
  const major = Number(tag[1]);
  const minor = Number(tag[2]);
  const seconds = tag[3] == null ? minor : Number(tag[3]);
  const fraction = tag[3] == null ? (tag[4] || '') : (tag[4] || '');
  const fractionMs = fraction ? Number(fraction.padEnd(3, '0')) : 0;
  const total = tag[3] == null ? major * 60 + minor : major * 3600 + minor * 60 + seconds;
  return Math.max(0, total * 1000 + fractionMs + offset);
}

export function parseLrc(source = '') {
  const lines = [];
  const offset = Number(source.match(/^\[offset:([+-]?\d+)\]/im)?.[1] || 0);
  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trimEnd();
    const tags = [...trimmed.matchAll(TIME_TAG)];
    if (!tags.length) continue;
    const trailing = tags.length > 1 && tags.at(-1).index + tags.at(-1)[0].length === trimmed.length
      ? tags.pop()
      : null;
    const text = trimmed.replace(TIME_TAG, '').trim();
    if (!text) continue;
    for (const tag of tags) {
      const timeMs = tagTimeMs(tag, offset);
      const endTimeMs = trailing
        ? Math.max(timeMs, tagTimeMs(trailing, offset))
        : undefined;
      lines.push({ timeMs, text, ...(endTimeMs == null ? {} : { endTimeMs }) });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

function parseSyllableLines(source = '') {
  const output = [];
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(SYLLABLE_LINE) || line.match(/^<(?:(\d+),(\d+))>(.*)$/);
    if (!match) continue;
    const lineStart = Number(match[1]);
    const lineEnd = lineStart + Number(match[2]);
    const syllables = [];
    let token;
    const body = match[3];
    if (/^\(\d+,\d+(?:,\d+)?\)/.test(body)) {
      const yrcToken = /\((\d+),(\d+)(?:,\d+)?\)([^()]*)/g;
      while ((token = yrcToken.exec(body))) {
        const start = Number(token[1]);
        syllables.push({ text: token[3], startTime: start, endTime: start + Number(token[2]) });
      }
    } else {
      SYLLABLE_TOKEN.lastIndex = 0;
      while ((token = SYLLABLE_TOKEN.exec(body))) {
        const start = Number(token[2]);
        syllables.push({ text: token[1], startTime: start, endTime: start + Number(token[3]) });
      }
    }
    const text = syllables.length ? syllables.map((item) => item.text).join('') : match[3];
    if (text) output.push({ timeMs: lineStart, endTimeMs: lineEnd, text, syllables });
  }
  return output;
}

export function parseQrc(source = '') { return parseSyllableLines(source); }

export function parseLyricifySyllable(source = '') {
  const output = [];
  for (const raw of String(source).split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(/^\[\d+\](.*)$/);
    if (!match) continue;
    const body = match[1].trim();
    const syllables = [];
    const tokenPattern = /(.*?)\((\d+),(\d+)\)/g;
    let token;
    while ((token = tokenPattern.exec(body))) {
      const startTime = Number(token[2]);
      syllables.push({ text: token[1], startTime, endTime: startTime + Number(token[3]) });
    }
    if (!syllables.length) continue;
    const text = syllables.map((item) => item.text).join('');
    const timeMs = Math.min(...syllables.map((item) => item.startTime));
    const endTimeMs = Math.max(...syllables.map((item) => item.endTime));
    if (text.trim()) output.push({ timeMs, endTimeMs, text, syllables });
  }
  return output.sort((a, b) => a.timeMs - b.timeMs);
}

export function parseYrc(source = '') {
  let text = String(source);
  try {
    const payload = JSON.parse(text);
    text = payload?.yrc?.lyric || payload?.lyric || text;
  } catch { /* 原始逐行 YRC */ }
  return parseSyllableLines(text.replace(/^\{.*\}\s*$/gm, ''));
}

export function chooseLyricSource(input = {}) {
  const lys = typeof input?.lys === 'string' ? input.lys : '';
  const qrc = typeof input?.qrc === 'string' ? input.qrc : '';
  const yrc = typeof input?.yrc === 'string' ? input.yrc : '';
  const original = typeof input?.original === 'string' ? input.original : '';
  for (const [type, source, parse] of [
    ['lys', lys, parseLyricifySyllable],
    ['qrc', qrc, parseQrc],
    ['yrc', yrc, parseYrc],
    ['lrc', original, parseLrc]
  ]) {
    if (!source.trim()) continue;
    const lines = parse(source);
    if (lines.length) return { source, type, lines };
  }
  return { source: '', type: 'lrc', lines: [] };
}

export function currentLyric(lines, elapsedMs) {
  let current = '';
  for (const line of lines) {
    if (line.timeMs > elapsedMs) break;
    current = line.text;
  }
  return current;
}

export function plainLyrics(source = '') {
  return source
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^(?:\[[^\]]+\])+\s*/, '')
      .replace(/\[[0-9]{1,3}:[0-9]{1,2}(?::[0-9]{1,2})?(?:\.[0-9]{1,3})?\]\s*$/, ''))
    .filter(Boolean)
    .join('\n');
}

function formatLrcTime(timeMs) {
  const safe = Math.max(0, Math.round(timeMs));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const milliseconds = safe % 1000;
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`;
}

export function mergeTranslatedLrc(original = '', translated = '') {
  const timeline = new Map();
  for (const [kind, source] of [['original', original], ['translated', translated]]) {
    for (const line of parseLrc(source)) {
      const entry = timeline.get(line.timeMs) || { original: [], translated: [] };
      entry[kind].push(line.text);
      timeline.set(line.timeMs, entry);
    }
  }
  const output = [];
  for (const [timeMs, entry] of [...timeline].sort(([left], [right]) => left - right)) {
    const tag = formatLrcTime(timeMs);
    for (const text of entry.original) output.push(`${tag}${text}`);
    for (const text of entry.translated) {
      if (text && !entry.original.includes(text)) output.push(`${tag}${text}`);
    }
  }
  return output.join('\n');
}
