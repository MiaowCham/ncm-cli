import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNeteaseMusicInput, resolveNeteaseMusicInput } from '../src/music-link.js';

test('解析分享文本、长链接和追踪参数中的歌曲与歌单', () => {
  const cases = [
    ['分享三Z-STUDIO/HOYO-MiX/Gin Wigmore的单曲《预言》:\u00a0https://music.163.com/#/song?id=3402223603\u00a0(来自@网易云音乐)', { type: 'song', id: '3402223603' }],
    ['分享歌单: 喵锵Miaow喜欢的音乐 喵锵Miaow https://music.163.com/m/playlist?id=5322698541&creatorId=3962947042', { type: 'playlist', id: '5322698541' }],
    ['https://music.163.com/#/song?id=3402223603&uct2=x&fx-wechatnew=t1', { type: 'song', id: '3402223603' }],
    ['https://music.163.com/m/playlist?id=5322698541', { type: 'playlist', id: '5322698541' }],
    ['https://y.music.163.com/m/song?id=3402223603&sc=wm', { type: 'song', id: '3402223603' }]
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseNeteaseMusicInput(input), expected, input);
});

test('识别固定域名的 HTTPS 短链接并拒绝相似域名', () => {
  assert.deepEqual(parseNeteaseMusicInput('https://163cn.tv/bbfdtl4C'), {
    type: 'short', url: 'https://163cn.tv/bbfdtl4C'
  });
  assert.equal(parseNeteaseMusicInput('https://163cn.tv.example/bbfdtl4C'), null);
  assert.equal(parseNeteaseMusicInput('http://163cn.tv/bbfdtl4C'), null);
});

test('短链接跟随重定向并解析最终歌曲链接', async () => {
  let requested;
  const result = await resolveNeteaseMusicInput('分享：https://163cn.tv/bbfdtl4C', {
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return {
        url: 'https://y.music.163.com/m/song?id=3402223603&uct2=tracking',
        body: { cancel: async () => {} }
      };
    }
  });
  assert.deepEqual(result, { type: 'song', id: '3402223603' });
  assert.equal(requested.url, 'https://163cn.tv/bbfdtl4C');
  assert.equal(requested.options.redirect, 'follow');
});
