import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCookie, normalizeSong, parseIdCommand, parseLoginCommand, parseLyricAction,
  parseLyricDirectCommand, parseLyricFormatSelection, parseLyricSearchCommand, parseNumberSelection
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

test('识别歌词输出语法', () => {
  assert.deepEqual(parseLyricAction('歌词'), { output: null });
  assert.deepEqual(parseLyricAction('/lyric'), { output: null });
  assert.deepEqual(parseLyricAction('l > song.txt'), { output: 'song.txt' });
  assert.deepEqual(parseLyricAction('lyric | song.lrc'), { output: 'song.lrc' });
});

test('识别歌词 ID 直出命令', () => {
  assert.deepEqual(parseLyricDirectCommand('/lyrc 347230'), { id: '347230', format: 'plain', output: null });
  assert.deepEqual(parseLyricDirectCommand('/lyrc 347230 all > output.lrc'), { id: '347230', format: 'all', output: 'output.lrc' });
  assert.equal(parseLyricDirectCommand('/lyrc abc'), null);
});

test('识别歌词搜索及尾部格式', () => {
  assert.deepEqual(parseLyricSearchCommand('/lyric 风雨里追赶'), { query: '风雨里追赶', format: null, output: null });
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
