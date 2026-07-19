import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCookie, normalizeSong, parseIdCommand, parseLoginCommand,
  parseLyricDirectCommand, parseLyricFormatSelection, parseLyricSearchCommand, parseNumberSelection,
  parseListPlaylistsCommand, parseOffsetCommand, parsePlaylistCommand, parsePlayerCommand, parseImageCommand, parseQualityCommand,
  parseSignoutCommand, parseClearCommand, parseApiCommand, parseCacheCommand, parseClearCacheCommand
} from '../src/parsers.js';

test('识别所有约定的 ID 点歌语法', () => {
  for (const input of ['id:123', 'ID:123', 'id=123', 'id 123', '/id 123', '/ID=123']) {
    assert.equal(parseIdCommand(input), '123', input);
  }
  assert.equal(parseIdCommand('idabc'), null);
});

test('识别登录命令及 Cookie', () => {
  assert.deepEqual(parseLoginCommand('/login'), { action: 'qr', cookie: null });
  assert.deepEqual(parseLoginCommand('/login status'), { action: 'status', cookie: null });
  assert.deepEqual(parseLoginCommand('/login MUSIC_U=abc; __csrf=def'), { action: 'cookie', cookie: 'MUSIC_U=abc; __csrf=def' });
});

test('识别登出命令', () => {
  assert.equal(parseSignoutCommand('/signout'), true);
  assert.equal(parseSignoutCommand(' /SIGNOUT '), true);
  assert.equal(parseSignoutCommand('/signout now'), false);
});

test('识别清屏命令', () => {
  assert.equal(parseClearCommand('/clear'), true);
  assert.equal(parseClearCommand(' /CLEAR '), true);
  assert.equal(parseClearCommand('/clear now'), false);
  assert.equal(parseClearCommand('clear'), false);
});

test('识别缓存设置和分类清理命令', () => {
  assert.deepEqual(parseCacheCommand('/cache'), { megabytes: null });
  assert.deepEqual(parseCacheCommand('/cache 500'), { megabytes: 500 });
  assert.deepEqual(parseClearCacheCommand('/clrcache'), { group: null });
  assert.deepEqual(parseClearCacheCommand('/clrcache covers'), { group: 'covers' });
  assert.deepEqual(parseClearCacheCommand('/CLRCACHE MUSICS'), { group: 'musics' });
  assert.equal(parseClearCacheCommand('/clrcache all'), null);
});

test('识别歌单命令', () => {
  assert.equal(parseListPlaylistsCommand('/lspl'), true);
  assert.equal(parseListPlaylistsCommand(' /LSPL '), true);
  assert.equal(parseListPlaylistsCommand('/lspl 1'), false);
  assert.equal(parsePlaylistCommand('/pl 123456'), '123456');
  assert.equal(parsePlaylistCommand(' /PL 123456 '), '123456');
  assert.equal(parsePlaylistCommand('/pl'), null);
  assert.equal(parsePlaylistCommand('/pl abc'), null);
});

test('识别音质命令', () => {
  assert.deepEqual(parseQualityCommand('/quality'), { level: null });
  assert.deepEqual(parseQualityCommand('/QUALITY LossLess'), { level: 'lossless' });
  assert.deepEqual(parseQualityCommand('/quality invalid value'), { level: 'invalid value' });
  assert.equal(parseQualityCommand('quality lossless'), null);
});

test('识别播放器后端命令', () => {
  assert.deepEqual(parsePlayerCommand('/player'), { backend: null });
  assert.deepEqual(parsePlayerCommand('/PLAYER VLC'), { backend: 'vlc' });
  assert.deepEqual(parsePlayerCommand('/player invalid value'), { backend: 'invalid value' });
  assert.equal(parsePlayerCommand('player mpv'), null);
});

test('识别图片协议命令', () => {
  assert.deepEqual(parseImageCommand('/image'), { protocol: null });
  assert.deepEqual(parseImageCommand('/IMAGE SIXEL'), { protocol: 'sixel' });
  assert.deepEqual(parseImageCommand('/image ansi256'), { protocol: 'ansi256' });
  assert.deepEqual(parseImageCommand('/image invalid value'), { protocol: 'invalid value' });
  assert.equal(parseImageCommand('image ansi'), null);
});

test('识别歌词偏移命令并报告非法参数', () => {
  assert.deepEqual(parseOffsetCommand('/offset'), { milliseconds: null });
  assert.deepEqual(parseOffsetCommand('/OFFSET +2000'), { milliseconds: 2000 });
  assert.deepEqual(parseOffsetCommand('/offset -750'), { milliseconds: -750 });
  assert.deepEqual(parseOffsetCommand('/offset 1.5'), {
    milliseconds: null,
    error: '播放时间偏移量必须是整数毫秒'
  });
  assert.equal(parseOffsetCommand('offset 2000'), null);
});


test('识别 API 地址命令', () => {
  assert.deepEqual(parseApiCommand('/api'), { url: null });
  assert.deepEqual(parseApiCommand('/API https://api.example.com/prefix'), {
    url: 'https://api.example.com/prefix'
  });
  assert.equal(parseApiCommand('api https://api.example.com'), null);
});

test('识别歌词 ID 直出命令', () => {
  assert.deepEqual(parseLyricDirectCommand('/idlyric 347230'), { id: '347230', format: 'plain', output: null });
  assert.deepEqual(parseLyricDirectCommand('/idlyric 347230 all > output.lrc'), { id: '347230', format: 'all', output: 'output.lrc' });
  assert.equal(parseLyricDirectCommand('/idlyric abc'), null);
  assert.equal(parseLyricDirectCommand('/lyrc 347230'), null);
});

test('识别歌词搜索及尾部格式', () => {
  assert.deepEqual(parseLyricSearchCommand('/lyric 风雨里追赶'), { query: '风雨里追赶', format: null, output: null });
  assert.deepEqual(parseLyricSearchCommand('/lyric 347230'), { query: '347230', format: null, output: null });
  assert.deepEqual(parseLyricSearchCommand('/lyric 风雨里追赶 trans > out.lrc'), { query: '风雨里追赶', format: 'trans', output: 'out.lrc' });
  assert.deepEqual(parseLyricSearchCommand('/lyrics all'), { query: 'all', format: null, output: null });
});

test('结果与格式选项支持 q 和输出重定向', () => {
  assert.deepEqual(parseNumberSelection('1 > output.lrc'), { quit: false, index: 0, output: 'output.lrc' });
  assert.deepEqual(parseNumberSelection('q'), { quit: true, index: null, output: null });
  assert.deepEqual(parseLyricFormatSelection('4 > merged.lrc'), { quit: false, format: 'all', output: 'merged.lrc' });
  assert.deepEqual(parseLyricFormatSelection('lrc'), { quit: false, format: 'lrc', output: null });
});

test('Cookie 清理换行并验证基本格式', () => {
  assert.equal(normalizeCookie('"MUSIC_U=abc;\r\n__csrf=def"'), 'MUSIC_U=abc; __csrf=def');
  assert.equal(
    normalizeCookie('MUSIC_U=old; Max-Age=10; Expires=Wed, 15 Jul 2026 00:00:00 GMT; Path=/;; MUSIC_U=new; HttpOnly; NMTID=id'),
    'MUSIC_U=new; NMTID=id'
  );
  assert.throws(() => normalizeCookie('abc'));
});

test('兼容搜索与详情的两种歌曲字段', () => {
  assert.deepEqual(normalizeSong({ id: 1, name: '歌', artists: [{ name: '人' }], album: { name: '碟' }, duration: 10 }), {
    id: '1', name: '歌', artists: ['人'], album: '碟', cover: null, durationMs: 10, fee: null
  });
});
