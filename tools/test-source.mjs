import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizePlayInfo, safeMediaUrl, mediaUrls, safeFilename, readSourcePage } from '../extension/lib/site-api.js';

// These are invented schema fixtures. Passing this suite proves structural
// handling and offline regressions, not current site API availability.
const metadata = JSON.parse(await readFile(new URL('./fixtures/metadata.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('./fixtures/playinfo.json', import.meta.url), 'utf8'));
const video = {
  bvid: metadata.initialState.bvid,
  title: metadata.initialState.videoData.title,
  page: 1,
  part: metadata.initialState.videoData.pages[0].part,
  pages: metadata.initialState.videoData.pages,
  duration: metadata.initialState.videoData.pages[0].duration
};
const copy = value => structuredClone(value);

test('公开 fixtures 明确标记为合成数据，不含用户信息或有效 CDN 签名', () => {
  assert.equal(metadata.fixture.kind, 'synthetic');
  assert.equal(fixture.fixture.kind, 'synthetic');
  assert.equal(video.bvid, 'BV1xx411c7mD');
  assert.equal(video.title, '公开视频示例');
  assert.equal(video.pages.length, 10);
  assert.equal(video.pages[0].cid, 279786);
  assert.equal(video.pages[1].cid, 279787);
  assert.equal(metadata.initialState.videoData.owner, undefined);
  assert.equal(metadata.initialState.videoData.stat, undefined);
  assert.equal(metadata.initialState.videoData.desc, undefined);
  for (const track of [...fixture.response.data.dash.video, ...fixture.response.data.dash.audio]) {
    for (const address of mediaUrls(track)) {
      const url = new URL(address);
      assert.ok(url.pathname.startsWith('/synthetic/'));
      assert.deepEqual([...url.searchParams], [['fixture', 'synthetic']]);
    }
  }
});

test('合成数据已解包后保持可用，不将 result 状态字符串当作响应体', () => {
  const options = normalizePlayInfo(video, fixture.response.data);
  assert.equal(options.length, 1);
  assert.equal(options[0].quality, 16);
  assert.equal(options[0].codec, 'H.264');
  assert.ok(options[0].audioUrl);
});

test('合成响应只含实际返回的 360P，并生成有声 H.264 下载选项', () => {
  const options = normalizePlayInfo(video, fixture.response);
  assert.equal(options.length, 1);
  assert.deepEqual(options.map(item => item.quality), [16]);
  const option = options[0];
  assert.equal(option.kind, 'dash');
  assert.equal(option.codec, 'H.264');
  assert.equal(option.width, 512);
  assert.equal(option.height, 288);
  assert.match(option.videoUrl, /279786_da3-1-30016\.m4s\?/);
  assert.match(option.audioUrl, /279786_da3-1-30216\.m4s\?/);
  assert.ok(option.estimatedBytes > 6_000_000 && option.estimatedBytes < 8_000_000);
});

test('响应宣传更多清晰度时，列表仍只显示实际可下载的清晰度', () => {
  const response = copy(fixture.response);
  response.data.accept_quality = [80, 64, 16];
  response.data.accept_description = ['1080P', '720P', '360P'];
  assert.deepEqual(normalizePlayInfo(video, response).map(item => item.quality), [16]);
});

test('音轨选择保持 AAC，忽略非 AAC 音轨，即使后者码率更大', () => {
  const response = copy(fixture.response);
  const aac = response.data.dash.audio[0];
  response.data.dash.audio.unshift({ ...aac, codecs: 'opus', bandwidth: 9_000_000, baseUrl: 'https://cdn.bilivideo.com/other-audio.m4s', base_url: undefined });
  assert.match(normalizePlayInfo(video, response)[0].audioUrl, /279786_da3-1-30216\.m4s\?/);
});

test('蛇形字段的官方 CDN 地址也能产生相同下载结果', () => {
  const response = copy(fixture.response);
  for (const track of [...response.data.dash.video, ...response.data.dash.audio]) {
    delete track.baseUrl;
    delete track.backupUrl;
  }
  const options = normalizePlayInfo(video, response);
  assert.equal(options.length, 1);
  assert.match(options[0].videoUrl, /30016\.m4s\?/);
  assert.match(options[0].audioUrl, /30216\.m4s\?/);
});

test('Windows 文件名保留中文、分P和扩展名，同时移除非法字符', () => {
  const filename = safeFilename({ ...video, title: '中文<>:"/\\|?*\u0000\u001f标题', page: 2, part: '测试/第二集' });
  assert.ok(filename.startsWith('中文'));
  assert.match(filename, /P2/);
  assert.match(filename, /第二集/);
  assert.match(filename, /\.mp4$/);
  assert.doesNotMatch(filename, /[<>:"/\\|?*\u0000-\u001f\u007f]/);
});

test('Windows 保留设备名和空标题也生成可保存的文件名', () => {
  for (const title of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'CON.txt']) {
    const filename = safeFilename({ title });
    assert.ok(filename.startsWith('_'), `${title} needs a safe filename`);
    assert.match(filename, /\.mp4$/);
  }
  assert.match(safeFilename({}), /^.+\.mp4$/);
  assert.ok(safeFilename({ title: '长'.repeat(300) }).length <= 155);
});

test('合成 CDN 地址验证 来源站点及 Akamai 域名规则，不发起网络请求', () => {
  for (const track of [...fixture.response.data.dash.video, ...fixture.response.data.dash.audio]) {
    for (const url of [track.baseUrl, ...(track.backupUrl || [])]) assert.ok(safeMediaUrl(url), new URL(url).hostname);
  }
  assert.equal(safeMediaUrl('http://cdn.bilivideo.com/a.mp4'), 'https://cdn.bilivideo.com/a.mp4');
});

test('拒绝外站、伪装子域、用户凭据、端口和非网络下载地址', () => {
  for (const url of [
    'https://evil.example/a.mp4',
    'https://bilivideo.com.evil.example/a.mp4',
    'https://evil-bilivideo.com/a.mp4',
    'https://bilivideo.com@evil.example/a.mp4',
    'https://user@cdn.bilivideo.com/a.mp4',
    'https://user:secret@cdn.bilivideo.com/a.mp4',
    'https://cdn.bilivideo.com:8443/a.mp4',
    'file:///C:/secret.mp4',
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'not a URL'
  ]) assert.equal(safeMediaUrl(url), null, url);
  assert.deepEqual(mediaUrls({ baseUrl: 'https://evil.example/a.mp4', backupUrl: ['https://cdn.bilivideo.com/a.mp4'] }), ['https://cdn.bilivideo.com/a.mp4']);
});

test('单文件有声 MP4 直接下载，只显示实际返回清晰度', () => {
  const options = normalizePlayInfo(video, { code: 0, data: {
    format: 'mp4', quality: 16, timelength: 199333,
    accept_quality: [80, 64, 16], accept_description: ['1080P', '720P', '360P'],
    durl: [{ size: 6948762, url: 'https://cdn.bilivideo.com/279786_da3-1-16.mp4' }]
  } });
  assert.equal(options.length, 1);
  assert.equal(options[0].quality, 16);
  assert.equal(options[0].kind, 'direct');
  assert.equal(options[0].estimatedBytes, 6948762);
  assert.equal(options[0].videoUrl, 'https://cdn.bilivideo.com/279786_da3-1-16.mp4');
  assert.equal(options[0].audioUrl, undefined);
});

test('缺失或不支持的音轨明确报错，不生成无声视频选项', () => {
  for (const audio of [[], undefined, [{ codecs: 'opus', baseUrl: 'https://cdn.bilivideo.com/audio.m4s' }]]) {
    const response = copy(fixture.response);
    response.data.dash.audio = audio;
    assert.throws(() => normalizePlayInfo(video, response), /音轨/);
  }
});

test('受保护的视频明确报错', () => {
  for (const property of ['is_drm', 'drm_tech_type', 'drm']) {
    const response = copy(fixture.response);
    response.data[property] = 1;
    assert.throws(() => normalizePlayInfo(video, response), /受保护/);
  }
});

test('未提供资源时给出可操作错误', () => {
  assert.throws(() => normalizePlayInfo(video, { code: 0, data: {} }), /没有可用.*MP4|播放后重新识别/);
});

async function pageResult({ url = `https://www.bilibili.com/video/${video.bvid}/`, initial = metadata.initialState, playinfo, responder } = {}) {
  const requests = [];
  const result = await vm.runInNewContext(`(${readSourcePage.toString()})()`, {
    location: new URL(url),
    window: { __INITIAL_STATE__: copy(initial), __playinfo__: playinfo && copy(playinfo) },
    document: { title: video.title },
    URL, AbortController, setTimeout, clearTimeout,
    fetch: async (request, options) => {
      requests.push({ url: request, credentials: options.credentials });
      if (responder) return responder(request, options);
      return { ok: true, json: async () => copy(fixture.response) };
    }
  });
  return { result, requests };
}

test('合成十P元数据按当前页面 P2 读取，并请求带凭据的页面 API', async () => {
  const { result, requests } = await pageResult({ url: `https://www.bilibili.com/video/${video.bvid}/?p=2` });
  assert.equal(result.ok, true);
  assert.equal(result.video.page, 2);
  assert.equal(result.video.cid, 279787);
  assert.equal(result.video.part, '示例分P 2');
  assert.equal(new URL(requests[0].url).searchParams.get('cid'), '279787');
  assert.ok(requests.every(item => item.credentials === 'include'));
});

test('SPA 切换视频后不复用上个视频的元数据', async () => {
  const stale = copy(metadata.initialState);
  stale.videoData.bvid = 'BV1stale41111';
  stale.videoData.title = '旧视频';
  const { result, requests } = await pageResult({ initial: stale, responder: async request => ({
    ok: true,
    json: async () => request.includes('/x/web-interface/view')
      ? { code: 0, data: copy(metadata.initialState.videoData) }
      : copy(fixture.response)
  }) });
  assert.equal(result.ok, true);
  assert.equal(result.video.title, video.title);
  assert.match(requests[0].url, /\/x\/web-interface\/view\?/);
});

test('无效分P与非 来源站点普通视频页面给出明确错误', async () => {
  for (const url of [`https://www.bilibili.com/video/${video.bvid}/?p=999`, `https://evil.example/video/${video.bvid}/`]) {
    const { result } = await pageResult({ url });
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
});

test('请求失败时拒绝无法证明属于当前分P的 __playinfo__ 缓存', async () => {
  const stalePlayinfo = copy(fixture.response);
  for (const stream of [...stalePlayinfo.data.dash.video, ...stalePlayinfo.data.dash.audio]) {
    stream.baseUrl = stream.base_url = `https://cdn.bilivideo.com/synthetic/279787/279787_${stream.id}.m4s?fixture=synthetic`;
    stream.backupUrl = stream.backup_url = [];
  }
  const { result } = await pageResult({ playinfo: stalePlayinfo, responder: async () => ({ ok: false, status: 412 }) });
  assert.equal(result.ok, false, 'A stale P2 stream must not be offered as the P1 video.');
  assert.match(result.error, /请求|重试|限制/);
});
