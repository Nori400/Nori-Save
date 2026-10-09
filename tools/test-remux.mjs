import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createFile } from '../extension/vendor/mp4box.mjs';
import { remuxTracks } from '../extension/lib/remux.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'evidence', 'remux');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';
await mkdir(evidence, { recursive: true });

function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${path.basename(executable)} failed:\n${result.stderr}`);
  return result.stdout;
}

function ff(args) {
  return run(ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-y', ...args]);
}

function probe(file) {
  return JSON.parse(run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}

function packets(file, selector) {
  return JSON.parse(run(ffprobe, ['-v', 'error', '-select_streams', selector, '-show_packets',
    '-show_entries', 'packet=pts_time,dts_time,duration_time,size,data_hash,flags',
    '-show_data_hash', 'sha256', '-of', 'json', file])).packets;
}

async function load(file) {
  const bytes = await readFile(file);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function parse(buffer) {
  const file = createFile();
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();
  return file;
}

function sameSamples(sourcePackets, resultPackets, timescale, label) {
  assert.equal(resultPackets.length, sourcePackets.length, `${label}: packet count`);
  sourcePackets.forEach((source, index) => {
    const result = resultPackets[index];
    assert.equal(result.data_hash, source.data_hash, `${label}: compressed sample ${index} changed`);
    assert.equal(result.size, source.size, `${label}: sample ${index} size changed`);
    // Edit durations use a 1ms movie timescale. Rounding an initial empty edit
    // may move the whole timeline by at most half a millisecond.
    for (const key of ['pts_time', 'dts_time']) {
      assert.ok(Math.abs(Number(result[key]) - Number(source[key])) <= 0.00051 + 1 / timescale,
        `${label}: ${key} changed at packet ${index}: ${source[key]} -> ${result[key]}`);
    }
  });
}

function presentationEnd(sourcePackets, track, label) {
  const timescale = track.mdia.mdhd.timescale;
  assert.ok(Number.isFinite(timescale) && timescale > 0, `${label}: invalid source timescale`);
  assert.equal(sourcePackets.length, track.samples.length, `${label}: source packet/sample count`);
  assert.ok(sourcePackets.length > 0, `${label}: source has no packets`);
  return Math.max(...sourcePackets.map((packet, index) => {
    const pts = Number(packet.pts_time);
    // Older FFprobe versions omit duration_time for fragmented MP4 packets.
    // The source MP4 sample table still carries their exact duration in ticks;
    // FFprobe PTS retains any edit-list/timeline offset for presentation end.
    const duration = packet.duration_time == null
      ? track.samples[index].duration / timescale : Number(packet.duration_time);
    assert.ok(Number.isFinite(pts) && Number.isFinite(duration) && duration >= 0,
      `${label}: invalid presentation timing at packet ${index}`);
    return pts + duration;
  }));
}

async function verifyPair(name, videoPath, audioPath, { expectBFrames = true } = {}) {
  const progress = [];
  const videoBuffer = await load(videoPath);
  const audioBuffer = await load(audioPath);
  const videoInput = parse(videoBuffer);
  const audioInput = parse(audioBuffer);
  const sourceVideo = probe(videoPath).streams[0];
  const sourceAudio = probe(audioPath).streams[0];
  if (expectBFrames) assert.ok(sourceVideo.has_b_frames > 0, `${name}: fixture must exercise B-frame timing`);
  const blob = await remuxTracks(videoBuffer, audioBuffer, { onProgress: value => progress.push(value) });
  assert.equal(blob.type, 'video/mp4');
  assert.equal(progress.at(-1).progress, 1);
  assert.ok(progress.every((value, index) => !index || value.progress >= progress[index - 1].progress));
  const resultPath = path.join(evidence, `${name}-merged.mp4`);
  const mergedBuffer = await blob.arrayBuffer();
  await writeFile(resultPath, new Uint8Array(mergedBuffer));
  const parsed = parse(mergedBuffer);
  assert.equal(parsed.moov.traks.length, 2);
  assert.equal(parsed.moofs.length, 0, 'output must be ordinary indexed MP4');
  assert.ok(parsed.moov.start < parsed.mdats[0].start, 'moov must precede mdat for fast start');
  assert.equal(parsed.moov.mvex, undefined, 'regular MP4 cannot contain fragment-only mvex');
  const result = probe(resultPath);
  const video = result.streams.find(stream => stream.codec_type === 'video');
  const audio = result.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(video.codec_name, sourceVideo.codec_name);
  assert.equal(audio.codec_name, sourceAudio.codec_name);
  assert.equal(video.width, sourceVideo.width);
  assert.equal(video.height, sourceVideo.height);
  assert.equal(audio.sample_rate, sourceAudio.sample_rate);
  assert.equal(audio.channels, sourceAudio.channels);
  const sourceVideoPackets = packets(videoPath, 'v:0');
  const sourceAudioPackets = packets(audioPath, 'a:0');
  const sourceTracks = [[sourceVideoPackets, videoInput.moov.traks[0], `${name} video`],
    [sourceAudioPackets, audioInput.moov.traks[0], `${name} audio`]];
  const sourcePresentationEnd = Math.max(...sourceTracks.map(([source, track, label]) => {
    const end = presentationEnd(source, track, label);
    // Exercise the old-FFprobe fallback even when local FFprobe reports duration.
    const omitted = source.map(({ duration_time, ...packet }) => packet);
    const fallbackEnd = presentationEnd(omitted, track, label);
    assert.ok(Math.abs(end - fallbackEnd) <= 0.000001 + 1 / track.mdia.mdhd.timescale,
      `${label}: MP4 sample-duration fallback changed presentation end`);
    return end;
  }));
  assert.ok(Math.abs(Number(result.format.duration) - sourcePresentationEnd) <= 0.001001,
    `presentation duration changed: ${sourcePresentationEnd} -> ${result.format.duration}`);
  sameSamples(sourceVideoPackets, packets(resultPath, 'v:0'),
    videoInput.moov.traks[0].mdia.mdhd.timescale, `${name} video`);
  sameSamples(sourceAudioPackets, packets(resultPath, 'a:0'),
    audioInput.moov.traks[0].mdia.mdhd.timescale, `${name} audio`);
  // Decode every frame and every audio sample, with any FFmpeg error fatal.
  ff(['-i', resultPath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  const seek = Math.max(0.5, Number(result.format.duration) * 0.65);
  ff(['-ss', String(seek), '-i', resultPath, '-t', '0.5', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  return { name, output: path.relative(root, resultPath), bytes: blob.size,
    duration: Number(result.format.duration), video: { codec: video.codec_name, frames: Number(video.nb_frames),
      width: video.width, height: video.height, start: Number(video.start_time), hasBFrames: video.has_b_frames },
    audio: { codec: audio.codec_name, frames: Number(audio.nb_frames), sampleRate: Number(audio.sample_rate),
      channels: audio.channels, start: Number(audio.start_time) },
    checks: ['both tracks', 'fast-start ordinary MP4', 'all compressed packet hashes unchanged',
      'all DTS/PTS preserved within source tick and movie edit rounding', 'full decode', 'seek decode'] };
}

const master = path.join(evidence, 'fixture-master.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
  '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-bf', '3', '-g', '30', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', master]);
const cases = [
  ['normal', '+faststart'],
  ['fragmented', '+frag_keyframe+empty_moov+default_base_moof'],
  ['normal-negative-cts', '+faststart+negative_cts_offsets']
];
const results = [];
let normalVideo;
let normalAudio;
for (const [name, flags] of cases) {
  const video = path.join(evidence, `${name}-video.mp4`);
  const audio = path.join(evidence, `${name}-audio.m4a`);
  ff(['-i', master, '-map', '0:v:0', '-c', 'copy', '-movflags', flags, video]);
  ff(['-i', master, '-map', '0:a:0', '-c', 'copy', '-movflags', flags, audio]);
  if (name === 'normal') { normalVideo = video; normalAudio = audio; }
  if (name.startsWith('fragmented')) assert.ok(parse(await load(video)).moofs.length > 0);
  if (name.endsWith('negative-cts')) {
    assert.ok(parse(await load(video)).moov.traks[0].samples.some(sample => sample.cts < sample.dts));
  }
  results.push(await verifyPair(name, video, audio));
}

const validVideo = await load(normalVideo);
const validAudio = await load(normalAudio);
const hevcVideo = path.join(evidence, 'hevc-video.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '3', '-an', '-c:v', 'libx265',
  '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-tag:v', 'hvc1', '-movflags', '+faststart', hevcVideo]);
results.push(await verifyPair('hevc', hevcVideo, normalAudio));
const av1Video = path.join(evidence, 'av1-video.mp4');
ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30', '-t', '3', '-an', '-c:v', 'libaom-av1',
  '-cpu-used', '8', '-crf', '40', '-b:v', '0', '-movflags', '+faststart', av1Video]);
results.push(await verifyPair('av1', av1Video, normalAudio, { expectBFrames: false }));
const signedFragmented = path.join(evidence, 'unsupported-fragmented-negative-cts-video.mp4');
ff(['-i', master, '-map', '0:v:0', '-c', 'copy', '-movflags',
  '+frag_keyframe+empty_moov+default_base_moof+negative_cts_offsets', signedFragmented]);
assert.ok(parse(await load(signedFragmented)).moov.traks[0].samples.some(sample => sample.cts < sample.dts));
await assert.rejects(remuxTracks(await load(signedFragmented), validAudio), /流媒体时间轴/);
await assert.rejects(remuxTracks(validVideo.slice(0, -8), validAudio), /截断|不完整/);
await assert.rejects(remuxTracks(new TextEncoder().encode('<!doctype html><body>not a video</body>').buffer, validAudio), /截断|不完整|MP4/);
await assert.rejects(remuxTracks(validAudio, validVideo), /单独的/);
const aborted = new AbortController();
aborted.abort();
await assert.rejects(remuxTracks(validVideo, validAudio, { signal: aborted.signal }), { name: 'AbortError' });
const midAbort = new AbortController();
await assert.rejects(remuxTracks(validVideo, validAudio, { signal: midAbort.signal,
  onProgress: update => { if (update.phase === 'mux') midAbort.abort(); } }), { name: 'AbortError' });
const encrypted = path.join(evidence, 'fixture-encrypted-video.mp4');
ff(['-i', normalVideo, '-c', 'copy', '-encryption_scheme', 'cenc-aes-ctr',
  '-encryption_key', '000102030405060708090a0b0c0d0e0f',
  '-encryption_kid', '00112233445566778899aabbccddeeff', encrypted]);
await assert.rejects(remuxTracks(await load(encrypted), validAudio), /加密|DRM/);

const liveVideo = path.join(root, 'evidence', 'live-avc-video.m4s');
const liveAudio = path.join(root, 'evidence', 'live-aac-audio.m4s');
let liveAvailable = false;
// Public clones contain no captured copyrighted media. All generated FFmpeg
// cases above always run; the locally captured live pair is strictly optional.
try { await access(liveVideo); await access(liveAudio); liveAvailable = true; } catch { /* Optional live fixture. */ }
if (liveAvailable) results.push(await verifyPair('live-avc-aac', liveVideo, liveAudio));

const summary = { verifiedAt: new Date().toISOString(), library: 'MP4Box.js 2.4.1',
  liveFixtureAvailable: liveAvailable,
  ffmpeg: run(ffmpeg, ['-version']).split('\n')[0], cases: results,
  rejectionChecks: ['truncated MP4', 'HTML/CDN error body', 'wrong track types', 'aborted before start',
    'aborted during remux', 'AES-CTR encrypted MP4', 'unsupported signed negative-CTS fragmented timeline'] };
await writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
