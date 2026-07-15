import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { NcmApi } from './api.js';
import { clearCookie, loadCookie, saveCookie } from './cookie-store.js';
import { mergeTranslatedLrc, plainLyrics } from './lyrics.js';
import { Logger } from './logger.js';
import { playWithProgress, tryRenderImage } from './media.js';
import {
  loadSettings, saveSettings, MIN_LYRIC_OFFSET_MS, MAX_LYRIC_OFFSET_MS
} from './settings-store.js';
import {
  normalizeCookie, parseIdCommand, parseLoginCommand, parseLyricAction,
  parseLyricDirectCommand, parseLyricFormatSelection, parseLyricSearchCommand,
  parseNumberSelection, parseOffsetCommand, parseQualityCommand, parseSignoutCommand, parseClearCommand,
  parseListPlaylistsCommand, parsePlaylistCommand,
  QUALITY_LEVELS
} from './parsers.js';

const QUALITY_LABELS = Object.freeze({
  standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res',
  jyeffect: '高清环绕声', sky: '沉浸环绕声', dolby: '杜比全景声', jymaster: '超清母带'
});

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
  关键词                                  搜索歌曲
  /id <id>                                按 ID 点歌（兼容 id:、ID=、id 空格等写法）
  /idlyric <id> [plain|lrc|trans|all]     按歌曲 ID 直接输出歌词，默认 plain
  /lyric <内容> [plain|lrc|trans|all]     按歌词内容搜索
  /lspl                                   列出当前用户的歌单
  /pl <id>                                预览歌单
  /login                                  扫码登录
  /login <cookie>                         保存并使用已有 Cookie
  /login status                           查看服务端验证的登录状态
  /signout                                退出登录并清除本地 Cookie
  /quality                                查看并选择播放音质
  /quality <level>                        直接设置播放音质
  /offset                                 查看并设置播放时间偏移
  /offset <毫秒>                          直接设置播放时间偏移（默认 2000）
  /clear                                  清空终端并返回搜索
  /help                                   显示帮助
  /quit                                   退出程序

歌词命令、搜索结果和格式选项均支持 ${chalk.cyan('> 文件名.lrc')} 或 ${chalk.cyan('| 文件名.lrc')}。
音质 level：${QUALITY_LEVELS.join('、')}。
歌曲详情：p 播放，l 歌词，u 播放链接，q 返回。
播放页：q 停止返回，空格暂停/继续，←/→ 后退/前进 5 秒，↑/↓ 调整音量，t 开关翻译。
歌单播放：p 打开/关闭播放列表，Ctrl+←/→ 切换歌曲；列表中 ↑/↓ 选择、Enter 播放。
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
  console.log();
  if (song.cover) await tryRenderImage(song.cover, { signal, size: 'detail' });
  console.log(chalk.bold.green(song.name));
  console.log(`歌手：${song.artists.join('/') || '未知'}\n专辑：${song.album}\nID：${song.id}\n时长：${formatDuration(song.durationMs)}`);
}

async function refreshAuthState(api, authState, signal, logger) {
  if (!api.cookie) {
    Object.assign(authState, { loggedIn: false, verified: true, account: null, profile: null, level: null });
    return authState;
  }
  try {
    const status = await api.loginStatus({ signal, timeoutMs: 8000 });
    Object.assign(authState, {
      loggedIn: status.loggedIn,
      verified: true,
      account: status.account,
      profile: status.profile,
      level: null
    });
    if (status.loggedIn) {
      try {
        authState.level = await api.userLevel({ signal, timeoutMs: 8000 });
      } catch (error) {
        if (isAbortError(error)) throw error;
        void logger.warn('user_level_failed', { error });
      }
    }
    void logger.info('login_status', { loggedIn: authState.loggedIn });
  } catch (error) {
    if (isAbortError(error)) throw error;
    Object.assign(authState, { loggedIn: false, verified: false, account: null, profile: null, level: null });
    void logger.warn('login_status_failed', { error });
  }
  return authState;
}

function printLoginStatus(authState, { detailed = false } = {}) {
  const { account, profile, level } = authState;
  if (authState.loggedIn) {
    console.log(`已登录${profile?.nickname ? `：${profile.nickname}` : ''}`);
    if (!detailed) return;
    const vipType = profile?.vipType ?? account?.vipType;
    const fields = [
      ['昵称', profile?.nickname],
      ['用户 ID', profile?.userId],
      ['账号 ID', account?.id],
      ['等级', level?.level == null ? null : `Lv.${level.level}`],
      ['会员', vipType == null ? null : (Number(vipType) === 0 ? '非会员' : `类型 ${vipType}`)],
      ['累计听歌', level?.listenSongs],
      ['关注', profile?.follows],
      ['粉丝', profile?.followeds],
      ['歌单', profile?.playlistCount]
    ];
    for (const [label, value] of fields) {
      if (value !== null && value !== undefined && value !== '') console.log(`${label}：${value}`);
    }
  }
  else if (!authState.verified) console.log('存在缓存 Cookie，但暂时无法向服务端验证登录状态。');
  else console.log('未登录，或缓存 Cookie 已失效。');
}

async function handleSignout(api, authState, signal, logger) {
  let remoteError = null;
  let removed = false;
  try {
    if (api.cookie) {
      try {
        await api.logout({ signal, timeoutMs: 8000 });
      } catch (error) {
        remoteError = error;
        void logger.warn('logout_api_failed', { error });
      }
    }
  } finally {
    api.setCookie(null);
    Object.assign(authState, { loggedIn: false, verified: true, account: null, profile: null, level: null });
    removed = await clearCookie();
  }
  void logger.info('signout', { cacheRemoved: removed, remoteSucceeded: !remoteError });
  if (remoteError) console.log('服务端登出请求失败，但本地 Cookie 已清除。');
  else console.log(removed ? '已退出登录并清除本地 Cookie。' : '当前未保存登录信息。');
}

async function setQuality(api, settings, level, logger) {
  if (!QUALITY_LEVELS.includes(level)) {
    console.log(`不支持的音质等级：${level}\n可用值：${QUALITY_LEVELS.join('、')}`);
    return false;
  }
  await saveSettings({ ...settings, quality: level });
  settings.quality = level;
  api.setQuality(level);
  void logger.info('quality_changed', { quality: level });
  console.log(`播放音质已设置为：${QUALITY_LABELS[level]}（${level}）`);
  return true;
}

async function handleQuality(rl, api, settings, command, signal, logger) {
  if (command.level) {
    await setQuality(api, settings, command.level, logger);
    return;
  }
  console.log(`当前播放音质：${QUALITY_LABELS[api.quality] || api.quality}（${api.quality}）`);
  QUALITY_LEVELS.forEach((level, index) => {
    console.log(`${String(index + 1).padStart(2)}. ${QUALITY_LABELS[level]}（${level}）`);
  });
  while (true) {
    const raw = (await ask(rl, '选择序号或 level，q 返回：', signal)).trim().toLowerCase();
    if (/^q$/i.test(raw)) return;
    const level = /^\d+$/.test(raw) ? QUALITY_LEVELS[Number(raw) - 1] : raw;
    if (level && await setQuality(api, settings, level, logger)) return;
  }
}

async function setLyricOffset(settings, milliseconds, logger) {
  if (!Number.isInteger(milliseconds)
      || milliseconds < MIN_LYRIC_OFFSET_MS || milliseconds > MAX_LYRIC_OFFSET_MS) {
    console.log(`播放时间偏移量必须是 ${MIN_LYRIC_OFFSET_MS} 到 ${MAX_LYRIC_OFFSET_MS} 之间的整数毫秒。`);
    return false;
  }
  await saveSettings({ ...settings, lyricOffsetMs: milliseconds });
  settings.lyricOffsetMs = milliseconds;
  void logger.info('lyric_offset_changed', { lyricOffsetMs: milliseconds });
  console.log(`播放时间偏移已设置为：${milliseconds} 毫秒`);
  return true;
}

async function handleOffset(rl, settings, command, signal, logger) {
  if (command.error) {
    console.log(`${command.error}；允许范围为 ${MIN_LYRIC_OFFSET_MS} 到 ${MAX_LYRIC_OFFSET_MS}。`);
    return;
  }
  if (command.milliseconds !== null) {
    await setLyricOffset(settings, command.milliseconds, logger);
    return;
  }
  console.log(`当前播放时间偏移：${settings.lyricOffsetMs} 毫秒`);
  while (true) {
    const raw = (await ask(
      rl,
      `输入偏移毫秒（${MIN_LYRIC_OFFSET_MS} 到 ${MAX_LYRIC_OFFSET_MS}，q 返回）：`,
      signal
    )).trim();
    if (/^q$/i.test(raw)) return;
    if (/^[+-]?\d+$/.test(raw) && await setLyricOffset(settings, Number(raw), logger)) return;
    if (!/^[+-]?\d+$/.test(raw)) console.log('播放时间偏移量必须是整数毫秒。');
  }
}

async function handleLogin(rl, api, authState, signal, logger) {
  const key = await api.qrKey({ signal });
  const qr = await api.qrCreate(key, { signal });
  console.log(`\n登录链接：${qr.qrurl}`);
  let qrRendered = false;
  try {
    if (!process.stdout.isTTY) throw new Error('非交互终端');
    qrcode.generate(qr.qrurl, { small: true }, (code) => console.log(code));
    qrRendered = true;
  } catch {}
  if (!qrRendered && qr.qrimg) qrRendered = Boolean(await tryRenderImage(qr.qrimg, { signal }));
  if (!qrRendered) console.log('当前终端无法绘制二维码，请打开上方登录链接。');
  console.log('请使用网易云音乐 App 扫码并确认（等待最多 3 分钟；输入 q 回车返回）…');

  const deadline = Date.now() + 180000;
  let lastCode;
  const loginController = new AbortController();
  const questionController = new AbortController();
  const loginSignal = AbortSignal.any([signal, loginController.signal]);
  const questionSignal = AbortSignal.any([signal, questionController.signal]);
  let quitRequested = false;
  const waitForQuit = (async () => {
    while (!questionSignal.aborted) {
      const value = (await ask(rl, '', questionSignal)).trim();
      if (/^q$/i.test(value)) {
        quitRequested = true;
        loginController.abort(new DOMException('返回搜索', 'AbortError'));
        return true;
      }
    }
    return false;
  })().catch((error) => {
    if (isAbortError(error)) return false;
    throw error;
  });

  try {
    while (Date.now() < deadline) {
      const status = await api.qrCheck(key, { signal: loginSignal });
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
      await Promise.race([delay(2000, loginSignal), waitForQuit]);
    }
    throw new Error('登录等待超时，请重新执行 /login');
  } catch (error) {
    if (quitRequested) {
      console.log('已取消登录。');
      return;
    }
    throw error;
  } finally {
    questionController.abort();
    await waitForQuit;
  }
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

async function writePlaylist(target, content) {
  const file = path.resolve(process.cwd(), target.replace(/^['"]|['"]$/g, ''));
  try {
    await writeFile(file, `${content}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`目标文件已存在，未覆盖：${file}`);
    throw error;
  }
  console.log(`歌单列表已写入：${file}`);
}

function mergeOutputTargets(existing, selected) {
  if (existing && selected) throw new Error('本次操作已经指定输出文件，请勿重复指定');
  return selected || existing || null;
}

function lyricContent(lyrics, format) {
  if (format === 'plain') return plainLyrics(lyrics.original);
  if (format === 'lrc') return lyrics.original;
  if (format === 'trans') return lyrics.translated;
  if (format === 'all') return mergeTranslatedLrc(lyrics.original, lyrics.translated) || lyrics.original;
  throw new Error(`未知歌词格式：${format}`);
}

async function outputLyrics(api, song, format, outputFile, signal) {
  const lyrics = await api.lyrics(song.id, { signal });
  const content = lyricContent(lyrics, format);
  if (!content) {
    console.log(format === 'trans' ? '暂无翻译歌词。' : '暂无对应歌词。');
    return false;
  }
  if (outputFile) await writeLyrics(outputFile, content);
  else console.log(`\n${content}`);
  return true;
}

async function lyricFormatMenu(rl, api, song, { outputFile = null, signal } = {}) {
  console.log(`
歌词格式：
  1. 纯歌词（plain）
  2. 原始 LRC（lrc）
  3. 翻译 LRC（trans）
  4. 原文 + 翻译（all）
  q. 返回`);
  while (true) {
    const raw = (await ask(rl, '选择格式，可追加 > 文件 或 | 文件：', signal)).trim();
    const selection = parseLyricFormatSelection(raw);
    if (!selection) {
      console.log('无效格式，请输入 1-4、plain/lrc/trans/all 或 q。');
      continue;
    }
    if (selection.quit) return false;
    let target;
    try {
      target = mergeOutputTargets(outputFile, selection.output);
    } catch (error) {
      console.log(error.message);
      continue;
    }
    return outputLyrics(api, song, selection.format, target, signal);
  }
}

function unavailableUrlMessage(result, authState) {
  const code = result?.code ?? result?.attempts?.at(-1)?.code ?? '未知';
  const auth = authState.loggedIn ? '已登录' : authState.verified ? '未登录' : '登录状态未验证';
  return `无法播放：API 返回歌曲状态 code=${code}，未提供 URL（当前${auth}）。可能受会员、版权或地区限制。`;
}

async function songMenu(rl, api, song, context) {
  const { signal, logger, authState, shutdown } = context;
  await showSong(song, signal);
  let cachedLyrics = null;
  while (true) {
    const action = (await ask(rl, chalk.yellow('\n[p]播放 [l]歌词 [u]播放链接 [q]返回 > '), signal)).trim();
    if (/^(?:q|b|back|返回)$/i.test(action)) return;
    const lyricAction = parseLyricAction(action);
    if (lyricAction) {
      await lyricFormatMenu(rl, api, song, { outputFile: lyricAction.output, signal });
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
      await playWithProgress({
        song,
        url: result.url,
        durationMs: song.durationMs,
        lyricSource: cachedLyrics.original,
        translatedLyricSource: cachedLyrics.translated,
        lyricOffsetMs: context.settings.lyricOffsetMs,
        signal,
        logger,
        rl,
        onInterrupt: () => shutdown('playback_ctrl_c')
      });
      continue;
    }
    console.log('未知选项，请输入 p、l、u 或 q。');
  }
}

function playlistCreatorName(playlist) {
  return playlist.creatorName || playlist.creator?.nickname || playlist.creator?.name || '未知';
}

function formatCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count)) return '未知';
  if (count >= 100000000) return `${(count / 100000000).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (count >= 10000) return `${(count / 10000).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(count);
}

function playlistLink(id) {
  return `https://music.163.com/#/playlist?id=${id}`;
}

function playlistExportText(playlist, tracks) {
  const header = [
    `歌单：${playlist.name}`,
    `创建者：${playlistCreatorName(playlist)}`,
    `ID：${playlist.id}`,
    `链接：${playlistLink(playlist.id)}`,
    ''
  ];
  const rows = tracks.map((song, index) => [
    `${index + 1}. ${song.name}`,
    song.artists?.join('/') || '未知歌手',
    song.album || '未知专辑',
    `ID:${song.id}`
  ].join('\t'));
  return [...header, ...rows].join('\n');
}

function parsePlaylistExportAction(raw) {
  const match = raw.match(/^(?:e|export|导出)(?:\s*(?:>|\|)\s*(.+))?$/i);
  if (!match) return null;
  return { output: match[1]?.trim() || null };
}

async function playPlaylist(api, playlist, tracks, startIndex, context) {
  if (!tracks.length) {
    console.log('歌单中没有可播放的歌曲。');
    return;
  }
  let currentIndex = Math.min(Math.max(0, startIndex), tracks.length - 1);
  let unavailableCount = 0;
  while (currentIndex >= 0 && currentIndex < tracks.length) {
    const song = tracks[currentIndex];
    const result = await api.songUrl(song.id, { signal: context.signal });
    if (!result?.url) {
      unavailableCount += 1;
      console.log(`跳过无法播放的歌曲：${song.name}（${currentIndex + 1}/${tracks.length}）`);
      currentIndex += 1;
      continue;
    }

    let lyrics = { original: '', translated: '' };
    try {
      lyrics = await api.lyrics(song.id, { signal: context.signal });
    } catch (error) {
      if (isAbortError(error)) throw error;
      void context.logger.warn('playlist_lyrics_failed', { songId: song.id, error });
    }
    const playback = await playWithProgress({
      song,
      url: result.url,
      durationMs: song.durationMs,
      lyricSource: lyrics.original,
      translatedLyricSource: lyrics.translated,
      lyricOffsetMs: context.settings.lyricOffsetMs,
      playlist: { name: playlist.name, tracks, currentIndex },
      signal: context.signal,
      logger: context.logger,
      rl: context.rl,
      onInterrupt: () => context.shutdown('playback_ctrl_c')
    });

    if (playback === 'quit' || playback === 'stopped' || playback === 'smtc_stop'
        || playback?.type === 'playlist_quit') return;
    if (playback?.type === 'playlist_previous') currentIndex = Math.max(0, currentIndex - 1);
    else if (playback?.type === 'playlist_next') currentIndex += 1;
    else if (playback?.type === 'playlist_select' && Number.isInteger(playback.index)) {
      currentIndex = Math.min(Math.max(0, playback.index), tracks.length - 1);
    } else {
      currentIndex += 1;
    }
  }
  if (unavailableCount === tracks.length) console.log('歌单中没有可用的播放链接，可能受会员、版权或地区限制。');
  else console.log('歌单播放完毕。');
}

async function playlistMenu(rl, api, id, context) {
  const playlist = await api.playlistDetail(id, { signal: context.signal });
  const previewTracks = playlist.tracks || [];
  let fullTracks = null;
  const loadFullTracks = async () => {
    fullTracks ||= await api.playlistTracks(id, { signal: context.signal });
    return fullTracks;
  };
  console.log();
  const cover = playlist.cover || playlist.coverImgUrl;
  if (cover) await tryRenderImage(cover, { signal: context.signal, size: 'detail' });
  console.log(chalk.bold.green(playlist.name || `歌单 ${id}`));
  console.log(`创建者：${playlistCreatorName(playlist)}`);
  console.log(`歌曲数：${playlist.trackCount ?? previewTracks.length}`);
  console.log(`播放量：${formatCount(playlist.playCount)}`);
  console.log(`ID：${playlist.id || id}`);
  if (playlist.description) console.log(`描述：${String(playlist.description).replace(/\s+/g, ' ').trim()}`);
  console.log(chalk.bold('\n歌曲预览'));
  previewTracks.slice(0, 15).forEach((song, index) => {
    console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${song.name} — ${song.artists?.join('/') || '未知歌手'} ${chalk.gray(`[${song.id}]`)}`);
  });
  const remaining = Math.max(0, (playlist.trackCount ?? previewTracks.length) - 15);
  if (remaining) console.log(chalk.gray(`……另有 ${remaining} 首`));

  while (true) {
    const raw = (await ask(
      rl,
      chalk.yellow('\n[p]播放 [e]导出列表 [u]歌单链接 [q]返回 > '),
      context.signal
    )).trim();
    if (/^(?:q|b|back|返回)$/i.test(raw)) return;
    if (/^(?:u|url|链接)$/i.test(raw)) {
      console.log(playlistLink(playlist.id || id));
      continue;
    }
    if (/^(?:p|play|播放)$/i.test(raw)) {
      const tracks = await loadFullTracks();
      await playPlaylist(api, playlist, tracks, 0, { ...context, rl });
      continue;
    }
    const exportAction = parsePlaylistExportAction(raw);
    if (exportAction) {
      let target = exportAction.output;
      if (!target) {
        console.log('支持 e > 文件 或 e | 文件；已有文件不会被覆盖。');
        const entered = (await ask(rl, '输出文件（q 返回） > ', context.signal)).trim();
        if (/^q$/i.test(entered)) continue;
        target = entered.replace(/^(?:>|\|)\s*/, '').trim();
      }
      if (!target) {
        console.log('请指定输出文件。');
        continue;
      }
      const tracks = await loadFullTracks();
      await writePlaylist(target, playlistExportText(playlist, tracks));
      continue;
    }
    console.log('未知选项，请输入 p、e、u 或 q。');
  }
}

async function listUserPlaylists(rl, api, context) {
  if (!context.authState.loggedIn) {
    console.log('此命令需要登录，请先使用 /login。');
    return;
  }
  const uid = context.authState.profile?.userId || context.authState.account?.id;
  if (!uid) {
    console.log('无法取得当前用户 ID，请执行 /login status 后重试。');
    return;
  }
  const playlists = await api.userPlaylists(uid, { signal: context.signal });
  if (!playlists.length) {
    console.log('当前账号没有歌单。');
    return;
  }
  while (true) {
    console.log(chalk.bold('\n我的歌单'));
    playlists.forEach((playlist, index) => {
      console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${playlist.name} ${chalk.gray(`[${playlist.id}] ${playlist.trackCount ?? 0} 首`)}`);
    });
    const raw = (await ask(rl, '选择序号预览歌单，q 返回搜索：', context.signal)).trim();
    if (/^q$/i.test(raw)) return;
    const selection = parseNumberSelection(raw);
    if (!selection || selection.quit || selection.output || !playlists[selection.index]) {
      console.log('无效序号。');
      continue;
    }
    await playlistMenu(rl, api, playlists[selection.index].id, context);
  }
}

async function chooseSong(rl, api, songs, context) {
  while (true) {
    printSearchResults(songs);
    const raw = (await ask(rl, '选择序号，q 返回搜索：', context.signal)).trim();
    const selection = parseNumberSelection(raw);
    if (!selection) {
      console.log('无效序号。');
      continue;
    }
    if (selection.quit) return;
    if (selection.output) {
      console.log('普通歌曲搜索不使用输出文件；歌词搜索请使用 /lyric。');
      continue;
    }
    const song = songs[selection.index];
    if (!song) {
      console.log('无效序号。');
      continue;
    }
    const detail = await api.songDetail(song.id, { signal: context.signal });
    await songMenu(rl, api, detail, context);
  }
}

async function lyricSearchFlow(rl, api, command, context) {
  const songs = await api.searchLyrics(command.query, 10, { signal: context.signal });
  if (!songs.length) {
    console.log('没有找到歌词命中结果。');
    return;
  }
  while (true) {
    printSearchResults(songs);
    songs.forEach((song, index) => {
      if (song.lyricMatches?.length) console.log(chalk.gray(`    ${index + 1}: ${song.lyricMatches.slice(0, 2).join(' / ')}`));
    });
    const raw = (await ask(rl, '选择序号（可追加 > 文件 或 | 文件），q 返回搜索：', context.signal)).trim();
    const selection = parseNumberSelection(raw);
    if (!selection) {
      console.log('无效序号。');
      continue;
    }
    if (selection.quit) return;
    const song = songs[selection.index];
    if (!song) {
      console.log('无效序号。');
      continue;
    }
    let target;
    try {
      target = mergeOutputTargets(command.output, selection.output);
    } catch (error) {
      console.log(error.message);
      continue;
    }
    const detail = await api.songDetail(song.id, { signal: context.signal });
    if (command.format) await outputLyrics(api, detail, command.format, target, context.signal);
    else await lyricFormatMenu(rl, api, detail, { outputFile: target, signal: context.signal });
  }
}

async function resolveInput(rl, api, raw, context) {
  const { authState, signal, logger } = context;
  if (parseClearCommand(raw)) {
    output.write('\x1b[2J\x1b[H');
    return;
  }
  const offset = parseOffsetCommand(raw);
  if (offset) {
    await handleOffset(rl, context.settings, offset, signal, logger);
    return;
  }
  const quality = parseQualityCommand(raw);
  if (quality) {
    await handleQuality(rl, api, context.settings, quality, signal, logger);
    return;
  }
  if (parseSignoutCommand(raw)) {
    await handleSignout(api, authState, signal, logger);
    return;
  }
  const login = parseLoginCommand(raw);
  if (login) {
    if (login.action === 'status') {
      await refreshAuthState(api, authState, signal, logger);
      printLoginStatus(authState, { detailed: true });
    } else if (login.action === 'cookie') await useProvidedCookie(api, authState, login.cookie, signal, logger);
    else await handleLogin(rl, api, authState, signal, logger);
    return;
  }

  if (parseListPlaylistsCommand(raw)) {
    await listUserPlaylists(rl, api, context);
    return;
  }
  const playlist = parsePlaylistCommand(raw);
  if (playlist) {
    await playlistMenu(rl, api, playlist, context);
    return;
  }

  const directLyric = parseLyricDirectCommand(raw);
  if (directLyric) {
    const song = await api.songDetail(directLyric.id, { signal });
    await outputLyrics(api, song, directLyric.format, directLyric.output, signal);
    return;
  }

  const lyricSearch = parseLyricSearchCommand(raw)
    || (raw.match(/^歌词\s*[:：]\s*(.+)$/i) ? { query: raw.match(/^歌词\s*[:：]\s*(.+)$/i)[1], format: null, output: null } : null);
  if (lyricSearch) {
    await lyricSearchFlow(rl, api, lyricSearch, context);
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
    const settings = await loadSettings();
    const api = new NcmApi({ cookie, logger, quality: settings.quality });
    void logger.info('startup', {
      cookiePresent: Boolean(cookie), quality: settings.quality, lyricOffsetMs: settings.lyricOffsetMs
    });

    if (/^idlyric$/i.test(args[0] || '') && /^\d+$/.test(args[1] || '')) {
      const lyrics = await api.lyrics(args[1], { signal: controller.signal });
      process.stdout.write(`${plainLyrics(lyrics.original)}\n`);
      return;
    }

    rl = createInterface({ input, output });
    rl.on('SIGINT', onSigint);
    const authState = { loggedIn: false, verified: false, account: null, profile: null, level: null };
    await refreshAuthState(api, authState, controller.signal, logger);

    console.log(chalk.bold.cyan('NCM CLI 点歌台'));
    console.log(`API：${api.baseUrl}`);
    printLoginStatus(authState);
    console.log(`日志：${logger.file}`);
    console.log('输入 /help 查看命令。');

    const context = { authState, signal: controller.signal, logger, settings, shutdown };
    if (args.length) await resolveInput(rl, api, args.join(' '), context);
    while (!controller.signal.aborted) {
      const prompt = authState.loggedIn ? '\n搜索歌曲、输入 ID 点歌 > ' : '\n搜索歌曲、输入 ID 点歌，或 /login > ';
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
