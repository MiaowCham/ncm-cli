import test from 'node:test';
import assert from 'node:assert/strict';
import { ask, detailFooterPrompt, detailOverlaySequence, playlistPlaybackDestination, playlistPreviewLimit, songDetailFooterLines, songDetailPrompt, songLyricPreview, songLyricPreviewRemaining } from '../src/cli.js';

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
  assert.equal(playlistPreviewLimit(24, 0, false), 14);
  assert.equal(playlistPreviewLimit(40, 0, false), 30);
  assert.equal(playlistPreviewLimit(24, 8, true), 5);
  assert.equal(playlistPreviewLimit(8, 20, true), 1);
});

test('详情操作区从屏幕底部向上覆盖而不滚动顶部', () => {
  assert.equal(detailOverlaySequence(24, 5), '\x1b[20;1H\x1b[0J');
  assert.equal(detailOverlaySequence(10, 20), '\x1b[1;1H\x1b[0J');
});

test('链接开关为提示符下方固定预留两行', () => {
  assert.equal(
    detailFooterPrompt('操作', ['链接一', '链接二'], 24, 80),
    '\x1b[22;1H\x1b[0J操作\n链接一\n链接二'
  );
});

test('歌曲详情歌词预览按可用行数裁剪并去除时间标签', () => {
  assert.deepEqual(songLyricPreview({ original: '[00:01.00]第一行\n[00:02.00]第二行\n第三行' }, 2), [
    '第一行', '第二行'
  ]);
  assert.deepEqual(songLyricPreview(null, 5), []);
  assert.equal(songLyricPreviewRemaining({ original: '第一行\n第二行\n第三行' }, 2), 1);
  assert.equal(songLyricPreviewRemaining({ original: '第一行' }, 2), 0);
});

test('歌曲详情只为登录用户显示可切换的收藏按钮', () => {
  assert.equal(songDetailPrompt().includes('收藏'), false);
  assert.match(songDetailPrompt({ loggedIn: true }), /\[f\]收藏/);
  assert.match(songDetailPrompt({ loggedIn: true, favorited: true }), /\[f\]取消收藏/);
});

test('Credits EX 歌曲详情显示推荐字体并保留链接行', () => {
  assert.deepEqual(songDetailFooterLines({ id: 1 }, ['播放链接']), ['播放链接']);
  assert.deepEqual(songDetailFooterLines({ id: 405372425 }, ['播放链接']), [
    '推荐使用字体：NCM Credits VGA16（见 assets/fonts）',
    '播放链接'
  ]);
});

test('主页输入保留在 readline 历史', async () => {
  const rl = fakeReadline(['旧搜索'], '新搜索');
  assert.equal(await ask(rl, '> ', undefined, { recordHistory: true }), '新搜索');
  assert.deepEqual(rl.history, ['新搜索', '旧搜索']);
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
