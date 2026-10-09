import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeHttpUrl, mediaKind, normalizeCandidates, safeFilename, validateWebM } from '../extension/lib/media.js';
import { validateDirectMp4 } from '../extension/lib/remux.js';
import { ffmpeg } from './runtime.mjs';

test('只接受公开HTTP资源，拒绝凭据、局域网与别名IP写法', () => {
  for (const address of ['http://localhost/v', 'http://localhost./v', 'http://router/v', 'http://server.home.arpa/v', 'http://server.lan/v', 'http://127.1/v', 'http://2130706433/v', 'http://10.0.0.2/v',
    'http://172.16.0.1/v', 'http://192.168.0.3/v', 'http://169.254.169.254/v', 'http://[::1]/v', 'http://[fc00::1]/v',
    'http://[::ffff:127.0.0.1]/v', 'https://a:secret@example.com/v', 'file:///v.mp4', 'blob:https://example.com/a']) assert.equal(safeHttpUrl(address), null, address);
  assert.equal(safeHttpUrl('https://cdn.example.com/video?id=1'), 'https://cdn.example.com/video?id=1');
});

test('发现MP4/WebM/HLS并去重，忽略单独音轨、DASH清单与分片', () => {
  const options = normalizeCandidates([
    { url: 'https://cdn.example.com/video.mp4', width: 320, height: 180 },
    { url: 'https://cdn.example.com/video.mp4', size: 20000 },
    { url: 'https://cdn.example.com/file?id=2', mimeType: 'video/webm' },
    { url: 'https://cdn.example.com/master.m3u8' },
    { url: 'https://cdn.example.com/segment-1.mp4' },
    { url: 'https://cdn.example.com/audio.mp4', mimeType: 'audio/mp4' },
    { url: 'https://cdn.example.com/video.mpd' },
    { url: 'http://192.168.1.1/private.mp4' }
  ]);
  assert.equal(options.length, 3);
  assert.equal(options[0].exactBytes, 20000);
  assert.equal(options[0].height, 180);
  assert.equal(options[1].extension, 'webm');
  assert.equal(options[2].kind, 'hls');
  assert.equal(mediaKind('https://cdn.example.com/init.m4s', 'video/mp4'), null);
  const reordered = normalizeCandidates([{ url: options[1].videoUrl, mimeType: 'video/webm' }, { url: options[0].videoUrl }]);
  assert.equal(reordered[0].id, options[1].id);
  assert.equal(reordered[1].id, options[0].id);
});

test('输出容器与Windows文件名一致', () => {
  assert.equal(safeFilename({ title: 'CON' }, 'ts'), '_CON.ts');
  assert.equal(safeFilename({ title: 'a:b/c' }, 'webm'), 'a_b_c.webm');
});

test('完整WebM可保存，截断容器和错误响应拒绝', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const evidence = path.join(root, 'evidence', 'media');
  mkdirSync(evidence, { recursive: true });
  const filename = path.join(evidence, 'generated.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
    '-t', '1', '-c:v', 'libvpx-vp9', '-b:v', '120k', '-c:a', 'libopus', filename], { stdio: 'pipe' });
  const bytes = readFileSync(filename);
  const array = value => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  validateWebM(array(bytes));
  assert.throws(() => validateWebM(array(bytes.subarray(0, -100))), /截断|不完整/);
  assert.throws(() => validateWebM(new TextEncoder().encode('<html>an error page returned by a server</html>').buffer), /WebM/);
  const videoOnly = readFileSync(path.join(root, 'evidence/remux/normal-video.mp4'));
  assert.throws(() => validateDirectMp4(array(videoOnly)), /声音/);
  validateDirectMp4(array(videoOnly), 0, { allowNoAudio: true });
});
