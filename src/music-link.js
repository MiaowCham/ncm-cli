const MUSIC_HOSTS = new Set(['music.163.com', 'y.music.163.com']);
const SHORT_HOST = '163cn.tv';

function candidateUrls(input) {
  return [...String(input || '').matchAll(/https?:\/\/[^\s\u00a0]+/giu)]
    .map((match) => match[0].replace(/[)>）\]】}，。！？；：'"”’]+$/u, ''));
}

function musicTarget(url) {
  if (!MUSIC_HOSTS.has(url.hostname.toLowerCase())) return null;
  const pathMatch = url.pathname.match(/\/(song|playlist)(?:\/|$)/i);
  const hashMatch = url.hash.match(/^#\/(song|playlist)(?:\?|$)/i);
  const kind = (pathMatch?.[1] || hashMatch?.[1])?.toLowerCase();
  if (!kind) return null;
  const hashQuery = url.hash.includes('?') ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)) : null;
  const id = url.searchParams.get('id') || hashQuery?.get('id');
  return /^\d+$/.test(id || '') ? { type: kind, id } : null;
}

export function parseNeteaseMusicInput(input) {
  for (const candidate of candidateUrls(input)) {
    let url;
    try { url = new URL(candidate); } catch { continue; }
    const target = musicTarget(url);
    if (target) return target;
    if (url.protocol === 'https:' && url.hostname.toLowerCase() === SHORT_HOST
        && !url.username && !url.password && !url.port) {
      return { type: 'short', url: url.href };
    }
  }
  return null;
}

export async function resolveNeteaseMusicInput(input, {
  signal,
  timeoutMs = 8000,
  fetchImpl = globalThis.fetch
} = {}) {
  const parsed = parseNeteaseMusicInput(input);
  if (!parsed || parsed.type !== 'short') return parsed;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('短链接解析超时', 'TimeoutError')), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(parsed.url, {
      method: 'GET', redirect: 'follow', signal: requestSignal,
      headers: { 'user-agent': 'ncm-cli-player' }
    });
    const target = parseNeteaseMusicInput(response.url);
    await response.body?.cancel?.();
    if (!target || target.type === 'short') throw new Error('短链接没有跳转到可识别的网易云歌曲或歌单');
    return target;
  } finally {
    clearTimeout(timer);
  }
}
