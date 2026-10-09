import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseHls, downloadHls } from '../extension/lib/hls.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'evidence', 'hls');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
const origin = 'https://media.example.test';
await mkdir(evidence, { recursive: true });

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(executable)} failed:\n${result.stderr}`);
  return result.stdout;
}

function ff(args, options) { return run(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-y', ...args], options); }
function probe(file) { return JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])); }

for (const type of ['ts', 'mp4']) {
  const folder = path.join(evidence, type);
  await mkdir(folder, { recursive: true });
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-hls_time', '1', '-hls_playlist_type', 'vod',
    ...(type === 'mp4' ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4'] : []),
    '-hls_segment_filename', path.join(folder, `segment-%03d.${type === 'mp4' ? 'm4s' : 'ts'}`), path.join(folder, 'playlist.m3u8')], { cwd: folder });
}

for (const type of ['video', 'audio']) {
  const folder = path.join(evidence, type);
  await mkdir(folder, { recursive: true });
  ff(['-i', path.join(evidence, 'mp4/playlist.m3u8'), '-map', type === 'video' ? '0:v:0' : '0:a:0', '-c', 'copy',
    '-hls_time', '1', '-hls_playlist_type', 'vod', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(folder, 'segment-%03d.m4s'), path.join(folder, 'playlist.m3u8')], { cwd: folder });
}

const resources = new Map();
for (const type of ['ts', 'mp4', 'video', 'audio']) {
  const playlistUrl = `${origin}/${type}/playlist.m3u8`;
  const text = await readFile(path.join(evidence, type, 'playlist.m3u8'), 'utf8');
  resources.set(playlistUrl, Buffer.from(text));
  const parsed = parseHls(text, playlistUrl);
  assert.equal(parsed.endList, true);
  assert.ok(parsed.segments.length >= 4);
  for (const segment of parsed.segments) resources.set(segment.url, await readFile(path.join(evidence, type, path.basename(new URL(segment.url).pathname))));
  if (parsed.segments[0].initMap) {
    const map = parsed.segments[0].initMap;
    resources.set(map.url, await readFile(path.join(evidence, type, path.basename(new URL(map.url).pathname))));
  }
}

function mock(overrides = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const fetchImpl = async (address, options) => {
    calls.push({ address, options });
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (options.signal?.aborted) throw new DOMException('cancelled', 'AbortError');
    let bytes = overrides.resources?.get(address) ?? resources.get(address);
    if (bytes === undefined) return new Response('not found', { status: 404 });
    let status = 200;
    const headers = {};
    if (options.headers?.Range && !overrides.ignoreRange) {
      const [, start, end] = options.headers.Range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
      headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
      bytes = bytes.subarray(start, end + 1);
      status = 206;
    }
    if (!overrides.omitLength) headers['content-length'] = String(bytes.length);
    active++;
    maxActive = Math.max(maxActive, active);
    let offset = 0;
    let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) { controller.close(); release(); return; }
        const end = Math.min(offset + 4096, bytes.length);
        controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
        offset = end;
      }, cancel() { release(); }
    });
    return new Response(stream, { status, headers });
  };
  return { fetchImpl, calls, get maxActive() { return maxActive; } };
}

const results = [];
async function verify(name, url, format, resourcesOverride, { expectedSegments = 4, expectByteEqual = true } = {}) {
  const network = mock({ resources: resourcesOverride });
  const progress = [];
  const resolved = [];
  const result = await downloadHls(url, { fetchImpl: network.fetchImpl,
    onProgress: value => progress.push(value), onResolvedUrl: async (address, info) => {
      assert.equal(new URL(address).origin, origin);
      resolved.push({ address, kind: info.kind });
    } });
  assert.equal(result.extension, format);
  assert.equal(result.mimeType, format === 'mp4' ? 'video/mp4' : 'video/mp2t');
  assert.equal(result.blob.type, result.mimeType);
  assert.equal(progress.at(-1).progress, 1);
  if (expectByteEqual) assert.equal(progress.at(-1).downloadedBytes, result.blob.size);
  else assert.ok(progress.at(-1).downloadedBytes > 180000);
  assert.equal(progress.at(-1).completedSegments, expectedSegments);
  assert.ok(progress.every((item, index) => !index || item.progress >= progress[index - 1].progress));
  assert.equal(network.maxActive, 1, 'every response must be drained before the next request');
  assert.equal(resolved.length, network.calls.length);
  const output = path.join(evidence, `${name}.${format}`);
  await writeFile(output, new Uint8Array(await result.blob.arrayBuffer()));
  const info = probe(output);
  const video = info.streams.find(stream => stream.codec_type === 'video');
  const audio = info.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.codec_name, 'h264');
  assert.equal(audio.codec_name, 'aac');
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.ok(video.has_b_frames > 0);
  assert.equal(audio.sample_rate, '48000');
  assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.12, 'four-second presentation duration');
  ff(['-i', output, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  ff(['-ss', '2.4', '-i', output, '-t', '0.5', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  // Count decoded frames to prove that all four segments reached the output.
  const counts = JSON.parse(run(ffprobe, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,nb_read_frames', '-of', 'json', output])).streams;
  assert.equal(Number(counts.find(stream => stream.codec_type === 'video').nb_read_frames), 120);
  assert.ok(Number(counts.find(stream => stream.codec_type === 'audio').nb_read_frames) >= 187);
  results.push({ name, output: path.relative(root, output), bytes: result.blob.size, duration: Number(info.format.duration),
    videoCodec: video.codec_name, audioCodec: audio.codec_name, videoFrames: 120, segments: expectedSegments,
    checks: ['both audio and video', 'B-frame decode', 'full decode', 'seek decode', '120 decoded video frames',
      expectByteEqual ? 'byte progress matches output' : 'byte progress counts both input tracks',
      'sequential fetching', 'all requested origins validated'] });
  return network;
}

await verify('ts-vod', `${origin}/ts/playlist.m3u8`, 'ts');
await verify('fmp4-vod', `${origin}/mp4/playlist.m3u8`, 'mp4');
const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90,CODECS="avc1.64001e,mp4a.40.2"\nts/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,CODECS="avc1.64001e,mp4a.40.2"\nmp4/playlist.m3u8\n';
const masterParsed = parseHls(master, `${origin}/master.m3u8`);
assert.equal(masterParsed.kind, 'master');
assert.equal(masterParsed.variants[1].codecs, 'avc1.64001e,mp4a.40.2');
assert.equal(masterParsed.variants[1].resolution, '320x180');
const withMaster = new Map(resources).set(`${origin}/master.m3u8`, Buffer.from(master));
const masterNetwork = await verify('master-highest', `${origin}/master.m3u8`, 'mp4', withMaster);
assert.equal(masterNetwork.calls[1].address, `${origin}/mp4/playlist.m3u8`);
assert.ok(!masterNetwork.calls.some(call => call.address.includes('/ts/')));
const externalMaster = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English, default",DEFAULT=YES,AUTOSELECT=YES,URI="audio/playlist.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="a",CODECS="avc1.64001e,mp4a.40.2"\nvideo/playlist.m3u8\n';
const splitResources = new Map(resources).set(`${origin}/external.m3u8`, Buffer.from(externalMaster));
const audioSegments = parseHls(resources.get(`${origin}/audio/playlist.m3u8`).toString(), `${origin}/audio/playlist.m3u8`).segments.length;
await verify('external-fmp4-audio', `${origin}/external.m3u8`, 'mp4', splitResources,
  { expectedSegments: 4 + audioSegments, expectByteEqual: false });
const splitLimited = mock({ resources: splitResources });
await assert.rejects(downloadHls(`${origin}/external.m3u8`, { fetchImpl: splitLimited.fetchImpl, maxBytes: 170000 }), /大小上限/);
assert.ok(splitLimited.calls.some(call => call.address.includes('/audio/init.mp4')),
  'the combined limit must include audio after video, not a separate allowance per track');

const fmp4Manifest = parseHls(resources.get(`${origin}/mp4/playlist.m3u8`).toString(), `${origin}/mp4/playlist.m3u8`);
const init = resources.get(fmp4Manifest.segments[0].initMap.url);
const segmentBytes = fmp4Manifest.segments.map(segment => resources.get(segment.url));
const packed = Buffer.concat([init, ...segmentBytes]);
let position = init.length;
let rangePlaylist = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI="packed.mp4",BYTERANGE="${init.length}@0"\n`;
segmentBytes.forEach((bytes, index) => {
  rangePlaylist += `#EXTINF:1,\n#EXT-X-BYTERANGE:${bytes.length}${index === 0 ? `@${position}` : ''}\npacked.mp4\n`;
  position += bytes.length;
});
rangePlaylist += '#EXT-X-ENDLIST\n';
const rangedParsed = parseHls(rangePlaylist, `${origin}/range/playlist.m3u8`);
assert.equal(rangedParsed.segments[0].sequence, 10);
assert.equal(rangedParsed.segments[1].byteRange.offset, init.length + segmentBytes[0].length);
const rangedResources = new Map(resources).set(`${origin}/range/playlist.m3u8`, Buffer.from(rangePlaylist))
  .set(`${origin}/range/packed.mp4`, packed);
await verify('byterange-fmp4', `${origin}/range/playlist.m3u8`, 'mp4', rangedResources);

const rejects = ['shared video+audio size cap'];
async function rejectManifest(name, text, pattern, expectedRequests = 1) {
  const manifestUrl = `${origin}/rejected.m3u8`;
  const network = mock({ resources: new Map(resources).set(manifestUrl, Buffer.from(text)) });
  await assert.rejects(downloadHls(manifestUrl, { fetchImpl: network.fetchImpl }), pattern);
  assert.equal(network.calls.length, expectedRequests, `${name}: media must not be requested`);
  rejects.push(name);
}
const simple = '#EXTM3U\n#EXTINF:1,\nts/segment-000.ts\n#EXT-X-ENDLIST\n';
await rejectManifest('unfinished/live stream', simple.replace('#EXT-X-ENDLIST', ''), /直播|尚未结束/);
await rejectManifest('AES encryption', simple.replace('#EXTINF', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF'), /AES|加密/);
await rejectManifest('DRM session key', simple.replace('#EXTINF', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="key.bin"\n#EXTINF'), /DRM|加密/);
await rejectManifest('discontinuous timeline', simple.replace('#EXTINF', '#EXT-X-DISCONTINUITY\n#EXTINF'), /间断|编码切换/);
await rejectManifest('missing/gapped segment', simple.replace('#EXTINF', '#EXT-X-GAP\n#EXTINF'), /不完整/);
await rejectManifest('I-frame preview', simple.replace('#EXTINF', '#EXT-X-I-FRAMES-ONLY\n#EXTINF'), /关键帧/);
await rejectManifest('changed initialization', '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\na.m4s\n#EXT-X-MAP:URI="other.mp4"\n#EXTINF:1,\nb.m4s\n#EXT-X-ENDLIST\n', /初始化段发生变化/);
await rejectManifest('external audio with TS video', externalMaster.replace('video/playlist.m3u8', 'ts/playlist.m3u8'), /独立.*音轨/, 2);
await rejectManifest('playlist recursion', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nrejected.m3u8\n', /循环/);
for (const url of ['http://localhost/stream.m3u8', 'http://127.1/stream.m3u8', 'http://2130706433/a.m3u8',
  'http://10.0.0.1/a.m3u8', 'http://169.254.169.254/a.m3u8', 'http://172.16.3.1/a.m3u8',
  'http://192.168.2.2/a.m3u8', 'http://[::1]/a.m3u8', 'http://[::ffff:127.0.0.1]/a.m3u8',
  'http://[fc00::1]/a.m3u8', 'http://[fe80::1]/a.m3u8', 'https://user:password@example.com/a.m3u8',
  'file:///a.m3u8', 'data:application/x-mpegurl,AAA', 'https://server.local/a.m3u8']) {
  const network = mock();
  await assert.rejects(downloadHls(url, { fetchImpl: network.fetchImpl }), /地址|HTTP/);
  assert.equal(network.calls.length, 0);
}
rejects.push('private/reserved/credential/non-network URLs');
const denied = mock();
await assert.rejects(downloadHls(`${origin}/ts/playlist.m3u8`, { fetchImpl: denied.fetchImpl,
  onResolvedUrl: (address, info) => { if (info.kind === 'segment') throw new Error('unapproved origin'); } }), /unapproved origin/);
assert.equal(denied.calls.length, 1);
rejects.push('origin callback denies segment before fetch');
for (const omitLength of [false, true]) {
  const network = mock({ omitLength });
  await assert.rejects(downloadHls(`${origin}/ts/playlist.m3u8`, { fetchImpl: network.fetchImpl, maxBytes: 2000 }), /大小上限/);
}
rejects.push('size cap with and without Content-Length');
const controller = new AbortController();
const cancelled = mock();
await assert.rejects(downloadHls(`${origin}/ts/playlist.m3u8`, { fetchImpl: cancelled.fetchImpl, signal: controller.signal,
  onProgress: update => { if (update.downloadedBytes > 10000) controller.abort(); } }), { name: 'AbortError' });
assert.ok(cancelled.calls.length <= 2);
rejects.push('abort while reading a segment');
const ignoredRange = mock({ resources: rangedResources, ignoreRange: true });
await assert.rejects(downloadHls(`${origin}/range/playlist.m3u8`, { fetchImpl: ignoredRange.fetchImpl }), /字节范围/);
rejects.push('server ignores Range');
const alteredTs = new Map(resources);
const changed = Buffer.from(alteredTs.get(`${origin}/ts/segment-001.ts`));
for (let position = 0; position + 188 <= changed.length; position += 188) {
  const pid = ((changed[position + 1] & 31) << 8) | changed[position + 2];
  if (pid === 4096 && (changed[position + 1] & 64)) {
    let payload = position + 4;
    if (((changed[position + 3] >> 4) & 3) === 3) payload += 1 + changed[position + 4];
    payload += 1 + changed[payload];
    const firstStream = payload + 12 + (((changed[payload + 10] & 15) << 8) | changed[payload + 11]);
    changed[firstStream] = 0x24; // Declare HEVC instead of AVC in every PMT.
  }
}
alteredTs.set(`${origin}/ts/segment-001.ts`, changed);
await assert.rejects(downloadHls(`${origin}/ts/playlist.m3u8`, { fetchImpl: mock({ resources: alteredTs }).fetchImpl }), /编码发生变化/);
rejects.push('MPEG-TS PMT changes codec');
for (const [type, url, pattern] of [
  ['ts', `${origin}/ts/segment-001.ts`, /截断/],
  ['mp4', `${origin}/mp4/segment-001.m4s`, /截断/]
]) {
  const truncated = new Map(resources);
  truncated.set(url, truncated.get(url).subarray(0, -1));
  await assert.rejects(downloadHls(`${origin}/${type}/playlist.m3u8`, { fetchImpl: mock({ resources: truncated }).fetchImpl }), pattern);
}
rejects.push('truncated TS and fMP4 segments');

assert.throws(() => parseHls('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:10\na.ts\n#EXT-X-ENDLIST', `${origin}/list.m3u8`), /隐含字节范围/);
assert.throws(() => parseHls('<html>not a playlist</html>', `${origin}/list.m3u8`), /有效.*HLS/);
assert.equal(parseHls(simple.replace('#EXTINF', '#EXT-X-KEY:METHOD=NONE\n#EXTINF'), `${origin}/list.m3u8`).encrypted, false);
rejects.push('malformed playlist and implicit Range without predecessor');

const summary = { verifiedAt: new Date().toISOString(), source: 'All media generated locally with FFmpeg testsrc2+sine; no third-party video',
  ffmpeg: run(ffmpeg, ['-version']).split('\n')[0].trim(), cases: results, rejectionChecks: rejects };
await writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
