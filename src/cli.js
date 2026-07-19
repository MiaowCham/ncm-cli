import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import { commandCompleter } from './completion.js';
import { NcmApi, normalizeApiBaseUrl } from './api.js';
import { clearCookie, loadCookie, saveCookie } from './cookie-store.js';
import { mergeTranslatedLrc, plainLyrics } from './lyrics.js';
import { Logger } from './logger.js';
import { closeRetainedSmtc, findPlayer, playerBackendLabel, playerCommandsForBackend, playWithProgress, tryRenderImage } from './media.js';
import { parsePlaylistExportFormatSelection, playlistExportContent } from './playlist-export.js';
import { readTerminalKey, selectTerminalList } from './terminal-list.js';
import { acquireTerminalScreen } from './terminal-screen.js';
import { secondaryText } from './terminal-theme.js';
import { resolveNeteaseMusicInput } from './music-link.js';
import { chooseLyricSource } from './lyrics.js';
import { writeExport } from './output-file.js';
import { cleanupStalePlayerSessions } from './player-registry.js';
import {
  createImageRenderPerformance, loadImageRenderProfile, saveImageRenderProfile
} from './image-render-profile.js';
import { cacheSongMusic, readSongUserState, updateSongUserState } from './resource-cache.js';
import { importLyricsFile, removeUserLyrics } from './lyric-import.js';
import { clearDataCache, inspectDataCache } from './data-cache.js';
import { creditsFontRecommendation, easterEggForSong } from './credits-csf.js';
import {
  loadSettings, saveSettings, MIN_LYRIC_OFFSET_MS, MAX_LYRIC_OFFSET_MS
} from './settings-store.js';
import {
  normalizeCookie, parseIdCommand, parseLoginCommand,
  parseLyricDirectCommand, parseLyricFormatSelection, parseLyricSearchCommand,
  parseNumberSelection, parseOffsetCommand, parsePlayerCommand, parseImageCommand, parseQualityCommand, parseSignoutCommand, parseClearCommand, parseCacheCommand, parseClearCacheCommand,
  parseListPlaylistsCommand, parsePlaylistCommand,
  parseApiCommand,
  IMAGE_PROTOCOLS, PLAYER_BACKENDS, QUALITY_LEVELS
} from './parsers.js';

const QUALITY_LABELS = Object.freeze({
  standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res',
  jyeffect: '高清环绕声', sky: '沉浸环绕声', dolby: '杜比全景声', jymaster: '超清母带'
});

const PLAYER_BACKEND_LABELS = Object.freeze({
  auto: '自动选择', mpv: 'mpv', vlc: 'VLC', 'media-player': 'Windows MediaPlayer', ffplay: 'ffplay'
});

const IMAGE_PROTOCOL_LABELS = Object.freeze({
  auto: '自动检测', sixel: 'SIXEL（Windows Terminal 1.22+）', kitty: 'Kitty',
  iterm2: 'iTerm2', symbols: 'chafa 字符图', ansi: 'ANSI 真彩字符',
  ansi256: 'ANSI 256 色紧凑字符', none: '不显示图片'
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
  /lspl                                   滚动选择当前用户的歌单
  /pl <id>                                预览歌单
  /login                                  扫码登录
  /login <cookie>                         保存并使用已有 Cookie
  /login status                           查看服务端验证的登录状态
  /signout                                退出登录并清除本地 Cookie
  /quality [level]                        查看、选择或直接设置播放音质
  /player [auto|mpv|vlc|media-player|ffplay] 查看、选择或指定播放器后端
  /image [协议]                           查看、选择或指定终端图片协议
  /offset [毫秒]                          查看或设置播放时间偏移（默认 0）
  /api [url]                              查看或更换 API 地址
  /clear                                  清空终端并返回搜索
  /cache [MB]                             查看或设置整体缓存上限
  /clrcache [covers|musics|other]         查看或清理分类缓存
  /help                                   显示帮助
  /quit                                   退出程序

歌词命令、搜索结果和后续格式选项支持 ${chalk.cyan('> 文件名.lrc')} 或 ${chalk.cyan('| 文件名.lrc')}。
音质 level：${QUALITY_LEVELS.join('、')}。
歌曲详情：Enter/p 播放，l 歌词导出，i 导入歌词，u 播放链接和封面链接，q 返回。
歌单详情：p 播放，l 滚动选择歌曲，e 选择格式导出列表，u 歌单链接和封面链接，q 返回。
播放页：q 停止返回，r 刷新页面，i 导入歌词，空格暂停/继续，←/→ 后退/前进 5 秒，↑/↓ 调整音量，Ctrl+↑/↓ 调整偏移 50ms，t 开关翻译。
歌单播放：p 打开/关闭播放列表，s 切换随机模式，l 切换循环模式，Ctrl+←/→ 切换歌曲；列表中 ↑/↓ 选择、Enter 播放。
命令行：输入斜杠命令或参数前缀后按 Tab 自动补全。
`);
}

const API_COMPATIBILITY_NOTICE = '仅兼容 neteasecloudmusicapienhanced/api-enhanced 提供的 API。';

async function configureInitialApiBaseUrl(rl, settings, signal, logger) {
  const environmentUrl = process.env.NCM_API_BASE_URL?.trim();
  if (environmentUrl) {
    const baseUrl = normalizeApiBaseUrl(environmentUrl);
    const notify = output.isTTY ? console.log : console.error;
    notify(`本次启动使用环境变量 NCM_API_BASE_URL：${baseUrl}`);
    notify('环境变量仅覆盖本次启动，不会改写已保存的 API 地址。');
    return { baseUrl, fromEnvironment: true };
  }
  if (settings.apiBaseUrl) {
    return { baseUrl: normalizeApiBaseUrl(settings.apiBaseUrl), fromEnvironment: false };
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      `尚未配置 API 地址。请在交互式终端首次启动完成配置，或设置 NCM_API_BASE_URL。${API_COMPATIBILITY_NOTICE}`
    );
  }

  console.log('首次启动需要配置 API 地址。');
  console.log(API_COMPATIBILITY_NOTICE);
  while (true) {
    const raw = (await ask(rl, 'API 地址（例如 https://example.com） > ', signal)).trim();
    let baseUrl;
    try {
      baseUrl = normalizeApiBaseUrl(raw);
    } catch (error) {
      console.log(`API 地址无效：${error.message}`);
      continue;
    }
    await saveSettings({ ...settings, apiBaseUrl: baseUrl });
    settings.apiBaseUrl = baseUrl;
    void logger.info('api_base_url_configured', { baseUrl, source: 'first_run' });
    console.log(`API 地址已保存：${baseUrl}`);
    return { baseUrl, fromEnvironment: false };
  }
}

async function applyApiBaseUrl(api, context, value, source) {
  const baseUrl = normalizeApiBaseUrl(value);
  await saveSettings({ ...context.settings, apiBaseUrl: baseUrl });
  context.settings.apiBaseUrl = baseUrl;
  api.setBaseUrl(baseUrl);
  const environmentWillOverride = Boolean(process.env.NCM_API_BASE_URL?.trim());
  context.apiFromEnvironment = false;
  void context.logger.info('api_base_url_changed', { baseUrl, source });
  console.log(`API 地址已更换并保存：${baseUrl}`);
  if (environmentWillOverride) {
    console.log('注意：下次启动时 NCM_API_BASE_URL 仍会优先于已保存的地址。');
  }
  await refreshAuthState(api, context.authState, context.signal, context.logger);
  if (!context.authState.verified) {
    console.log('暂时无法连接或验证新 API；地址已保留，可检查服务状态后重试。');
    console.log(`诊断日志：${context.logger.file}`);
  }
  printLoginStatus(context.authState);
}

async function handleApiCommand(rl, api, context, command) {
  if (command.url) {
    await applyApiBaseUrl(api, context, command.url, 'command');
    return;
  }
  console.log(`当前 API 地址：${api.baseUrl}`);
  console.log(API_COMPATIBILITY_NOTICE);
  if (!input.isTTY || !output.isTTY) {
    console.log('非交互模式请使用 /api <url> 更换地址。');
    return;
  }
  while (true) {
    const raw = (await ask(rl, '输入新 API 地址，或输入 q 返回 > ', context.signal)).trim();
    if (/^q$/i.test(raw)) return;
    let baseUrl;
    try {
      baseUrl = normalizeApiBaseUrl(raw);
    } catch (error) {
      console.log(`API 地址无效：${error.message}`);
      continue;
    }
    await applyApiBaseUrl(api, context, baseUrl, 'interactive');
    return;
  }
}

function printSearchResults(songs) {
  console.log();
  songs.forEach((song, index) => {
    console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${chalk.bold(song.name)} — ${song.artists.join('/')}  ${secondaryText(`[${song.id}] ${formatDuration(song.durationMs)}`)}`);
  });
}

export async function ask(rl, prompt, signal, { recordHistory = false } = {}) {
  const history = !recordHistory && Array.isArray(rl.history) ? [...rl.history] : null;
  try {
    return await rl.question(prompt, { signal });
  } finally {
    if (history) rl.history.splice(0, rl.history.length, ...history);
  }
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

export function songLyricPreview(lyrics, capacity) {
  const lines = songLyricPreviewLines(lyrics);
  return lines.slice(0, Math.max(0, Math.floor(Number(capacity) || 0)));
}

export function songLyricPreviewRemaining(lyrics, capacity) {
  const lines = songLyricPreviewLines(lyrics);
  return Math.max(0, lines.length - Math.max(0, Math.floor(Number(capacity) || 0)));
}

function songLyricPreviewLines(lyrics) {
  const advanced = ['lqe', 'lys', 'qrc', 'yrc'].some((format) => String(lyrics?.[format] || '').trim());
  if (advanced) return chooseLyricSource(lyrics).lines.map((line) => line.text.trim()).filter(Boolean);
  return plainLyrics(lyrics?.original || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function songDetailMetadataLines(song, platform = process.platform) {
  const recommendation = creditsFontRecommendation(song, platform);
  return [
    song.name,
    `歌手：${song.artists.join('/') || '未知'}`,
    `专辑：${song.album}`,
    `ID：${song.id}`,
    `时长：${formatDuration(song.durationMs)}`,
    ...(recommendation ? [recommendation] : [])
  ];
}

async function showSong(
  song, signal, imageProtocol = 'auto', lyrics = null, logger = null,
  imageCacheMaxBytes, imageRenderPerformance, pageState = {}
) {
  console.log();
  let transitionCoverRows = [];
  const detailRows = output.rows || 24;
  const fontRecommendation = creditsFontRecommendation(song);
  const coverRows = song.cover
    ? await tryRenderImage(song.cover, {
      signal,
      size: 'detail',
      shouldRender: pageState.shouldRender,
        protocol: imageProtocol,
        logger,
        diagnosticContext: 'song_detail',
        imageCacheMaxBytes,
        imageRenderMaxRows: imageRenderPerformance?.maxRows(imageProtocol),
        onRenderPerformance: (sample) => imageRenderPerformance?.observe(sample),
        maxRows: Math.max(1, detailRows - 14 - (fontRecommendation ? 1 : 0)),
        imageIdentity: { type: 'track-cover', id: song.id },
        forceRefresh: Boolean(pageState.forceCoverRefresh),
        preloadedBuffer: pageState.preloadedCoverBuffer,
        deferLoad: true,
        onDeferredReady: pageState.onImageReady,
        onTextRows: easterEggForSong(song)?.directAnimation
          ? (rows) => { transitionCoverRows = rows; }
          : undefined
      })
    : 0;
  if (pageState.shouldRender && !pageState.shouldRender()) return [];
  const metadataLines = songDetailMetadataLines(song);
  console.log(chalk.bold.green(metadataLines[0]));
  console.log(metadataLines.slice(1).join('\n'));
  const transitionRows = [
    '',
    ...transitionCoverRows.slice(0, coverRows),
    ...Array.from({ length: Math.max(0, coverRows - transitionCoverRows.length) }, () => ''),
    chalk.bold.green(metadataLines[0]),
    ...metadataLines.slice(1)
  ];
  const previewCapacity = Math.max(0, detailRows - coverRows - 10 - (fontRecommendation ? 1 : 0));
  const capacity = Math.max(0, previewCapacity - 1);
  const preview = songLyricPreview(lyrics, capacity);
  if (preview.length) {
    console.log(chalk.bold('\n歌词预览'));
    transitionRows.push('', chalk.bold('歌词预览'));
    for (const line of preview) console.log(chalk.white(line));
    transitionRows.push(...preview.map((line) => chalk.white(line)));
    const remaining = songLyricPreviewRemaining(lyrics, capacity);
    if (remaining) {
      const remainingText = secondaryText(`另有 ${remaining} 行`);
      console.log(remainingText);
      transitionRows.push(remainingText);
    }
  }
  void logger?.info('song_detail_layout', {
    songId: song.id,
    terminalRows: output.rows || 24,
    terminalColumns: output.columns || 80,
    coverRows,
    metadataRows: metadataLines.length,
    previewCapacity: capacity,
    previewRows: preview.length,
    bodyRows: transitionRows.length
  });
  return transitionRows;
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

function loginStatusText(authState) {
  if (authState.loggedIn) return `已登录${authState.profile?.nickname ? `：${authState.profile.nickname}` : ''}`;
  if (!authState.verified) return '存在缓存 Cookie，但暂时无法向服务端验证登录状态。';
  return '未登录，或缓存 Cookie 已失效。';
}

function printLoginStatus(authState, { detailed = false } = {}) {
  const { account, profile, level } = authState;
  console.log(loginStatusText(authState));
  if (authState.loggedIn) {
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
}

export function homeBannerLines({ apiBaseUrl, playerCommand, playerBackend, authState, logFile }) {
  return [
    'NCM CLI 点歌台',
    `API：${apiBaseUrl}`,
    `播放器：${playerBackendLabel(playerCommand)}（设置：${playerBackend}）`,
    loginStatusText(authState),
    `日志：${logFile}`,
    '输入 /help 查看命令。'
  ];
}

export function homePromptText(loggedIn = false) {
  return loggedIn
    ? '\n搜索歌曲、输入 ID 点歌，或者输入指令 > '
    : '\n搜索歌曲、输入 ID 点歌，或者输入指令（可使用 /login 登录） > ';
}

function printHomeBanner(api, context) {
  const homePlayer = findPlayer(playerCommandsForBackend(context.settings.playerBackend));
  const lines = homeBannerLines({
    apiBaseUrl: api.baseUrl,
    playerCommand: homePlayer?.command,
    playerBackend: context.settings.playerBackend,
    authState: context.authState,
    logFile: context.logger.file
  });
  console.log(chalk.bold.cyan(lines[0]));
  for (const line of lines.slice(1)) console.log(line);
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

async function setPlayerBackend(settings, backend, logger) {
  if (!PLAYER_BACKENDS.includes(backend)) {
    console.log(`不支持的播放器后端：${backend}\n可用值：${PLAYER_BACKENDS.join('、')}`);
    return false;
  }
  await saveSettings({ ...settings, playerBackend: backend });
  settings.playerBackend = backend;
  void logger.info('player_backend_changed', { playerBackend: backend });
  const detected = findPlayer(playerCommandsForBackend(backend));
  console.log(`播放器后端已设置为：${PLAYER_BACKEND_LABELS[backend]}（${backend}）`);
  if (!detected) console.log('当前 PATH 中未找到该播放器，播放前请先安装并加入 PATH。');
  return true;
}

async function handlePlayer(rl, settings, command, signal, logger) {
  if (command.backend) {
    await setPlayerBackend(settings, command.backend, logger);
    return;
  }
  console.log(`当前播放器设置：${PLAYER_BACKEND_LABELS[settings.playerBackend]}（${settings.playerBackend}）`);
  PLAYER_BACKENDS.forEach((backend, index) => {
    console.log(`${String(index + 1).padStart(2)}. ${PLAYER_BACKEND_LABELS[backend]}（${backend}）`);
  });
  while (true) {
    const raw = (await ask(rl, '选择序号或 backend，q 返回：', signal)).trim().toLowerCase();
    if (/^q$/i.test(raw)) return;
    const backend = /^\d+$/.test(raw) ? PLAYER_BACKENDS[Number(raw) - 1] : raw;
    if (backend && await setPlayerBackend(settings, backend, logger)) return;
  }
}

async function setImageProtocol(settings, protocol, logger) {
  if (!IMAGE_PROTOCOLS.includes(protocol)) {
    console.log(`不支持的图片协议：${protocol}\n可用值：${IMAGE_PROTOCOLS.join('、')}`);
    return false;
  }
  await saveSettings({ ...settings, imageProtocol: protocol });
  settings.imageProtocol = protocol;
  void logger.info('image_protocol_changed', { imageProtocol: protocol });
  console.log(`终端图片协议已设置为：${IMAGE_PROTOCOL_LABELS[protocol]}（${protocol}）`);
  return true;
}

async function handleImage(rl, settings, command, signal, logger) {
  if (command.protocol) {
    await setImageProtocol(settings, command.protocol, logger);
    return;
  }
  console.log(`当前终端图片协议：${IMAGE_PROTOCOL_LABELS[settings.imageProtocol]}（${settings.imageProtocol}）`);
  IMAGE_PROTOCOLS.forEach((protocol, index) => {
    console.log(`${String(index + 1).padStart(2)}. ${IMAGE_PROTOCOL_LABELS[protocol]}（${protocol}）`);
  });
  while (true) {
    const raw = (await ask(rl, '选择序号或协议，q 返回：', signal)).trim().toLowerCase();
    if (/^q$/i.test(raw)) return;
    const protocol = /^\d+$/.test(raw) ? IMAGE_PROTOCOLS[Number(raw) - 1] : raw;
    if (protocol && await setImageProtocol(settings, protocol, logger)) return;
  }
}

async function setLyricOffset(settings, milliseconds, logger) {
  if (!Number.isInteger(milliseconds)
      || milliseconds < MIN_LYRIC_OFFSET_MS || milliseconds > MAX_LYRIC_OFFSET_MS) {
    console.log(`播放时间偏移量必须是 ${MIN_LYRIC_OFFSET_MS} 到 ${MAX_LYRIC_OFFSET_MS} 之间的整数毫秒。`);
    return false;
  }
  await persistPlaybackOffset(settings, milliseconds, logger, 'command');
  console.log(`播放时间偏移已设置为：${milliseconds} 毫秒`);
  return true;
}

async function persistPlaybackOffset(settings, milliseconds, logger, source) {
  await saveSettings({ ...settings, lyricOffsetMs: milliseconds });
  settings.lyricOffsetMs = milliseconds;
  void logger.info('lyric_offset_changed', { lyricOffsetMs: milliseconds, source });
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

function formatBytes(bytes) {
  if (bytes == null || bytes === Infinity) return '不限制';
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

async function handleCacheSetting(api, settings, command, logger) {
  if (command.megabytes == null) {
    console.log(`整体缓存上限：${formatBytes(settings.cacheMaxBytes)}`);
    return;
  }
  const bytes = command.megabytes === 0 ? null : command.megabytes * 1024 * 1024;
  await saveSettings({ ...settings, cacheMaxBytes: bytes });
  settings.cacheMaxBytes = bytes;
  api.setCacheMaxBytes(bytes);
  void logger.info('cache_limit_changed', { bytes });
  console.log(`整体缓存上限已设置为 ${formatBytes(bytes)}`);
}

async function handleClearCache(rl, command, signal) {
  const before = await inspectDataCache();
  let group = command.group;
  if (!group) {
    console.log(`封面：${formatBytes(before.covers)}`);
    console.log(`歌曲：${formatBytes(before.musics)}`);
    console.log(`其他：${formatBytes(before.other)}`);
    console.log(`合计：${formatBytes(before.total)}`);
    const selection = (await ask(rl, '清理 [1]封面 [2]歌曲 [3]其他 [q]取消 > ', signal)).trim();
    group = selection === '1' ? 'covers' : selection === '2' ? 'musics' : selection === '3' ? 'other' : null;
    if (!group) return;
  }
  await clearDataCache(group);
  const labels = { covers: '封面', musics: '歌曲', other: '其他' };
  console.log(`${labels[group]}缓存已清理`);
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
  if (!qrRendered && qr.qrimg) qrRendered = Boolean(await tryRenderImage(qr.qrimg, {
    signal, logger, diagnosticContext: 'login_qr'
  }));
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

async function writeLyrics(target, content, song, format) {
  const file = await writeExport({
    target, content, kind: 'lyrics', format, title: song.name, artists: song.artists
  });
  return file;
}

async function writePlaylist(target, content, playlist, format) {
  const file = await writeExport({ target, content, kind: 'playlist', format, title: playlist.name });
  return file;
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

async function outputLyrics(api, song, format, outputFile, signal, { silent = false } = {}) {
  const lyrics = await api.lyrics(song.id, { signal });
  const content = lyricContent(lyrics, format);
  if (!content) {
    console.log(format === 'trans' ? '暂无翻译歌词。' : '暂无对应歌词。');
    return false;
  }
  if (outputFile !== null) {
    const file = await writeLyrics(outputFile, content, song, format);
    if (!silent) console.log(`歌词已写入：${file}`);
    return { written: true, file };
  }
  else console.log(`\n${content}`);
  return { written: false, file: null };
}

async function lyricFormatMenu(rl, api, song, { outputFile = null, signal, silent = false } = {}) {
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
      if (outputFile === '' && !selection.output) target = '';
    } catch (error) {
      console.log(error.message);
      continue;
    }
    return outputLyrics(api, song, selection.format, target, signal, { silent });
  }
}

function unavailableUrlMessage(result, authState) {
  const code = result?.code ?? result?.attempts?.at(-1)?.code ?? '未知';
  const auth = authState.loggedIn ? '已登录' : authState.verified ? '未登录' : '登录状态未验证';
  return `无法播放：API 返回歌曲状态 code=${code}，未提供 URL（当前${auth}）。可能受会员、版权或地区限制。`;
}

async function updateLikedPlaylist(api, song, context, operation = 'add') {
  const uid = context.authState.profile?.userId || context.authState.account?.id;
  if (!uid) throw new Error('无法确定当前登录用户');
  context.likedPlaylistPromise ||= api.userPlaylists(uid, {
    signal: context.signal, username: context.authState.profile?.nickname
  }).then((playlists) => {
    const username = context.authState.profile?.nickname || '';
    const liked = playlists.find((playlist) => playlist.specialType === 5
      || String(playlist.name || '').trim() === `${username}喜欢的音乐`);
    if (!liked) throw new Error('未找到“喜欢的音乐”歌单');
    return liked.id;
  });
  const playlistId = await context.likedPlaylistPromise;
  return operation === 'del'
    ? api.removePlaylistTracks(playlistId, [song.id], { signal: context.signal })
    : api.addPlaylistTracks(playlistId, [song.id], { signal: context.signal });
}

async function playSong(api, song, context, rl, cachedLyrics = null, returnPageRows = []) {
  const { signal, logger, authState, shutdown } = context;
  let playbackUrl = await cacheSongMusic(song.id, null, {
    signal, maxBytes: context.settings.cacheMaxBytes, logger
  });
  const result = playbackUrl ? { url: playbackUrl } : await api.songUrl(song.id, { signal });
  if (!result?.url) {
    console.log(unavailableUrlMessage(result, authState));
    console.log(`诊断日志：${logger.file}`);
    return cachedLyrics;
  }
  let applyLyricsRefresh = null;
  let lyrics = cachedLyrics || await api.lyrics(song.id, {
    signal,
    onCacheUpdated: (next) => applyLyricsRefresh?.({ lyrics: next, selected: chooseLyricSource(next) })
  });
  const selectedLyrics = chooseLyricSource(lyrics);
  void logger.info('lyrics_source_selected', {
    songId: song.id, type: selectedLyrics.type,
    lineCount: selectedLyrics.lines.length, sourceBytes: Buffer.byteLength(selectedLyrics.source || ''),
    available: Object.fromEntries(['lys', 'qrc', 'yrc', 'original'].map((key) => [
      key, { bytes: typeof lyrics?.[key] === 'string' ? Buffer.byteLength(lyrics[key]) : 0,
        parsedLines: typeof lyrics?.[key] === 'string' ? chooseLyricSource({ [key]: lyrics[key] }).lines.length : 0 }
    ]))
  });
  if (!playbackUrl) try {
    playbackUrl = await cacheSongMusic(song.id, result.url, {
      signal, maxBytes: context.settings.cacheMaxBytes, logger
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    void logger.warn('song_cache_failed', { songId: song.id, error });
  }
  let favorited = false;
  if (authState.loggedIn) {
    const uid = authState.profile?.userId || authState.account?.id;
    if (uid) favorited = await api.isSongLiked(uid, song.id, {
      signal, username: authState.profile?.nickname
    });
  }
  const userState = await readSongUserState(song.id);
  await playWithProgress({
    song,
    url: playbackUrl,
    durationMs: song.durationMs,
    lyricSource: selectedLyrics.source,
    lyricType: selectedLyrics.type,
    translatedLyricSource: lyrics.translated,
    romanizedLyricSource: lyrics.romanized,
    favorited,
    lyricOffsetMs: Number.isFinite(userState.lyricOffsetMs) ? userState.lyricOffsetMs : context.settings.lyricOffsetMs,
    translationMode: context.settings.translationMode,
    smtcOffsetMs: context.settings.smtcOffsetMs,
    playerBackend: context.settings.playerBackend,
    imageProtocol: context.settings.imageProtocol,
    imageCacheMaxBytes: context.settings.cacheMaxBytes,
    imageRenderMaxRows: context.imageRenderPerformance?.maxRows(context.settings.imageProtocol),
    onImageRenderPerformance: (sample) => context.imageRenderPerformance?.observe(sample),
    signal,
    logger,
    rl,
    onFavorite: authState.loggedIn
      ? (currentSong, operation) => updateLikedPlaylist(api, currentSong, context, operation)
      : undefined,
    onImportLyrics: async (currentSong, file) => {
      if (file === '!delete') {
        await removeUserLyrics(currentSong.id);
        lyrics = await api.lyrics(currentSong.id, { signal });
        return { removed: true, lyrics, selected: chooseLyricSource(lyrics) };
      }
      const imported = await importLyricsFile(currentSong.id, file, { logger });
      lyrics = imported.lyrics;
      return imported;
    },
    onTrackUserStateChange: (currentSong, patch) => updateSongUserState(currentSong.id, patch),
    onTranslationModeChange: async (translationMode) => {
      context.settings.translationMode = translationMode;
      await saveSettings({ ...context.settings, translationMode });
    },
    registerLyricsRefresh: (handler) => { applyLyricsRefresh = handler; },
    returnPageRows,
    onInterrupt: () => shutdown('playback_ctrl_c')
  });
  return lyrics;
}

async function songMenu(rl, api, song, context) {
  const releaseScreen = acquireTerminalScreen(output);
  try {
    return await songMenuInScreen(rl, api, song, context);
  } finally {
    releaseScreen();
  }
}

async function songMenuInScreen(rl, api, song, context) {
  const { signal, authState } = context;
  let cachedLyrics = null;
  try {
    cachedLyrics = await api.lyrics(song.id, { signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    void context.logger.warn('song_lyrics_preview_failed', { songId: song.id, error });
  }
  let linksVisible = false;
  let songLinks = [];
  let favorited = false;
  if (authState.loggedIn) {
    const uid = authState.profile?.userId || authState.account?.id;
    if (uid) {
      try {
        favorited = await api.isSongLiked(uid, song.id, {
          signal, username: authState.profile?.nickname
        });
        void context.logger.info('liked_cache_result', { songId: song.id, favorited });
      }
      catch (error) {
        if (!isAbortError(error)) void context.logger.warn('liked_cache_lookup_failed', { songId: song.id, error });
      }
    }
  }
  let favoritePending = false;
  let forceCoverRefresh = false;
  while (true) {
    const page = await openDetailPage(
      rl,
      (pageState) => {
        const force = forceCoverRefresh;
        forceCoverRefresh = false;
        return showSong(
          song, signal, context.settings.imageProtocol, cachedLyrics, context.logger,
          context.settings.cacheMaxBytes, context.imageRenderPerformance,
          { ...pageState, forceCoverRefresh: force }
        );
      },
      () => detailFooterPrompt(
        chalk.yellow(songDetailPrompt({ loggedIn: authState.loggedIn, favorited })),
        linksVisible ? songLinks : []
      ),
      authState.loggedIn ? ['\r', '\n', 'p', 'l', 'i', 'u', 'f', 'r', 'q'] : ['\r', '\n', 'p', 'l', 'i', 'u', 'r', 'q'],
      context
    );
    const { action } = page;
    try {
      if (/^(?:q|b|back|返回)$/i.test(action)) return;
      if (/^(?:r|refresh|刷新)$/i.test(action)) {
        linksVisible = false;
        forceCoverRefresh = true;
        void api.songDetail(song.id, {
          forceRevalidate: true,
          onCacheUpdated: (next) => Object.assign(song, next)
        }).catch((error) => void context.logger.warn('song_detail_refresh_failed', { songId: song.id, error }));
        void api.lyrics(song.id, {
          forceRevalidate: true,
          onCacheUpdated: (next) => { cachedLyrics = next; }
        }).catch((error) => void context.logger.warn('song_lyrics_refresh_failed', { songId: song.id, error }));
        continue;
      }
      if (/^(?:l|lyric|歌词)$/i.test(action)) {
        linksVisible = false;
        prepareDetailOverlay(8);
        const result = await lyricFormatMenu(rl, api, song, { outputFile: '', signal, silent: true });
        if (result?.written) await showDetailNotice(`歌词已写入：${result.file}`, context);
        continue;
      }
      if (/^(?:i|import|导入)$/i.test(action)) {
        linksVisible = false;
        try {
          let file;
          if (input.isTTY && output.isTTY) {
            output.write(detailInlinePromptSequence(page.bodyRows, '请输入歌词路径：'));
            file = (await ask(rl, '', signal)).trim();
          } else {
            file = (await ask(rl, '请输入歌词路径：', signal)).trim();
          }
          if (!file || file.toLowerCase() === 'q') continue;
          if (file === '!delete') {
            await removeUserLyrics(song.id);
            cachedLyrics = await api.lyrics(song.id, { signal });
            await showDetailNotice('已删除当前曲目的用户歌词', context);
            continue;
          }
          const imported = await importLyricsFile(song.id, file, { logger: context.logger });
          cachedLyrics = imported.lyrics;
          await showDetailNotice(`已导入 ${imported.format.toUpperCase()} 歌词`, context);
        } catch (error) {
          if (isAbortError(error)) throw error;
          await showDetailNotice(`歌词导入失败：${error?.message || '未知错误'}`, context);
        }
        continue;
      }
      if (/^(?:u|url|链接)$/i.test(action)) {
        if (linksVisible) linksVisible = false;
        else {
          const result = await api.songUrl(song.id, { signal });
          songLinks = [
            result?.url ? `播放链接：${result.url}` : unavailableUrlMessage(result, authState),
            song.cover ? `封面链接：${song.cover}` : '无封面链接'
          ];
          linksVisible = true;
        }
        continue;
      }
      if (/^(?:f|favorite|收藏)$/i.test(action) && authState.loggedIn && !favoritePending) {
        linksVisible = false;
        favoritePending = true;
        try {
          const removing = favorited;
          const result = await updateLikedPlaylist(api, song, context, removing ? 'del' : 'add');
          favorited = !removing;
          await showDetailNotice(removing
            ? '已从喜欢的音乐中移除'
            : result?.alreadyPresent ? '当前歌曲已在喜欢的音乐中' : '已添加至喜欢的音乐', context);
        } catch (error) {
          if (isAbortError(error)) throw error;
          void context.logger.warn('favorite_song_failed', { songId: song.id, error });
          await showDetailNotice(`收藏操作失败：${error?.message || '未知错误'}`, context);
        } finally {
          favoritePending = false;
        }
        continue;
      }
      if (/^(?:\r|\n|p|play|播放)$/i.test(action)) {
        linksVisible = false;
        const returnPageRows = page.transitionRows;
        page.close();
        cachedLyrics = await playSong(api, song, context, rl, cachedLyrics, returnPageRows);
        continue;
      }
      console.log('未知选项，请输入 p、l、u 或 q。');
    } finally {
      page.close();
    }
  }
}

export function songDetailPrompt({ loggedIn = false, favorited = false } = {}) {
  const favorite = loggedIn ? ` [f]${favorited ? '取消收藏' : '收藏'}` : '';
  return `[p]播放 [l]歌词导出 [i]导入歌词 [u]播放链接${favorite} [r]刷新 [q]返回 > `;
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

async function readDetailAction(rl, prompt, keys, context, onResize) {
  if (input.isTTY && output.isTTY) {
    return readTerminalKey({
      rl, prompt, keys, signal: context.signal,
      onResize,
      onInterrupt: () => context.shutdown('detail_ctrl_c')
    });
  }
  const text = typeof prompt === 'function' ? prompt() : prompt;
  return (await ask(rl, text, context.signal)).trim().toLowerCase();
}

async function openDetailPage(rl, render, prompt, keys, context) {
  const tty = input.isTTY && output.isTTY;
  const releaseScreen = tty ? acquireTerminalScreen(output) : () => {};
  if (tty) output.write('\x1b[?25l\x1b[2J\x1b[H');
  let closed = false;
  let renderGeneration = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    renderGeneration += 1;
    if (tty) output.write('\x1b[?25h');
    releaseScreen();
  };
  try {
    let transitionBodyRows = [];
    let redrawCount = 0;
    let promptActive = false;
    const promptText = () => typeof prompt === 'function' ? prompt() : prompt;
    const redraw = async (state = {}) => {
      const generation = ++renderGeneration;
      const renderStartedAt = Date.now();
      const reason = state.reason || (redrawCount++ === 0 ? 'initial' : 'resize');
      void context.logger?.info('detail_render_started', {
        reason, terminalRows: output.rows || 24, terminalColumns: output.columns || 80,
        imageProtocol: context.settings?.imageProtocol
      });
      if (tty) output.write('\x1b[2J\x1b[H');
      try {
        const renderedRows = await render({
          ...state,
          shouldRender: () => !closed && generation === renderGeneration,
          onImageReady: (preloadedCoverBuffer) => {
            if (closed || generation !== renderGeneration) return;
            void redraw({ reason: 'image_ready', preloadedCoverBuffer }).then(() => {
              if (!closed && promptActive) output.write(promptText());
            }).catch(() => {});
          }
        });
        if (generation === renderGeneration && Array.isArray(renderedRows)) transitionBodyRows = renderedRows;
        void context.logger?.info('detail_render_completed', {
          reason, status: 'success', durationMs: Date.now() - renderStartedAt,
          bodyRows: Array.isArray(renderedRows) ? renderedRows.length : null,
          terminalRows: output.rows || 24, terminalColumns: output.columns || 80
        });
      } catch (error) {
        void context.logger?.warn('detail_render_completed', {
          reason, status: 'failed', durationMs: Date.now() - renderStartedAt, error
        });
        throw error;
      }
    };
    await redraw();
    promptActive = true;
    const action = await readDetailAction(rl, promptText, keys, context, redraw);
    promptActive = false;
    return {
      action,
      close,
      tty,
      bodyRows: transitionBodyRows,
      transitionRows: detailPageTransitionRows(transitionBodyRows, promptText())
    };
  } catch (error) {
    close();
    throw error;
  }
}

export function detailOverlaySequence(rows, reservedRows) {
  const height = Math.max(1, Number(rows) || 24);
  const startRow = Math.max(1, height - Math.max(1, reservedRows) + 1);
  return `\x1b[${startRow};1H\x1b[0J`;
}

export function detailPageTransitionRows(bodyRows, prompt, rows = output.rows) {
  const height = Math.max(1, Math.floor(Number(rows) || 24));
  const frame = Array.from({ length: height }, () => '');
  for (let index = 0; index < Math.min(height, bodyRows?.length || 0); index += 1) {
    frame[index] = String(bodyRows[index] ?? '');
  }
  const source = String(prompt ?? '');
  const overlay = /^\x1b\[(\d+);1H\x1b\[0J([\s\S]*)$/.exec(source);
  const start = overlay ? Math.max(0, Number(overlay[1]) - 1) : Math.max(0, height - 1);
  const lines = (overlay ? overlay[2] : source).split(/\r?\n/);
  for (let index = 0; index < lines.length && start + index < height; index += 1) {
    frame[start + index] = lines[index];
  }
  return frame;
}

export function detailInlinePromptSequence(bodyRows, prompt, rows = output.rows) {
  const height = Math.max(1, Math.floor(Number(rows) || 24));
  let lastContent = -1;
  for (let index = 0; index < Math.min(height, bodyRows?.length || 0); index += 1) {
    if (String(bodyRows[index] ?? '').trim()) lastContent = index;
  }
  const promptRow = Math.min(height, Math.max(1, lastContent + 3));
  return `\x1b[${promptRow};1H\x1b[0J\x1b[?25h${prompt}`;
}

function prepareDetailOverlay(reservedRows) {
  if (!input.isTTY || !output.isTTY) return;
  // 固定顶部内容，只从屏幕底部向上清除操作区；后续输出会替换这些行，
  // 而不是通过新增行把详情内容滚出屏幕。
  output.write(detailOverlaySequence(output.rows, reservedRows));
}

async function showDetailNotice(message, context) {
  prepareDetailOverlay(2);
  const maximum = Math.max(1, (output.columns || 80) - 1);
  const text = String(message);
  console.log(chalk.green(text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text));
  await delay(1500, context.signal);
}

export function detailFooterPrompt(prompt, lines = [], rows = output.rows, columns = output.columns) {
  const footer = lines.map((line) => String(line).slice(0, Math.max(1, columns || 80)));
  const height = Math.max(1, rows || 24);
  return `${detailOverlaySequence(height, footer.length + 1)}${prompt}${footer.length ? `\n${footer.join('\n')}` : ''}`;
}

export function playlistPlaybackDestination(playback) {
  return null;
}

async function playPlaylist(api, playlist, tracks, startIndex, context) {
  if (!tracks.length) {
    console.log('歌单中没有可播放的歌曲。');
    return;
  }
  const unavailable = new Set();
  const cache = new Map();
  let applyLyricsRefresh = null;
  const loadTrack = (index) => {
    if (index < 0 || index >= tracks.length) return Promise.resolve(null);
    if (cache.has(index)) return cache.get(index);
    const promise = (async () => {
      const track = tracks[index];
      let song = track;
      try {
        song = await api.songDetail(track.id, { signal: context.signal });
        void context.logger.info('playlist_song_metadata_ready', { songId: song.id, index });
      } catch (error) {
        if (isAbortError(error)) throw error;
        void context.logger.warn('playlist_song_metadata_failed', { songId: track.id, index, error });
      }
      let playbackUrl = await cacheSongMusic(song.id, null, {
        signal: context.signal, maxBytes: context.settings.cacheMaxBytes, logger: context.logger
      });
      const result = playbackUrl ? { url: playbackUrl } : await api.songUrl(song.id, { signal: context.signal });
      if (!result?.url) {
        unavailable.add(index);
        void context.logger.warn('playlist_track_unavailable', { songId: song.id, index, code: result?.code });
        return null;
      }
      unavailable.delete(index);
      let lyrics = { original: '', translated: '', romanized: '', lys: '', qrc: '', yrc: '' };
      try {
        lyrics = await api.lyrics(song.id, {
          signal: context.signal,
          onCacheUpdated: (next) => {
            if (index === activeIndex) {
              applyLyricsRefresh?.({ lyrics: next, selected: chooseLyricSource(next) });
            }
          }
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        void context.logger.warn('playlist_lyrics_failed', { songId: song.id, error });
      }
      const selectedLyrics = chooseLyricSource(lyrics);
      const userState = await readSongUserState(song.id);
      void context.logger.info('lyrics_source_selected', {
        songId: song.id, type: selectedLyrics.type,
        lineCount: selectedLyrics.lines.length, sourceBytes: Buffer.byteLength(selectedLyrics.source || ''),
        available: Object.fromEntries(['lys', 'qrc', 'yrc', 'original'].map((key) => [
          key, { bytes: typeof lyrics?.[key] === 'string' ? Buffer.byteLength(lyrics[key]) : 0,
            parsedLines: typeof lyrics?.[key] === 'string' ? chooseLyricSource({ [key]: lyrics[key] }).lines.length : 0 }
        ]))
      });
      if (!playbackUrl) try {
        playbackUrl = await cacheSongMusic(song.id, result.url, {
          signal: context.signal, maxBytes: context.settings.cacheMaxBytes, logger: context.logger
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        void context.logger.warn('song_cache_failed', { songId: song.id, error });
      }
      return {
        index,
        song,
        url: playbackUrl,
        durationMs: song.durationMs,
        lyricSource: selectedLyrics.source,
        lyricType: selectedLyrics.type,
        translatedLyricSource: lyrics.translated,
        romanizedLyricSource: lyrics.romanized,
        lyricOffsetMs: Number.isFinite(userState.lyricOffsetMs) ? userState.lyricOffsetMs : context.settings.lyricOffsetMs,
        favorited: context.authState.loggedIn
          ? await api.isSongLiked(
              context.authState.profile?.userId || context.authState.account?.id,
              song.id,
              { username: context.authState.profile?.nickname }
            )
          : false
      };
    })().then((payload) => {
      if (!payload) cache.delete(index);
      return payload;
    }, (error) => {
      cache.delete(index);
      throw error;
    });
    cache.set(index, promise);
    return promise;
  };

  const findPlayable = async (firstIndex, step = 1, exact = false) => {
    for (let index = firstIndex; index >= 0 && index < tracks.length; index += step) {
      const payload = await loadTrack(index);
      if (payload) return payload;
      if (exact) break;
    }
    return null;
  };

  const firstIndex = Math.min(Math.max(0, startIndex), tracks.length - 1);
  const initial = await findPlayable(firstIndex, 1);
  if (!initial) {
    console.log('歌单中没有可用的播放链接，可能受会员、版权或地区限制。');
    return;
  }

  let activeIndex = initial.index;
  const prefetchAdjacent = (index) => {
    for (const neighbor of [index - 1, index + 1]) {
      if (neighbor >= 0 && neighbor < tracks.length) void loadTrack(neighbor).catch(() => {});
    }
  };
  prefetchAdjacent(activeIndex);

  const playback = await playWithProgress({
    ...initial,
    lyricOffsetMs: initial.lyricOffsetMs,
    translationMode: context.settings.translationMode,
    smtcOffsetMs: context.settings.smtcOffsetMs,
    playerBackend: context.settings.playerBackend,
    imageProtocol: context.settings.imageProtocol,
    imageCacheMaxBytes: context.settings.cacheMaxBytes,
    imageRenderMaxRows: context.imageRenderPerformance?.maxRows(context.settings.imageProtocol),
    onImageRenderPerformance: (sample) => context.imageRenderPerformance?.observe(sample),
    playlist: { name: playlist.name, tracks, currentIndex: activeIndex },
    signal: context.signal,
    logger: context.logger,
    rl: context.rl,
    onFavorite: context.authState.loggedIn
      ? (currentSong, operation) => updateLikedPlaylist(api, currentSong, context, operation)
      : undefined,
    onImportLyrics: async (currentSong, file) => {
      if (file === '!delete') {
        await removeUserLyrics(currentSong.id);
        const lyrics = await api.lyrics(currentSong.id, { signal: context.signal });
        cache.delete(activeIndex);
        return { removed: true, lyrics, selected: chooseLyricSource(lyrics) };
      }
      const imported = await importLyricsFile(currentSong.id, file, { logger: context.logger });
      cache.delete(activeIndex);
      return imported;
    },
    onTrackUserStateChange: (currentSong, patch) => updateSongUserState(currentSong.id, patch),
    onTranslationModeChange: async (translationMode) => {
      context.settings.translationMode = translationMode;
      await saveSettings({ ...context.settings, translationMode });
    },
    registerLyricsRefresh: (handler) => { applyLyricsRefresh = handler; },
    returnPageRows: context.returnPageRows,
    onInterrupt: () => context.shutdown('playback_ctrl_c'),
    onTrackChange: async (targetIndex, cause, transitionSignal) => {
      const step = targetIndex < activeIndex ? -1 : 1;
      const next = await findPlayable(targetIndex, step, cause === 'select');
      if (transitionSignal?.aborted) {
        throw transitionSignal.reason || new DOMException('切歌操作已取消', 'AbortError');
      }
      if (!next) return null;
      activeIndex = next.index;
      prefetchAdjacent(activeIndex);
      return next;
    }
  });

  playlistPlaybackDestination(playback);
  if (playback === 'stopped' || playback === 'smtc_stop' || playback?.type === 'playlist_quit') return;
  if (unavailable.size === tracks.length) {
    console.log('歌单中没有可用的播放链接，可能受会员、版权或地区限制。');
  }
}

export function playlistPreviewLimit(rows, coverRows = 0, hasDescription = false) {
  // Keep two terminal rows clear so a trailing newline or a one-row chafa overrun cannot scroll the page.
  const available = Math.floor(Number(rows) || 24) - Math.max(0, coverRows) - 12 - (hasDescription ? 1 : 0);
  return Math.max(1, available);
}

async function playlistMenu(rl, api, id, context) {
  const releaseScreen = acquireTerminalScreen(output);
  try {
    return await playlistMenuInScreen(rl, api, id, context);
  } finally {
    releaseScreen();
  }
}

async function playlistMenuInScreen(rl, api, id, context) {
  let playlist;
  let pendingPlaylist = null;
  playlist = await api.playlistDetail(id, {
    signal: context.signal,
    onCacheUpdated: (next) => {
      if (playlist) Object.assign(playlist, next);
      else pendingPlaylist = next;
    }
  });
  if (pendingPlaylist) Object.assign(playlist, pendingPlaylist);
  const previewTracks = playlist.tracks || [];
  let fullTracks = null;
  const loadFullTracks = async () => {
    fullTracks ||= await api.playlistTracks(id, { signal: context.signal });
    return fullTracks;
  };
  let cover = playlist.cover || playlist.coverImgUrl;
  let forceCoverRefresh = false;
  let linksVisible = false;
  const playlistLinks = [
    `歌单链接：${playlistLink(playlist.id || id)}`,
    cover ? `封面链接：${cover}` : '无封面链接'
  ];
  const renderDetail = async (pageState = {}) => {
    console.log();
    let transitionCoverRows = [];
    const detailRows = output.rows || 24;
    const coverRows = cover ? await tryRenderImage(cover, {
      signal: context.signal,
      size: 'detail',
      shouldRender: pageState.shouldRender,
      protocol: context.settings.imageProtocol,
      logger: context.logger,
      diagnosticContext: 'playlist_detail',
      imageCacheMaxBytes: context.settings.cacheMaxBytes,
      imageRenderMaxRows: context.imageRenderPerformance?.maxRows(context.settings.imageProtocol),
      onRenderPerformance: (sample) => context.imageRenderPerformance?.observe(sample),
      maxRows: Math.max(1, detailRows - 15 - (playlist.description ? 1 : 0) - (linksVisible ? 2 : 0)),
      imageIdentity: { type: 'playlist-cover', id: playlist.id || id },
      forceRefresh: forceCoverRefresh,
      preloadedBuffer: pageState.preloadedCoverBuffer,
      deferLoad: true,
      onDeferredReady: pageState.onImageReady,
      onTextRows: (rows) => { transitionCoverRows = rows; }
    }) : 0;
    if (pageState.shouldRender && !pageState.shouldRender()) return [];
    forceCoverRefresh = false;
    const transitionRows = [
      '',
      ...transitionCoverRows.slice(0, coverRows),
      ...Array.from({ length: Math.max(0, coverRows - transitionCoverRows.length) }, () => '')
    ];
    const title = chalk.bold.green(playlist.name || `歌单 ${id}`);
    const metadata = [
      `创建者：${playlistCreatorName(playlist)}`,
      `歌曲数：${playlist.trackCount ?? previewTracks.length}`,
      `播放量：${formatCount(playlist.playCount)}`,
      `ID：${playlist.id || id}`,
      ...(playlist.description ? [`描述：${String(playlist.description).replace(/\s+/g, ' ').trim()}`] : [])
    ];
    console.log(title);
    console.log(metadata.join('\n'));
    transitionRows.push(title, ...metadata);
    console.log(chalk.bold('\n歌曲预览'));
    transitionRows.push('', chalk.bold('歌曲预览'));
    const limit = Math.max(1, playlistPreviewLimit(output.rows, coverRows, Boolean(playlist.description))
      - (linksVisible ? 2 : 0) - 1);
    previewTracks.slice(0, limit).forEach((song, index) => {
      const line = `${chalk.cyan(String(index + 1).padStart(2))}. ${song.name} — ${song.artists?.join('/') || '未知歌手'} ${secondaryText(`[${song.id}]`)}`;
      console.log(line);
      transitionRows.push(line);
    });
    const remaining = Math.max(0, (playlist.trackCount ?? previewTracks.length) - Math.min(limit, previewTracks.length));
    if (remaining) {
      const remainingText = secondaryText(`另有 ${remaining} 首`);
      console.log(remainingText);
      transitionRows.push(remainingText);
    }
    void context.logger?.info('playlist_detail_layout', {
      playlistId: playlist.id || id,
      terminalRows: output.rows || 24,
      terminalColumns: output.columns || 80,
      coverRows,
      metadataRows: metadata.length + 1,
      previewLimit: limit,
      previewRows: Math.min(limit, previewTracks.length),
      remaining,
      linksVisible,
      bodyRows: transitionRows.length + 1
    });
    console.log();
    transitionRows.push('');
    return transitionRows;
  };

  while (true) {
    const page = await openDetailPage(
      rl,
      renderDetail,
      () => detailFooterPrompt(
        chalk.yellow('[p]播放 [l]歌曲列表 [e]导出列表 [u]歌单链接 [r]刷新 [q]返回 > '),
        linksVisible ? playlistLinks : []
      ),
      ['\r', '\n', 'p', 'l', 'e', 'u', 'r', 'q'],
      context
    );
    const { action: raw } = page;
    try {
    if (/^(?:q|b|back|返回)$/i.test(raw)) return 'back';
    if (/^(?:r|refresh|刷新)$/i.test(raw)) {
      linksVisible = false;
      forceCoverRefresh = true;
      void api.playlistDetail(id, {
        forceRevalidate: true,
        onCacheUpdated: (next) => {
          Object.assign(playlist, next);
          cover = playlist.cover || playlist.coverImgUrl;
        }
      }).catch((error) => void context.logger.warn('playlist_detail_refresh_failed', { playlistId: id, error }));
      continue;
    }
    if (/^(?:u|url|链接)$/i.test(raw)) {
      linksVisible = !linksVisible;
      continue;
    }
    if (/^(?:\r|\n|p|play|播放)$/i.test(raw)) {
      linksVisible = false;
      const returnPageRows = page.transitionRows;
      page.close();
      const tracks = await loadFullTracks();
      await playPlaylist(api, playlist, tracks, 0, { ...context, rl, returnPageRows });
      continue;
    }
    if (/^(?:l|list|列表)$/i.test(raw)) {
      linksVisible = false;
      page.close();
      const tracks = await loadFullTracks();
      let selected;
      let selectedIndex = 0;
      let returnPageRows = [];
      if (input.isTTY && output.isTTY) {
        while (true) {
          const result = await selectTerminalList({
            rl,
            items: tracks,
            initialIndex: selectedIndex,
            title: `${playlist.name || `歌单 ${id}`} - 歌曲列表`,
            hint: '↑/↓ 或滚轮选择  Enter/空格 播放  d 详情  q/Esc 返回',
            alternateAction: 'play',
            detailAction: 'detail',
            itemText: (song, index) => `${String(index + 1).padStart(2)}. ${song.name} — ${song.artists?.join('/') || '未知歌手'}`,
            signal: context.signal,
            onInterrupt: () => context.shutdown('playlist_tracks_ctrl_c'),
            onFrame: (rows) => { returnPageRows = rows; }
          });
          if (result === null) break;
          selectedIndex = typeof result === 'number' ? result : result.index;
          if (result?.action === 'detail') {
            const detail = await api.songDetail(tracks[selectedIndex].id, { signal: context.signal });
            await songMenu(rl, api, detail, context);
            continue;
          }
          selected = selectedIndex;
          break;
        }
      } else {
        tracks.forEach((song, index) => console.log(`${index + 1}. ${song.name} — ${song.artists?.join('/') || '未知歌手'}`));
        const rawSelection = (await ask(rl, '选择序号播放，q 返回：', context.signal)).trim();
        if (!/^q$/i.test(rawSelection)) selected = Number(rawSelection) - 1;
      }
      if (Number.isInteger(selected) && selected >= 0 && selected < tracks.length) {
        await playPlaylist(api, playlist, tracks, selected, { ...context, rl, returnPageRows });
      }
      continue;
    }
    if (/^(?:e|export|导出)$/i.test(raw)) {
      linksVisible = false;
      prepareDetailOverlay(7);
      let selection = null;
      while (!selection) {
        console.log(`
导出格式：
  1  仅歌曲（每行一个歌曲名）
  2  当前方案（歌单信息 + 歌曲详情）
  3  CSV
  4  TSV`);
        const selected = parsePlaylistExportFormatSelection(
          await ask(rl, '选择格式（可追加 > 路径 或 | 路径；省略路径则导出到当前目录，q 返回） > ', context.signal)
        );
        if (selected?.quit) break;
        if (!selected) {
          console.log('请选择 1、2、3、4，或输入 q 返回。');
          continue;
        }
        selection = selected;
      }
      if (!selection) continue;

      const tracks = await loadFullTracks();
      const file = await writePlaylist(
        selection.output, playlistExportContent(playlist, tracks, selection.format), playlist, selection.format
      );
      await showDetailNotice(`歌单列表已写入：${file}`, context);
      continue;
    }
    console.log('未知选项，请输入 p、l、e、u 或 q。');
    } finally {
      page.close();
    }
  }
}

async function listUserPlaylists(rl, api, context) {
  const releaseScreen = acquireTerminalScreen(output);
  try {
    return await listUserPlaylistsInScreen(rl, api, context);
  } finally {
    releaseScreen();
  }
}

async function listUserPlaylistsInScreen(rl, api, context) {
  if (!context.authState.loggedIn) {
    console.log('此命令需要登录，请先使用 /login。');
    return;
  }
  const uid = context.authState.profile?.userId || context.authState.account?.id;
  if (!uid) {
    console.log('无法取得当前用户 ID，请执行 /login status 后重试。');
    return;
  }
  let playlists;
  let pendingPlaylists = null;
  playlists = await api.userPlaylists(uid, {
    signal: context.signal,
    onCacheUpdated: (next) => {
      if (playlists) playlists.splice(0, playlists.length, ...next);
      else pendingPlaylists = next;
    }
  });
  if (pendingPlaylists) playlists = pendingPlaylists;
  if (!playlists.length) {
    console.log('当前账号没有歌单。');
    return;
  }
  let selectedIndex = 0;
  const tty = Boolean(input.isTTY && output.isTTY && typeof input.setRawMode === 'function');
  while (true) {
    if (tty) {
      const selection = await selectTerminalList({
        rl,
        items: playlists,
        initialIndex: selectedIndex,
        title: '我的歌单',
        hint: '↑/↓ 或滚轮选择  Enter 查看  q/Esc 返回主页',
        itemText: (playlist, index) => `${String(index + 1).padStart(2)}. ${playlist.name} [${playlist.id}] ${playlist.trackCount ?? 0} 首`,
        signal: context.signal,
        onInterrupt: () => context.shutdown('playlist_list_ctrl_c'),
        input,
        output
      });
      if (selection === null) return;
      selectedIndex = selection;
      await playlistMenu(rl, api, playlists[selectedIndex].id, context);
      continue;
    }
    console.log(chalk.bold('\n我的歌单'));
    playlists.forEach((playlist, index) => {
      console.log(`${chalk.cyan(String(index + 1).padStart(2))}. ${playlist.name} ${secondaryText(`[${playlist.id}] ${playlist.trackCount ?? 0} 首`)}`);
    });
    const raw = (await ask(rl, '选择序号预览歌单，q 返回主页：', context.signal)).trim();
    if (/^q$/i.test(raw)) return;
    const selection = parseNumberSelection(raw);
    if (!selection || selection.quit || selection.output || !playlists[selection.index]) {
      console.log('无效序号。');
      continue;
    }
    selectedIndex = selection.index;
    await playlistMenu(rl, api, playlists[selection.index].id, context);
  }
}

async function chooseSong(rl, api, songs, context) {
  const releaseScreen = acquireTerminalScreen(output);
  try {
    return await chooseSongInScreen(rl, api, songs, context);
  } finally {
    releaseScreen();
  }
}

async function chooseSongInScreen(rl, api, songs, context) {
  if (input.isTTY && output.isTTY && typeof input.setRawMode === 'function') {
    let selectedIndex = 0;
    while (true) {
      let returnPageRows = [];
      const selection = await selectTerminalList({
        rl,
        items: songs,
        initialIndex: selectedIndex,
        title: '搜索结果',
        hint: '↑/↓ 或滚轮选择  Enter 查看  空格 播放  q/Esc 返回主页',
        alternateAction: 'play',
        itemText: (song, index) => `${String(index + 1).padStart(2)}. ${song.name} — ${song.artists.join('/') || '未知歌手'} [${song.id}] ${formatDuration(song.durationMs)}`,
        signal: context.signal,
        onInterrupt: () => context.shutdown('search_list_ctrl_c'),
        onFrame: (rows) => { returnPageRows = rows; }
      });
      if (selection == null) return;
      selectedIndex = typeof selection === 'number' ? selection : selection.index;
      const detail = await api.songDetail(songs[selectedIndex].id, { signal: context.signal });
      if (typeof selection === 'object' && selection.action === 'play') {
        await playSong(api, detail, context, rl, null, returnPageRows);
        if (easterEggForSong(detail)?.directAnimation) continue;
        return;
      }
      await songMenu(rl, api, detail, context);
      return;
    }
  }

  while (true) {
    printSearchResults(songs);
    const raw = (await ask(rl, '选择序号，q 返回主页：', context.signal)).trim();
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
    return;
  }
}

async function lyricSearchFlow(rl, api, command, context) {
  const songs = await api.searchLyrics(command.query, context.settings.searchLimit, { signal: context.signal });
  if (!songs.length) {
    console.log('没有找到歌词命中结果。');
    return;
  }
  while (true) {
    printSearchResults(songs);
    songs.forEach((song, index) => {
      if (song.lyricMatches?.length) console.log(secondaryText(`    ${index + 1}: ${song.lyricMatches.slice(0, 2).join(' / ')}`));
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
  const apiCommand = parseApiCommand(raw);
  if (apiCommand) {
    await handleApiCommand(rl, api, context, apiCommand);
    return;
  }
  if (parseClearCommand(raw)) {
    output.write('\x1b[3J\x1b[2J\x1b[H');
    printHomeBanner(api, context);
    return;
  }
  const cacheCommand = parseCacheCommand(raw);
  if (cacheCommand) {
    await handleCacheSetting(api, context.settings, cacheCommand, context.logger);
    return;
  }
  const clearCacheCommand = parseClearCacheCommand(raw);
  if (clearCacheCommand) {
    await handleClearCache(rl, clearCacheCommand, context.signal);
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
  const playerCommand = parsePlayerCommand(raw);
  if (playerCommand) {
    await handlePlayer(rl, context.settings, playerCommand, signal, logger);
    return;
  }
  const imageCommand = parseImageCommand(raw);
  if (imageCommand) {
    await handleImage(rl, context.settings, imageCommand, signal, logger);
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

  const musicLink = await resolveNeteaseMusicInput(raw, { signal });
  if (musicLink?.type === 'song') {
    await songMenu(rl, api, await api.songDetail(musicLink.id, { signal }), context);
    return;
  }
  if (musicLink?.type === 'playlist') {
    await playlistMenu(rl, api, musicLink.id, context);
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
  const songs = await api.search(raw, context.settings.searchLimit, { signal });
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
  let imageRenderPerformance = null;
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
  const onSighup = () => shutdown('SIGHUP');
  const onSigbreak = () => shutdown('SIGBREAK');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  process.once('SIGHUP', onSighup);
  if (process.platform === 'win32') process.once('SIGBREAK', onSigbreak);

  try {
    rl = createInterface({ input, output, completer: commandCompleter });
    rl.on('SIGINT', onSigint);
    const stalePlayers = await cleanupStalePlayerSessions();
    if (stalePlayers.cleaned) console.log(`已清理上次遗留的播放器：${stalePlayers.cleaned} 个`);
    const cookie = await loadCookie();
    const settings = await loadSettings();
    imageRenderPerformance = createImageRenderPerformance(await loadImageRenderProfile(), {
      persist: saveImageRenderProfile,
      logger
    });
    const startupApiCommand = args.length ? parseApiCommand(args.join(' ')) : null;
    let apiConfiguredFromArguments = false;
    if (!settings.apiBaseUrl && startupApiCommand?.url && !process.env.NCM_API_BASE_URL?.trim()) {
      const baseUrl = normalizeApiBaseUrl(startupApiCommand.url);
      await saveSettings({ ...settings, apiBaseUrl: baseUrl });
      settings.apiBaseUrl = baseUrl;
      apiConfiguredFromArguments = true;
      console.log(API_COMPATIBILITY_NOTICE);
      console.log(`API 地址已保存：${baseUrl}`);
    }
    const apiConfiguration = await configureInitialApiBaseUrl(rl, settings, controller.signal, logger);
    const api = new NcmApi({
      baseUrl: apiConfiguration.baseUrl, cookie, logger, quality: settings.quality,
      cacheMaxBytes: settings.cacheMaxBytes
    });
    void logger.info('startup', {
      cookiePresent: Boolean(cookie), quality: settings.quality, lyricOffsetMs: settings.lyricOffsetMs,
      smtcOffsetMs: settings.smtcOffsetMs, searchLimit: settings.searchLimit,
      imageProtocol: settings.imageProtocol,
      baseUrl: api.baseUrl, apiFromEnvironment: apiConfiguration.fromEnvironment,
      terminal: {
        platform: process.platform,
        tty: Boolean(input.isTTY && output.isTTY),
        rows: output.rows || null,
        columns: output.columns || null,
        term: process.env.TERM || null,
        termProgram: process.env.TERM_PROGRAM || null,
        termux: Boolean(process.env.TERMUX_VERSION
          || /(?:^|\/)com\.termux(?:\/|$)/i.test(process.env.PREFIX || '')),
        windowsTerminal: Boolean(process.env.WT_SESSION)
      }
    });

    if (/^idlyric$/i.test(args[0] || '') && /^\d+$/.test(args[1] || '')) {
      const lyrics = await api.lyrics(args[1], { signal: controller.signal });
      process.stdout.write(`${plainLyrics(lyrics.original)}\n`);
      return;
    }

    const authState = { loggedIn: false, verified: false, account: null, profile: null, level: null };
    await refreshAuthState(api, authState, controller.signal, logger);

    const context = {
      authState, signal: controller.signal, logger, settings, shutdown,
      imageRenderPerformance,
      apiFromEnvironment: apiConfiguration.fromEnvironment
    };
    printHomeBanner(api, context);
    if (args.length && !apiConfiguredFromArguments) await resolveInput(rl, api, args.join(' '), context);
    while (!controller.signal.aborted) {
      const prompt = homePromptText(authState.loggedIn);
      let raw;
      try {
        raw = (await ask(rl, chalk.green(prompt), controller.signal, { recordHistory: true })).trim();
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
    process.removeListener('SIGHUP', onSighup);
    if (process.platform === 'win32') process.removeListener('SIGBREAK', onSigbreak);
    rl?.removeListener('SIGINT', onSigint);
    rl?.close();
    await closeRetainedSmtc();
    await imageRenderPerformance?.flush();
    await logger.flush();
  }
}
