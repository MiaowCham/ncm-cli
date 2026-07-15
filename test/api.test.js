import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { NcmApi, normalizeApiBaseUrl } from '../src/api.js';

test('API 地址必须显式配置并规范化', () => {
  assert.throws(() => new NcmApi(), /尚未配置 API 地址/);
  assert.equal(normalizeApiBaseUrl(' https://api.example.com/prefix/// '), 'https://api.example.com/prefix');
  assert.equal(normalizeApiBaseUrl('http://localhost:3000/'), 'http://localhost:3000');
  assert.equal(normalizeApiBaseUrl('http://192.168.1.8:3000/api/'), 'http://192.168.1.8:3000/api');
  assert.equal(normalizeApiBaseUrl('http://api.example.com:3000/'), 'http://api.example.com:3000');
  assert.throws(() => normalizeApiBaseUrl('ftp://example.com'), /仅支持 http 或 https/);
  assert.throws(() => normalizeApiBaseUrl('https://user:pass@example.com'), /用户名或密码/);
  assert.throws(() => normalizeApiBaseUrl('https://example.com/api?q=1'), /查询参数或片段/);
  assert.throws(() => normalizeApiBaseUrl('https://example.com/api#doc'), /查询参数或片段/);
});

test('可以在运行时更换 API 地址', () => {
  const api = new NcmApi({ baseUrl: 'https://one.example.com/' });
  api.setBaseUrl('https://two.example.com/prefix/');
  assert.equal(api.baseUrl, 'https://two.example.com/prefix');
  assert.throws(() => api.setBaseUrl('file:///tmp/api'), /仅支持 http 或 https/);
});

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

test('API 地址的路径前缀会保留在请求中', async () => {
  let receivedUrl;
  const server = http.createServer((request, response) => {
    receivedUrl = request.url;
    response.setHeader('content-type', 'application/json');
    response.end('{"code":200}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${port}/api-enhanced` });
    await api.request('/probe', { query: 'ok' });
    assert.match(receivedUrl, /^\/api-enhanced\/probe\?/);
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

test('播放接口无 URL 时保留诊断 code', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"data":[{"id":1,"code":404,"url":null}]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const result = await api.songUrl('1');
    assert.equal(result.url, null);
    assert.equal(result.code, 404);
    assert.equal(result.attempts.length, 2);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('新版播放接口使用当前音质等级', async () => {
  let requestUrl;
  const server = http.createServer((request, response) => {
    requestUrl = request.url;
    response.setHeader('content-type', 'application/json');
    response.end('{"data":[{"id":1,"code":200,"url":"https://example.test/song.flac"}]}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}`, quality: 'lossless' });
    await api.songUrl('1');
    assert.match(requestUrl, /(?:\?|&)level=lossless(?:&|$)/);
    api.setQuality('hires');
    await api.songUrl('2');
    assert.match(requestUrl, /(?:\?|&)level=hires(?:&|$)/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('登录状态同时校验 account 和 profile', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{"data":{"code":200,"account":{"id":1},"profile":{"nickname":"tester"}}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const status = await api.loginStatus();
    assert.equal(status.loggedIn, true);
    assert.equal(status.profile.nickname, 'tester');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('用户等级与登出接口返回结构化结果', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(request.url.startsWith('/user/level')
      ? '{"code":200,"data":{"level":9,"listenSongs":1234}}'
      : '{"code":200}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await api.userLevel(), { level: 9, listenSongs: 1234 });
    assert.deepEqual(await api.logout(), { code: 200 });
    assert.equal(requests.length, 2);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('外部 AbortSignal 可以取消进行中的 API 请求', async () => {
  const server = http.createServer((request, response) => {
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end('{"code":200}');
    }, 1000);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const controller = new AbortController();
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const pending = api.request('/slow', {}, { signal: controller.signal });
    controller.abort(new DOMException('test abort', 'AbortError'));
    await assert.rejects(pending, (error) => error.name === 'AbortError');
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

test('用户歌单标准化，并将喜欢的音乐稳定置顶', async () => {
  let requestUrl;
  const server = http.createServer((request, response) => {
    requestUrl = request.url;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ playlist: [
      { id: 1, name: '普通一', creator: { userId: 7, nickname: '用户' }, trackCount: 2 },
      { id: 2, name: '测试喜欢的音乐', specialType: 0, coverImgUrl: 'https://img.test/2.jpg' },
      { id: 3, name: '普通二' },
      { id: 4, name: '收藏', specialType: 5 }
    ] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const playlists = await api.userPlaylists('7');
    assert.deepEqual(playlists.map((playlist) => playlist.id), ['2', '4', '1', '3']);
    assert.equal(playlists[0].cover, 'https://img.test/2.jpg');
    assert.deepEqual(playlists[2].creator, { id: '7', nickname: '用户', avatar: null });
    assert.match(requestUrl, /(?:\?|&)uid=7(?:&|$)/);
    assert.match(requestUrl, /(?:\?|&)limit=1000(?:&|$)/);
    assert.match(requestUrl, /(?:\?|&)offset=0(?:&|$)/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('用户歌单按 more 分页，并在重复页停止', async () => {
  const offsets = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, '/user/playlist');
    assert.equal(url.searchParams.get('uid'), '7');
    assert.equal(url.searchParams.get('limit'), '2');
    const offset = Number(url.searchParams.get('offset'));
    offsets.push(offset);
    const pages = {
      0: [{ id: 1, name: '普通一' }, { id: 2, name: '普通二' }],
      2: [{ id: 3, name: '用户喜欢的音乐' }, { id: 4, name: '普通三' }],
      4: [{ id: 3, name: '用户喜欢的音乐' }, { id: 4, name: '普通三' }]
    };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ playlist: pages[offset] || [], more: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const playlists = await api.userPlaylists('7', { pageSize: 2 });
    assert.deepEqual(offsets, [0, 2, 4]);
    assert.deepEqual(playlists.map((playlist) => playlist.id), ['3', '1', '2', '4']);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('歌单详情标准化元数据和预览歌曲', async () => {
  let requestUrl;
  const server = http.createServer((request, response) => {
    requestUrl = request.url;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ playlist: {
      id: 88, name: '测试歌单', coverImgUrl: 'https://img.test/cover.jpg', description: '说明',
      creator: { userId: 9, nickname: '创建者' }, trackCount: 1, playCount: 12,
      tracks: [{ id: 10, name: '歌曲', ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 1000 }]
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const playlist = await api.playlistDetail('88');
    assert.equal(playlist.id, '88');
    assert.equal(playlist.playCount, 12);
    assert.deepEqual(playlist.tracks.map((song) => song.id), ['10']);
    assert.match(requestUrl, /^\/playlist\/detail\?/);
    assert.match(requestUrl, /(?:\?|&)id=88(?:&|$)/);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('完整歌单歌曲分页获取，并在重复页停止', async () => {
  const offsets = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    assert.equal(url.pathname, '/playlist/track/all');
    assert.equal(url.searchParams.get('id'), '88');
    offsets.push(Number(url.searchParams.get('offset')));
    const offset = Number(url.searchParams.get('offset'));
    const ids = offset === 0 ? [1, 2] : [2, 3];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ songs: ids.map((id) => ({
      id, name: `歌曲${id}`, ar: [{ name: '歌手' }], al: { name: '专辑' }, dt: 1000
    })) }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const api = new NcmApi({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    const songs = await api.playlistTracks('88', { pageSize: 2, maxTracks: 10 });
    assert.deepEqual(songs.map((song) => song.id), ['1', '2', '3']);
    assert.deepEqual(offsets, [0, 2, 4]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
