import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { NcmApi } from './api.js';
import { loadCookie, saveCookie } from './cookie-store.js';
import { mergeTranslatedLrc, plainLyrics } from './lyrics.js';
import { Logger } from './logger.js';
import { playWithProgress, tryRenderImage } from './media.js';
import { normalizeCookie, parseIdCommand, parseLoginCommand, parseLyricAction } from './parsers.js';

function isAbortError(error) {
  return error?.name === 'AbortError' || ['ABORT_ERR', 'ERR_USE_AFTER_CLOSE'].includes(error?.code);
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function printHelp() {
  console.log(`
${chalk.bold('命令')}
  关键词              搜索歌曲
  id:347230           按 ID 点歌（也支持 ID=、id 空格、/id）
  /login              扫码登录
  /login <cookie>     保存并使用已有 Cookie
  /login status       查看服务端验证的登录状态
  /lyrics <关键词>    按歌词内容搜索（也支持“歌词:关键词”）
  /lyric <歌曲ID>     获取指定歌曲歌词并选择输出格式
  /help               显示帮助
  /quit               退出

选中歌曲后：p 播放，/lyric 获取歌词，u 获取播放链接，b 返回。
歌词支持纯文本、原始 LRC、翻译 LRC、原文+翻译合并 LRC；可用
${chalk.cyan('/lyric > 文件名.lrc')} 或 ${chalk.cyan('/lyric | 文件名.lrc')} 写入文件。
`);
}

function printSearchResults(songs) {
  console.log();
  songs.forEach((song, index) => {
    console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${chalk.bold(song.name)} — ${song.artists.join('/')}  ${chalk.gray(`[${song.id}] ${formatDuration(song.durationMs)}`)}`);
  });
}

async function ask(rl, prompt, signal) {
  return rl.question(prompt, { signal });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new DOMException('操作已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function showSong(song, signal) {
  console.log(`\n${chalk.bold.green(song.name)}`);
  console.log(`歌手：${song.artists.join('/') || '未知'}\n专辑：${song.album}\nID：${song.id}\n时长：${formatDuration(song.durationMs)}`);
  if (song.cover) {
    const rendered = await tryRenderImage(song.cover, { signal });
    if (!rendered) console.log(`封面：${song.cover}`);
  }
}

async function refreshAuthState(api, authState, signal, logger) {
  if (!api.cookie) {
    Object.assign(authState, { loggedIn: false, verified: true, nickname: null });
    return authState;
  }
  try {
    const status = await api.loginStatus({ signal, timeoutMs: 8000 });
    Object.assign(authState, {
      loggedIn: status.loggedIn,
      verified: true,
      nickname: status.profile?.nickname || null
    });
    void logger.info('login_status', { loggedIn: authState.loggedIn });
  } catch (error) {
    if (isAbortError(error)) throw error;
    Object.assign(authState, { loggedIn: false, verified: false, nickname: null });
    void logger.warn('login_status_failed', { error });
  }
  return authState;
}

function printLoginStatus(authState) {
  if (authState.loggedIn) {
    console.log(`已登录${authState.nickname ? `：${authState.nickname}` : ''}`);
  } else if (!authState.verified) {
    console.log('存在缓存 Cookie，但暂时无法向服务端验证登录状态。');
  } else {
    console.log('未登录，或缓存 Cookie 已失效。');
  }
}

async function handleLogin(api, authState, signal, logger) {
  const key = await api.qrKey({ signal });
  const qr = await api.qrCreate(key, { signal });
  console.log(`\n登录链接：${qr.qrurl}`);
  let qrRendered = false;
  try {
    if (!process.stdout.isTTY) throw new Error('非交互终端');
    qrcode.generate(qr.qrurl, { small: true }, (code) => console.log(code));
    qrRendered = true;
  } catch {}
  if (!qrRendered && qr.qrimg) qrRendered = await tryRenderImage(qr.qrimg, { signal });
  if (!qrRendered) console.log('当前终端无法绘制二维码，请打开上方登录链接。');
  console.log('请使用网易云音乐 App 扫码并确认（等待最多 3 分钟，Ctrl+C 可退出）…');

  const deadline = Date.now() + 180000;
  let lastCode;
  while (Date.now() < deadline) {
    const status = await api.qrCheck(key, { signal });
    if (status.code !== lastCode) {
      if (status.code === 802) console.log('已扫码，请在手机上确认。');
      lastCode = status.code;
    }
    if (status.code === 803 && status.cookie) {
      const cookie = normalizeCookie(status.cookie);
      api.setCookie(cookie);
      const file = await saveCookie(cookie);
      await refreshAuthState(api, authState, signal, logger);
      if (!authState.loggedIn) throw new Error('二维码已确认，但服务端未验证登录状态，请重试');
      void logger.info('login_success', { method: 'qr' });
      console.log(`登录成功，Cookie 已缓存：${file}`);
      printLoginStatus(authState);
      return;
    }
    if (status.code === 800) throw new Error('二维码已过期，请重新执行 /login');
    await delay(2000, signal);
  }
  throw new Error('登录等待超时，请重新执行 /login');
}

async function useProvidedCookie(api, authState, raw, signal, logger) {
  const cookie = normalizeCookie(raw);
  api.setCookie(cookie);
  const file = await saveCookie(cookie);
  await refreshAuthState(api, authState, signal, logger);
  void logger.info('login_cookie_saved', { verified: authState.loggedIn });
  console.log(`Cookie 已缓存到 ${file}`);
  printLoginStatus(authState);
}

async function writeLyrics(target, content) {
  const file = path.resolve(process.cwd(), target.replace(/^['"]|['"]$/g, ''));
  try {
    await writeFile(file, `${content}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`目标文件已存在，未覆盖：${file}`);
    throw error;
  }
  console.log(`歌词已写入：${file}`);
}

async function lyricMenu(rl, api, song, { outputFile = null, signal } = {}) {
  const lyrics = await api.lyrics(song.id, { signal });
  console.log(`
歌词格式：
  1. 纯歌词
  2. 原始 LRC 歌词
  3. LRC 翻译
  4. 原始 LRC + 翻译（按时间戳合并）`);
  const choice = (await ask(rl, '选择格式 [1-4]：', signal)).trim();
  let content;
  switch (choice) {
    case '1':
    case 'plain':
      content = plainLyrics(lyrics.original);
      break;
    case '2':
    case 'lrc':
      content = lyrics.original;
      break;
    case '3':
    case 'translated':
    case 'translation':
      content = lyrics.translated;
      break;
    case '4':
    case 'merged':
      content = mergeTranslatedLrc(lyrics.original, lyrics.translated);
      break;
    default:
      console.log('已取消歌词输出。');
      return;
  }
  if (!content) content = '暂无对应歌词';
  if (outputFile) await writeLyrics(outputFile, content);
  else console.log(`\n${content}`);
}

function unavailableUrlMessage(result, authState) {
  const code = result?.code ?? result?.attempts?.at(-1)?.code ?? '未知';
  const auth = authState.loggedIn ? '已登录' : authState.verified ? '未登录' : '登录状态未验证';
  return `无法播放：API 返回歌曲状态 code=${code}，未提供 URL（当前${auth}）。可能受会员、版权或地区限制。`;
}

async function songMenu(rl, api, song, context) {
  const { signal, logger, authState } = context;
  await showSong(song, signal);
  let cachedLyrics = null;
  while (true) {
    const action = (await ask(rl, chalk.yellow('\n[p]播放 [/lyric]歌词 [u]播放链接 [b]返回 > '), signal)).trim();
    if (/^(?:b|back|返回)$/i.test(action)) return;
    const lyricAction = parseLyricAction(action);
    if (lyricAction) {
      await lyricMenu(rl, api, song, { outputFile: lyricAction.output, signal });
      continue;
    }
    if (/^(?:u|url|链接)$/i.test(action)) {
      const result = await api.songUrl(song.id, { signal });
      console.log(result?.url || unavailableUrlMessage(result, authState));
      continue;
    }
    if (/^(?:p|play|播放)$/i.test(action)) {
      const result = await api.songUrl(song.id, { signal });
      if (!result?.url) {
        console.log(unavailableUrlMessage(result, authState));
        console.log(`诊断日志：${logger.file}`);
        continue;
      }
      cachedLyrics ||= await api.lyrics(song.id, { signal });
      console.log(`使用本机播放器播放：${song.name}`);
      await playWithProgress({
        url: result.url,
        durationMs: song.durationMs,
        lyricSource: cachedLyrics.original,
        signal,
        logger
      });
      continue;
    }
    console.log('未知选项，请输入 p、/lyric、u 或 b。');
  }
}

async function chooseSong(rl, api, songs, context) {
  printSearchResults(songs);
  const choice = (await ask(rl, '选择序号（直接回车返回搜索）：', context.signal)).trim();
  if (!choice) return;
  const index = Number(choice) - 1;
  if (!Number.isInteger(index) || !songs[index]) {
    console.log('无效序号。');
    return;
  }
  const detail = await api.songDetail(songs[index].id, { signal: context.signal });
  await songMenu(rl, api, detail, context);
}

async function resolveInput(rl, api, raw, context) {
  const { authState, signal, logger } = context;
  const login = parseLoginCommand(raw);
  if (login) {
    if (login.action === 'status') {
      await refreshAuthState(api, authState, signal, logger);
      printLoginStatus(authState);
    } else if (login.action === 'cookie') {
      await useProvidedCookie(api, authState, login.cookie, signal, logger);
    } else {
      await handleLogin(api, authState, signal, logger);
    }
    return;
  }
  const directLyric = raw.match(/^\/lyric\s+(\d+)(?:\s*(?:>|\|)\s*(.+))?$/i);
  if (directLyric) {
    const song = await api.songDetail(directLyric[1], { signal });
    await showSong(song, signal);
    await lyricMenu(rl, api, song, { outputFile: directLyric[2]?.trim() || null, signal });
    return;
  }
  const id = parseIdCommand(raw);
  if (id) {
    await songMenu(rl, api, await api.songDetail(id, { signal }), context);
    return;
  }
  if (/^\/help$/i.test(raw)) {
    printHelp();
    return;
  }
  const lyricSearch = raw.match(/^(?:\/lyrics\s+|歌词\s*[:：]\s*)(.+)$/i);
  if (lyricSearch) {
    const songs = await api.searchLyrics(lyricSearch[1], 10, { signal });
    if (!songs.length) {
      console.log('没有找到歌词命中结果。');
      return;
    }
    printSearchResults(songs);
    songs.forEach((song, index) => {
      if (song.lyricMatches?.length) console.log(chalk.gray(`    ${index + 1}: ${song.lyricMatches.slice(0, 2).join(' / ')}`));
    });
    await chooseSong(rl, api, songs, context);
    return;
  }
  const songs = await api.search(raw, 10, { signal });
  if (!songs.length) {
    console.log('没有找到歌曲。');
    return;
  }
  await chooseSong(rl, api, songs, context);
}

export async function main(args = []) {
  const logger = new Logger();
  const controller = new AbortController();
  let rl = null;
  let shuttingDown = false;
  const shutdown = (source = 'signal') => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = 130;
    void logger.info('shutdown', { source });
    controller.abort(new DOMException('用户中断', 'AbortError'));
    rl?.close();
  };
  const onSigint = () => shutdown('SIGINT');
  const onSigterm = () => shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    const cookie = await loadCookie();
    const api = new NcmApi({ cookie, logger });
    void logger.info('startup', { cookiePresent: Boolean(cookie) });

    if (/^(?:lyric|lyrics)$/i.test(args[0] || '') && /^\d+$/.test(args[1] || '')) {
      const lyrics = await api.lyrics(args[1], { signal: controller.signal });
      process.stdout.write(`${plainLyrics(lyrics.original)}\n`);
      return;
    }

    rl = createInterface({ input, output });
    rl.on('SIGINT', onSigint);
    const authState = { loggedIn: false, verified: false, nickname: null };
    await refreshAuthState(api, authState, controller.signal, logger);

    console.log(chalk.bold.cyan('NCM CLI 点歌台'));
    console.log(`API：${api.baseUrl}`);
    printLoginStatus(authState);
    console.log(`日志：${logger.file}`);
    console.log('输入 /help 查看命令。');

    const context = { authState, signal: controller.signal, logger };
    if (args.length) await resolveInput(rl, api, args.join(' '), context);
    while (!controller.signal.aborted) {
      const prompt = authState.loggedIn
        ? '\n搜索歌曲、输入 ID 点歌 > '
        : '\n搜索歌曲、输入 ID 点歌，或 /login > ';
      let raw;
      try {
        raw = (await ask(rl, chalk.green(prompt), controller.signal)).trim();
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) break;
        throw error;
      }
      if (!raw) continue;
      if (/^\/(?:quit|exit)$/i.test(raw)) break;
      try {
        await resolveInput(rl, api, raw, context);
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) break;
        void logger.error('operation_failed', { error });
        console.error(chalk.red(`操作失败：${error.message}`));
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    rl?.removeListener('SIGINT', onSigint);
    rl?.close();
    await logger.flush();
  }
}
