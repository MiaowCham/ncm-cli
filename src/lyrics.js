const TIME_TAG = /\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g;

export function parseLrc(source = '') {
  const lines = [];
  const offset = Number(source.match(/^\[offset:([+-]?\d+)\]/im)?.[1] || 0);
  for (const rawLine of source.split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(TIME_TAG)];
    if (!tags.length) continue;
    const text = rawLine.replace(TIME_TAG, '').trim();
    if (!text) continue;
    for (const tag of tags) {
      const timeMs = Math.max(0, (Number(tag[1]) * 60 + Number(tag[2])) * 1000 + offset);
      lines.push({ timeMs, text });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
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
    .map((line) => line.replace(/^(?:\[[^\]]+\])+\s*/, ''))
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
