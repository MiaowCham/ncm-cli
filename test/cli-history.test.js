import test from 'node:test';
import assert from 'node:assert/strict';
import { ask, detailFooterPrompt, detailInlinePromptSequence, detailOverlaySequence, detailPageTransitionRows, homeBannerLines, homePromptText, playlistPlaybackDestination, playlistPreviewLimit, songDetailMetadataLines, songDetailPrompt, songLyricPreview, songLyricPreviewRemaining } from '../src/cli.js';

function fakeReadline(history, answer = '子界面输入', error = null) {
  return {
    history,
    async question() {
      this.history.unshift(answer);
      if (error) throw error;
      return answer;
    }
  };
}

test('子界面输入不会进入 readline 历史', async () => {
  const rl = fakeReadline(['主页命令']);
  assert.equal(await ask(rl, '> '), '子界面输入');
  assert.deepEqual(rl.history, ['主页命令']);
});

test('歌单详情预览数量随终端高度和封面占用变化', () => {
  assert.equal(playlistPreviewLimit(24, 0, false), 12);
  assert.equal(playlistPreviewLimit(40, 0, false), 28);
  assert.equal(playlistPreviewLimit(24, 8, true), 3);
  assert.equal(playlistPreviewLimit(8, 20, true), 1);
});

test('详情操作区从屏幕底部向上覆盖而不滚动顶部', () => {
  assert.equal(detailOverlaySequence(24, 5), '\x1b[20;1H\x1b[0J');
  assert.equal(detailOverlaySequence(10, 20), '\x1b[1;1H\x1b[0J');
  assert.equal(detailOverlaySequence(24, 1), '\x1b[24;1H\x1b[0J');
});

test('链接开关为提示符下方固定预留两行', () => {
  assert.equal(
    detailFooterPrompt('操作', ['链接一', '链接二'], 24, 80),
    '\x1b[22;1H\x1b[0J操作\n链接一\n链接二'
  );
});

test('详情页转场模型保留正文并把操作提示放回屏幕底部', () => {
  const prompt = `${detailOverlaySequence(8, 2)}[p]播放 [q]返回 > \n链接`;
  assert.deepEqual(detailPageTransitionRows(['', 'Credits EX', '歌手：Frums'], prompt, 8), [
    '', 'Credits EX', '歌手：Frums', '', '', '', '[p]播放 [q]返回 > ', '链接'
  ]);
});

test('歌曲详情歌词预览按可用行数裁剪并去除时间标签', () => {
  assert.deepEqual(songLyricPreview({ original: '[00:01.00]第一行\n[00:02.00]第二行\n第三行' }, 2), [
    '第一行', '第二行'
  ]);
  assert.deepEqual(songLyricPreview(null, 5), []);
  assert.equal(songLyricPreviewRemaining({ original: '第一行\n第二行\n第三行' }, 2), 1);
  assert.equal(songLyricPreviewRemaining({ original: '第一行' }, 2), 0);
  assert.deepEqual(songLyricPreview({ qrc: '[1000,1000]逐字(1000,1000)' }, 2), ['逐字']);
  assert.deepEqual(songLyricPreview({ lys: '[0]逐字(1000,1000)' }, 2), ['逐字']);
});

test('详情页导入提示与正文保持一行间距', () => {
  assert.equal(
    detailInlinePromptSequence(['', '歌曲', '歌手', '', '歌词'], '请输入歌词路径：', 24),
    '\x1b[7;1H\x1b[0J\x1b[?25h请输入歌词路径：'
  );
});

test('歌曲详情只为登录用户显示可切换的收藏按钮', () => {
  assert.equal(songDetailPrompt().includes('收藏'), false);
  assert.match(songDetailPrompt({ loggedIn: true }), /\[f\]收藏/);
  assert.match(songDetailPrompt({ loggedIn: true, favorited: true }), /\[f\]取消收藏/);
});

test('歌曲详情始终显示歌词导入入口', () => {
  assert.match(songDetailPrompt(), /\[i\]导入歌词/);
  assert.match(songDetailPrompt({ loggedIn: true }), /\[i\]导入歌词/);
});

test('歌曲详情保持简洁的 p 播放提示', () => {
  assert.match(songDetailPrompt(), /^\[p\]播放/);
  assert.doesNotMatch(songDetailPrompt(), /Enter/);
});

test('Credits EX 推荐字体紧跟歌曲详情元数据', () => {
  const song = {
    id: 405372425,
    name: 'Credits EX',
    artists: ['Frums'],
    album: 'Groundbreaking -BOFU2015 COMPILATION ALBUM-Stage 3-Broad Brightness',
    durationMs: 278000
  };
  assert.deepEqual(songDetailMetadataLines(song, 'win32'), [
    'Credits EX',
    '歌手：Frums',
    '专辑：Groundbreaking -BOFU2015 COMPILATION ALBUM-Stage 3-Broad Brightness',
    'ID：405372425',
    '时长：4:38',
    '推荐使用字体：NCM Credits VGA16（见 assets/fonts）'
  ]);
  assert.match(songDetailMetadataLines(song, 'linux').at(-1), /sititou70\/frums-credits-cli-nosound/);
});

test('主页输入保留在 readline 历史', async () => {
  const rl = fakeReadline(['旧搜索'], '新搜索');
  assert.equal(await ask(rl, '> ', undefined, { recordHistory: true }), '新搜索');
  assert.deepEqual(rl.history, ['新搜索', '旧搜索']);
});

test('主页横幅可供启动和清屏后复用', () => {
  assert.deepEqual(homeBannerLines({
    apiBaseUrl: 'https://ncmapi.miaowcham.com',
    playerCommand: 'mpv',
    playerBackend: 'mpv',
    authState: { loggedIn: true, verified: true, profile: { nickname: '喵锵Miaow' } },
    logFile: 'C:\\Users\\Administrator\\AppData\\Local\\ncm-cli\\logs\\ncm-cli.log'
  }), [
    'NCM CLI 点歌台',
    'API：https://ncmapi.miaowcham.com',
    '播放器：mpv（JSON IPC）（设置：mpv）',
    '已登录：喵锵Miaow',
    '日志：C:\\Users\\Administrator\\AppData\\Local\\ncm-cli\\logs\\ncm-cli.log',
    '输入 /help 查看命令。'
  ]);
});

test('主页提示符明确支持输入指令', () => {
  assert.equal(homePromptText(true), '\n搜索歌曲、输入 ID 点歌，或者输入指令 > ');
  assert.equal(homePromptText(false), '\n搜索歌曲、输入 ID 点歌，或者输入指令（可使用 /login 登录） > ');
});

test('子界面提问失败时仍恢复历史快照', async () => {
  const failure = new DOMException('取消', 'AbortError');
  const rl = fakeReadline(['主页命令'], '未完成输入', failure);
  await assert.rejects(ask(rl, '> '), failure);
  assert.deepEqual(rl.history, ['主页命令']);
});

test('歌单播放器按 q 返回调用它的父页面', () => {
  assert.equal(playlistPlaybackDestination('quit'), null);
  assert.equal(playlistPlaybackDestination('stopped'), null);
  assert.equal(playlistPlaybackDestination('smtc_stop'), null);
  assert.equal(playlistPlaybackDestination('ended'), null);
});
