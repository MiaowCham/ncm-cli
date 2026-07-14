import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { NcmApi } from '../src/api.js';

test('Cookie 只通过 header 发送，不进入 URL', async () => {
  let received;
  const server = http.createServer((request, response) => {
    received = { url: request.url, cookie: request.headers.cookie };
    response.setHeader('content-type', 'application/json');
    response.end('{"code":200}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${port}`, cookie: 'MUSIC_U=secret' });
    await api.request('/probe', { query: 'ok' });
    assert.equal(received.cookie, 'MUSIC_U=secret');
    assert.doesNotMatch(received.url, /secret|cookie|MUSIC_U/i);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('歌词搜索兼容字符串命中片段并移除 HTML', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ result: { songs: [{
      id: 1, name: '测试歌', ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 1000,
      lyrics: ['<b>风雨里追赶</b> 雾里分不清影踪']
    }] } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const songs = await api.searchLyrics('风雨里追赶');
    assert.deepEqual(songs[0].lyricMatches, ['风雨里追赶 雾里分不清影踪']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('新版播放接口失败时回退旧接口', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url.startsWith('/song/url/v1')) {
      response.statusCode = 500;
      response.end('{"message":"temporary"}');
    } else {
      response.end('{"data":[{"id":1,"code":200,"url":"https://example.test/song.mp3"}]}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.equal((await api.songUrl('1')).url, 'https://example.test/song.mp3');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
