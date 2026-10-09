import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseXPostUrl, safeXMediaUrl, syndicationToken, normalizeXPlayInfo } from '../extension/lib/x.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/x-playinfo.json', import.meta.url), 'utf8'));
const source = `https://x.com/demo/status/${fixture.id_str}`;

test('公开帖子只展示可下载 MP4 的实际分辨率', () => {
  const result = normalizeXPlayInfo(source, fixture);
  assert.equal(result.ok, true);
  assert.deepEqual(result.options.map(option => option.quality), [720, 320]);
  assert.ok(result.options.every(option => option.kind === 'direct' && option.mimeType === 'video/mp4' && option.extension === 'mp4' && !option.allowNoAudio));
  assert.match(result.options[0].videoUrl, /720x720\/high\.mp4$/);
  assert.equal(result.video.duration, 4.5);
});

test('多媒体帖子默认视频明确显示当前媒体编号', () => {
  const result = normalizeXPlayInfo(source, fixture);
  assert.equal(result.video.cid, 1);
  assert.equal(result.video.mediaCount, 3);
  assert.equal(result.video.videoCount, 2);
  assert.match(result.video.title, /媒体 1\/3/);
  assert.match(result.warning, /媒体 1\/3/);
  assert.match(result.video.url, /\/video\/1$/);
});

test('照片不会改变 X video 编号，video/3 选择第三个原始媒体项', () => {
  const result = normalizeXPlayInfo(`${source}/video/3`, fixture);
  assert.equal(result.video.cid, 3);
  assert.equal(result.video.duration, 8);
  assert.match(result.video.title, /媒体 3\/3/);
  assert.match(result.options[0].videoUrl, /1900000000000000003\//);
  assert.equal(result.options[0].label, '480 × 852');
  assert.throws(() => normalizeXPlayInfo(`${source}/video/2`, fixture), /不是可下载视频/);
});

test('旧域名和 i/web/status 链接保留帖子 ID 与显式视频选择', () => {
  const parsed = parseXPostUrl(`https://twitter.com/i/web/status/${fixture.id_str}/video/3?s=20#ignore`);
  assert.equal(parsed.id, fixture.id_str);
  assert.equal(parsed.mediaIndex, 3);
  assert.equal(parsed.url, `https://x.com/i/web/status/${fixture.id_str}/video/3`);
});

test('伪装域名、凭据、自定义端口和非帖子链接不能触发获取', () => {
  for (const url of [
    `https://x.com.evil.example/demo/status/${fixture.id_str}`,
    `https://evil.example/demo/status/${fixture.id_str}`,
    `https://user@x.com/demo/status/${fixture.id_str}`,
    `https://x.com:8443/demo/status/${fixture.id_str}`,
    `http://x.com/demo/status/${fixture.id_str}`,
    `${source}/video/0`,
    `${source}/video/9007199254740992`,
    'https://x.com/demo',
    'javascript:alert(1)'
  ]) assert.throws(() => parseXPostUrl(url), undefined, url);
});

test('仅接受 video.twimg.com 的 HTTPS MP4 地址', () => {
  assert.equal(safeXMediaUrl('https://video.twimg.com/path/720x720/video.mp4?tag=12'), 'https://video.twimg.com/path/720x720/video.mp4?tag=12');
  for (const url of [
    'https://video.twimg.com.evil.example/video.mp4',
    'https://evil.example/video.mp4',
    'https://pbs.twimg.com/video.mp4',
    'https://user:secret@video.twimg.com/video.mp4',
    'https://video.twimg.com:8443/video.mp4',
    'http://video.twimg.com/video.mp4',
    'https://video.twimg.com/video.m3u8'
  ]) assert.equal(safeXMediaUrl(url), null, url);
});

test('返回另一帖子、只有引用帖视频或没有直链时明确拒绝', () => {
  assert.throws(() => normalizeXPlayInfo(source, { ...fixture, id_str: '1900000000000000009' }), /完整的视频信息/);
  assert.throws(() => normalizeXPlayInfo(source, { id_str: fixture.id_str, quoted_tweet: fixture }), /没有公开提供/);
  const hls = structuredClone(fixture);
  hls.mediaDetails[0].video_info.variants = hls.mediaDetails[0].video_info.variants.filter(variant => variant.content_type !== 'video/mp4');
  assert.throws(() => normalizeXPlayInfo(source, hls), /MP4 直链/);
});

test('不可播放状态明确报错', () => {
  const unavailable = structuredClone(fixture);
  unavailable.mediaDetails[0].ext_media_availability.status = 'Unavailable';
  assert.throws(() => normalizeXPlayInfo(source, unavailable), /未公开提供播放资源/);
});

test('syndication token 与已验证的公开短帖请求一致', () => {
  assert.equal(syndicationToken('1578353380363501568'), '3tqjk85bxqa');
});

test('明确标为 animated_gif 的资源可下载无声音 MP4，普通视频仍要求音轨', () => {
  const animation = structuredClone(fixture);
  animation.mediaDetails[0].type = 'animated_gif';
  assert.ok(normalizeXPlayInfo(source, animation).options.every(option => option.allowNoAudio === true));
  assert.ok(normalizeXPlayInfo(`${source}/video/3`, animation).options.every(option => !option.allowNoAudio));
});
