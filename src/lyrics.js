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
