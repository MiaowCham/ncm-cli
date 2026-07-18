import test from 'node:test';
import assert from 'node:assert/strict';
import { commandCompleter, SLASH_COMMANDS } from '../src/completion.js';
import { IMAGE_PROTOCOLS, PLAYER_BACKENDS, QUALITY_LEVELS } from '../src/parsers.js';

test('斜杠命令可按前缀补全', () => {
  assert.deepEqual(commandCompleter('/'), [SLASH_COMMANDS, '/']);
  assert.deepEqual(commandCompleter('/idly'), [['/idlyric'], '/idly']);
  assert.deepEqual(commandCompleter('/qu'), [['/quality', '/quit'], '/qu']);
  assert.deepEqual(commandCompleter('/cle'), [['/clear'], '/cle']);
  assert.equal(SLASH_COMMANDS.includes('/smtcoffset'), false);
  assert.deepEqual(commandCompleter('/smtc'), [[], '/smtc']);
});

test('命令补全不干扰普通搜索和未知命令', () => {
  assert.deepEqual(commandCompleter('晴天'), [[], '晴天']);
  assert.deepEqual(commandCompleter('/unknown'), [[], '/unknown']);
  assert.deepEqual(commandCompleter('/id 123'), [[], '/id 123']);
});

test('/quality 补全所有音质参数并保留命令前缀', () => {
  assert.deepEqual(
    commandCompleter('/quality '),
    [QUALITY_LEVELS.map((level) => `/quality ${level}`), '/quality ']
  );
  assert.deepEqual(commandCompleter('/quality loss'), [['/quality lossless'], '/quality loss']);
  assert.deepEqual(commandCompleter('/QUALITY jy'), [
    ['/QUALITY jyeffect', '/QUALITY jymaster'],
    '/QUALITY jy'
  ]);
});

test('/player 补全播放器后端', () => {
  assert.deepEqual(
    commandCompleter('/player '),
    [PLAYER_BACKENDS.map((backend) => `/player ${backend}`), '/player ']
  );
  assert.deepEqual(commandCompleter('/player v'), [['/player vlc'], '/player v']);
});

test('/image 补全图片协议', () => {
  assert.deepEqual(commandCompleter('/image '), [
    IMAGE_PROTOCOLS.map((protocol) => `/image ${protocol}`), '/image '
  ]);
  assert.deepEqual(commandCompleter('/image s'), [['/image sixel', '/image symbols'], '/image s']);
});

test('/login 补全 status 参数', () => {
  assert.deepEqual(commandCompleter('/login s'), [['/login status'], '/login s']);
  assert.deepEqual(commandCompleter('/login cookie=value'), [[], '/login cookie=value']);
});

test('歌词命令在查询或 ID 后补全格式', () => {
  assert.deepEqual(commandCompleter('/idlyric 347230 l'), [
    ['/idlyric 347230 lrc'],
    '/idlyric 347230 l'
  ]);
  assert.deepEqual(commandCompleter('/idlyric 347230 '), [
    ['plain', 'lrc', 'trans', 'all'].map((format) => `/idlyric 347230 ${format}`),
    '/idlyric 347230 '
  ]);
  assert.deepEqual(commandCompleter('/lyric 晴天 tr'), [
    ['/lyric 晴天 trans'],
    '/lyric 晴天 tr'
  ]);
  assert.deepEqual(commandCompleter('/lyric 晴 天 '), [
    ['plain', 'lrc', 'trans', 'all'].map((format) => `/lyric 晴 天 ${format}`),
    '/lyric 晴 天 '
  ]);
  assert.deepEqual(commandCompleter('/lyric p'), [[], '/lyric p']);
});

test('补全保留前导空格和原命令大小写', () => {
  assert.deepEqual(commandCompleter('  /LOG'), [['  /login'], '  /LOG']);
  assert.deepEqual(commandCompleter('  /LOGIN s'), [['  /LOGIN status'], '  /LOGIN s']);
});
