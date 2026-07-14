import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { NcmApi } from './api.js';
import { configFilePath, loadCookie, saveCookie } from './cookie-store.js';
import { plainLyrics } from './lyrics.js';
import { playWithProgress, tryRenderImage } from './media.js';
import { normalizeCookie, parseIdCommand, parseLoginCommand, parseLyricAction } from './parsers.js';

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
  /lyrics <关键词>    按歌词内容搜索（也支持“歌词:关键词”）
  /help               显示帮助
  /quit               退出

选中歌曲后：p 播放，l/歌词 获取歌词，u 获取播放链接，b 返回。
歌词可用 ${chalk.cyan('l > 文件名.txt')} 或 ${chalk.cyan('歌词 | 文件名.txt')} 写入文件。
`);
}

function printSearchResults(songs) {
  console.log();
  songs.forEach((song, index) => {
    console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${chalk.bold(song.name)} — ${song.artists.join('/')}  ${chalk.gray(`[${song.id}] ${formatDuration(song.durationMs)}`)}`);
  });
}

async function showSong(song) {
  console.log(`\n${chalk.bold.green(song.name)}`);
  console.log(`歌手：${song.artists.join('/') || '未知'}\n专辑：${song.album}\nID：${song.id}\n时长：${formatDuration(song.durationMs)}`);
  if (song.cover) {
    const rendered = await tryRenderImage(song.cover);
    if (!rendered) console.log(`封面：${song.cover}`);
  }
}

async function handleLogin(api) {
  const key = await api.qrKey();
  const qr = await api.qrCreate(key);
  console.log(`\n登录链接：${qr.qrurl}`);
  let qrRendered = false;
  try {
    if (!process.stdout.isTTY) throw new Error('非交互终端');
    qrcode.generate(qr.qrurl, { small: true }, (code) => console.log(code));
    qrRendered = true;
  } catch {}
  if (!qrRendered && qr.qrimg) qrRendered = await tryRenderImage(qr.qrimg);
  if (!qrRendered) console.log('当前终端无法绘制二维码，请打开上方登录链接。');
  console.log('请使用网易云音乐 App 扫码并确认（等待最多 3 分钟）…');

  const deadline = Date.now() + 180000;
  let lastCode;
  while (Date.now() < deadline) {
    const status = await api.qrCheck(key);
    if (status.code !== lastCode) {
      if (status.code === 802) console.log('已扫码，请在手机上确认。');
      lastCode = status.code;
    }
    if (status.code === 803 && status.cookie) {
      const cookie = normalizeCookie(status.cookie);
      api.setCookie(cookie);
      const file = await saveCookie(cookie);
      console.log(`登录成功，Cookie 已缓存：${file}`);
      return;
    }
    if (status.code === 800) throw new Error('二维码已过期，请重新执行 /login');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('登录等待超时，请重新执行 /login');
}

async function useProvidedCookie(api, raw) {
  const cookie = normalizeCookie(raw);
  api.setCookie(cookie);
  const file = await saveCookie(cookie);
  let identity = '';
  try {
    const profile = await api.loginStatus();
    identity = profile?.nickname ? `，当前账号：${profile.nickname}` : '（服务未返回账号资料）';
  } catch {
    identity = '（账号状态暂时无法验证，Cookie 仍已保存）';
  }
  console.log(`Cookie 已缓存到 ${file}${identity}`);
}

async function writeLyrics(target, content) {
  const file = path.resolve(process.cwd(), target.replace(/^['"]|['"]$/g, ''));
  await writeFile(file, `${content}\n`, { encoding: 'utf8', flag: 'wx' });
  console.log(`歌词已写入：${file}`);
}

async function songMenu(rl, api, song) {
  await showSong(song);
  let cachedLyrics = null;
  let cachedUrl = null;
  while (true) {
    const action = (await rl.question(chalk.yellow('\n[p]播放 [l]歌词 [u]播放链接 [b]返回 > '))).trim();
    if (/^(?:b|back|返回)$/i.test(action)) return;
    const lyricAction = parseLyricAction(action);
    if (lyricAction) {
      cachedLyrics ||= await api.lyrics(song.id);
      const text = plainLyrics(cachedLyrics.original) || '暂无歌词';
      if (lyricAction.output) await writeLyrics(lyricAction.output, text);
      else console.log(`\n${text}`);
      continue;
    }
    if (/^(?:u|url|链接)$/i.test(action)) {
      cachedUrl ||= await api.songUrl(song.id);
      console.log(cachedUrl?.url || '暂无可用播放链接。请先登录；也可能受版权、地区或会员权限限制。');
      continue;
    }
    if (/^(?:p|play|播放)$/i.test(action)) {
      cachedUrl ||= await api.songUrl(song.id);
      if (!cachedUrl?.url) {
        console.log('无法播放：API 未返回可用 URL。请先登录；也可能受版权、地区或会员权限限制。');
        continue;
      }
      cachedLyrics ||= await api.lyrics(song.id);
      console.log(`使用本机播放器播放：${song.name}`);
      await playWithProgress({ url: cachedUrl.url, durationMs: song.durationMs, lyricSource: cachedLyrics.original });
      continue;
    }
    console.log('未知选项，请输入 p、l、u 或 b。');
  }
}

async function resolveInput(rl, api, raw) {
  const login = parseLoginCommand(raw);
  if (login) {
    if (login.cookie) await useProvidedCookie(api, login.cookie);
    else await handleLogin(api);
    return;
  }
  const id = parseIdCommand(raw);
  if (id) {
    await songMenu(rl, api, await api.songDetail(id));
    return;
  }
  if (/^\/help$/i.test(raw)) {
    printHelp();
    return;
  }
  const lyricSearch = raw.match(/^(?:\/lyrics\s+|歌词\s*[:：]\s*)(.+)$/i);
  if (lyricSearch) {
    const songs = await api.searchLyrics(lyricSearch[1]);
    if (!songs.length) {
      console.log('没有找到歌词命中结果。');
      return;
    }
    printSearchResults(songs);
    songs.forEach((song, index) => {
      if (song.lyricMatches?.length) console.log(chalk.gray(`    ${index + 1}: ${song.lyricMatches.slice(0, 2).join(' / ')}`));
    });
    const choice = (await rl.question('选择序号（直接回车返回搜索）：')).trim();
    if (!choice) return;
    const song = songs[Number(choice) - 1];
    if (!song) {
      console.log('无效序号。');
      return;
    }
    await songMenu(rl, api, await api.songDetail(song.id));
    return;
  }
  const songs = await api.search(raw);
  if (!songs.length) {
    console.log('没有找到歌曲。');
    return;
  }
  printSearchResults(songs);
  const choice = (await rl.question('选择序号（直接回车返回搜索）：')).trim();
  if (!choice) return;
  const index = Number(choice) - 1;
  if (!Number.isInteger(index) || !songs[index]) {
    console.log('无效序号。');
    return;
  }
  const detail = await api.songDetail(songs[index].id);
  await songMenu(rl, api, detail);
}

export async function main(args = []) {
  const cookie = await loadCookie();
  const api = new NcmApi({ cookie });
  if (/^(?:lyric|lyrics)$/i.test(args[0] || '') && /^\d+$/.test(args[1] || '')) {
    const lyrics = await api.lyrics(args[1]);
    process.stdout.write(`${plainLyrics(lyrics.original)}\n`);
    return;
  }
  const rl = createInterface({ input, output });
  console.log(chalk.bold.cyan('NCM CLI 点歌台'));
  console.log(`API：${api.baseUrl}`);
  console.log(cookie ? `已加载缓存 Cookie：${configFilePath()}` : '当前未登录；可输入 /login。');
  console.log('输入 /help 查看命令。');

  try {
    if (args.length) await resolveInput(rl, api, args.join(' '));
    while (true) {
      const raw = (await rl.question(chalk.green('\n搜索歌曲、输入 ID 点歌，或 /login > '))).trim();
      if (!raw) continue;
      if (/^\/(?:quit|exit)$/i.test(raw)) break;
      try {
        await resolveInput(rl, api, raw);
      } catch (error) {
        console.error(chalk.red(`操作失败：${error.message}`));
      }
    }
  } finally {
    rl.close();
  }
}
