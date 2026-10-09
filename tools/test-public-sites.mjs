import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicSite, publicMediaUrl } from '../extension/lib/public-sites.js';

function fixtureFetch(body, status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

test('Dailymotion public player preserves HLS master for encryption/audio validation', async () => {
  const { fetchImpl, calls } = fixtureFetch({ title: 'Public short', duration: 20, qualities: {
    auto: [{ type: 'application/x-mpegURL', url: 'https://media.example.com/master.m3u8' }]
  }});
  const result = await inspectPublicSite('https://www.dailymotion.com/video/x123abc_title', { fetchImpl });
  assert.equal(result.video.bvid, 'dailymotion:x123abc');
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].kind, 'hls');
  assert.equal(result.options[0].videoUrl, 'https://media.example.com/master.m3u8');
  assert.equal(result.options[0].extension, 'ts');
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
});

test('Progressive files take precedence and output known playable format metadata', async () => {
  const { fetchImpl } = fixtureFetch({ title: 'Public short', qualities: {
    720: [{ type: 'video/mp4', url: 'https://media.example.com/video.mp4', size: 1000 }],
    auto: [{ type: 'application/x-mpegURL', url: 'https://media.example.com/master.m3u8' }]
  }});
  const result = await inspectPublicSite('https://dai.ly/x123abc', { fetchImpl });
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].kind, 'direct');
  assert.equal(result.options[0].height, 720);
  assert.equal(result.options[0].estimatedBytes, 1000);
});

test('Vimeo verifies the returned clip identity and prefers progressive resources', async () => {
  const { fetchImpl, calls } = fixtureFetch({ video: { id: 12345, title: 'Example', duration: 9, thumbs: { 640: 'https://images.example.com/cover.jpg' } }, request: { files: {
    progressive: [{ quality: '360p', width: 640, height: 360, url: 'https://media.example.com/clip.mp4' }],
    hls: { cdns: { public: { url: 'https://media.example.com/master.m3u8' } } }
  }}});
  const result = await inspectPublicSite('https://player.vimeo.com/video/12345', { fetchImpl });
  assert.equal(result.video.bvid, 'vimeo:12345');
  assert.equal(result.options[0].kind, 'direct');
  assert.equal(calls[0].url, 'https://player.vimeo.com/video/12345/config');
  await assert.rejects(() => inspectPublicSite('https://vimeo.com/12346', { fetchImpl }), /不一致/);
});

test('Access limits and unavailable videos report true failures', async () => {
  for (const [body, status, pattern] of [
    [{ error: { message: 'Video unavailable' } }, 200, /Video unavailable/],
    [{ private: true }, 200, /访问权限/],
    [{}, 403, /拒绝/],
  ]) {
    const { fetchImpl } = fixtureFetch(body, status);
    await assert.rejects(() => inspectPublicSite('https://www.dailymotion.com/video/x123abc', { fetchImpl }), pattern);
  }
  const { fetchImpl } = fixtureFetch({ view: 4 });
  await assert.rejects(() => inspectPublicSite('https://vimeo.com/12345', { fetchImpl }), /密码/);
});

test('Public URLs exclude credentials, local addresses and unsafe metadata targets', async () => {
  for (const value of ['https://user:pass@media.example.com/a.mp4', 'file:///a.mp4', 'https://127.0.0.1/a.mp4',
    'http://2130706433/a.mp4', 'https://[::1]/a.mp4', 'https://server.local/a.mp4', 'https://localhost/a.mp4',
    'https://localhost./a.mp4', 'https://server.home.arpa./a.mp4', 'https://media.example.com:8443/a.mp4']) {
    assert.equal(publicMediaUrl(value), null);
  }
  const { fetchImpl } = fixtureFetch({ video: { id: 12345 }, request: { files: { progressive: [{ url: 'http://127.0.0.1/video.mp4' }] } } });
  await assert.rejects(() => inspectPublicSite('https://vimeo.com/12345', { fetchImpl }), /没有提供/);
  assert.equal(await inspectPublicSite('https://example.com/video', { fetchImpl: () => { throw new Error('must not fetch'); } }), null);
});
