import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCookie, normalizeSong, parseIdCommand, parseLoginCommand, parseLyricAction } from '../src/parsers.js';

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
