import { appendFile, chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { configFilePath } from './cookie-store.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SENSITIVE_KEY = /cookie|authorization|token|csrf|password|qrurl|qrimg|unikey|playurl|lyrics?|keywords?/i;

function redactString(value) {
  return String(value)
    .replace(/\b((?:MUSIC_[A-Z_]+|NMTID|__csrf))=[^;\s]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/gi, '[URL_REDACTED]')
    .replace(/data:image\/[^;,]+;base64,[A-Za-z0-9+/=]+/gi, '[IMAGE_REDACTED]');
}

export function redact(value, key = '') {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }
  return value;
}

export function logFilePath(env = process.env) {
  return env.NCM_CLI_LOG_FILE || path.join(path.dirname(configFilePath(env)), 'logs', 'last.log');
}

export class Logger {
  constructor({
    file = logFilePath(),
    level = process.env.NCM_CLI_LOG_LEVEL || 'info',
    maxBytes = 1024 * 1024,
    retentionMs = 24 * 60 * 60 * 1000,
    now = Date.now
  } = {}) {
    this.file = file;
    this.level = LEVELS[level.toLowerCase()] || LEVELS.info;
    this.maxBytes = maxBytes;
    this.retentionMs = retentionMs;
    this.now = now;
    this.archiveSequence = 0;
    this.queue = this.prepare();
  }

  log(level, event, data = {}) {
    if ((LEVELS[level] || LEVELS.info) < this.level) return Promise.resolve();
    const record = `${JSON.stringify({ time: new Date().toISOString(), level, event, ...redact(data) })}\n`;
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        await this.rotateIfNeeded(Buffer.byteLength(record));
        await appendFile(this.file, record, { encoding: 'utf8', mode: 0o600 });
        try { await chmod(this.file, 0o600); } catch {}
      } catch {
        // 日志失败不能影响点歌主流程。
      }
    });
    return this.queue;
  }

  debug(event, data) { return this.log('debug', event, data); }
  info(event, data) { return this.log('info', event, data); }
  warn(event, data) { return this.log('warn', event, data); }
  error(event, data) { return this.log('error', event, data); }
  flush() { return this.queue; }

  async rotateIfNeeded(incomingBytes) {
    let size = 0;
    try { size = (await stat(this.file)).size; } catch {}
    if (size + incomingBytes <= this.maxBytes) return;
    await this.archiveCurrent();
    await this.removeExpiredArchives();
  }

  async prepare() {
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await this.archiveCurrent();
      await this.removeExpiredArchives();
    } catch {
      // 初始化失败与普通写入失败一样，不影响点歌主流程。
    }
  }

  archivePath() {
    const timestamp = new Date(this.now()).toISOString().replace(/:/g, '-');
    const suffix = this.archiveSequence ? `-${this.archiveSequence}` : '';
    this.archiveSequence += 1;
    return path.join(path.dirname(this.file), `${timestamp}-${process.pid}${suffix}.log`);
  }

  async archiveCurrent() {
    let size = 0;
    try { size = (await stat(this.file)).size; } catch { return; }
    if (size <= 0) return;
    try { await rename(this.file, this.archivePath()); } catch {}
  }

  async removeExpiredArchives() {
    const directory = path.dirname(this.file);
    const currentName = path.basename(this.file);
    const cutoff = this.now() - this.retentionMs;
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || entry.name === currentName
          || !/^\d{4}-\d{2}-\d{2}T.+\.log$/.test(entry.name)) return;
      const archive = path.join(directory, entry.name);
      try {
        if ((await stat(archive)).mtimeMs < cutoff) await rm(archive, { force: true });
      } catch {}
    }));
  }
}
