import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { remuxTracks, validateDirectMp4 } from '../extension/lib/remux.js';
const asArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const video = asArrayBuffer(await readFile(new URL('../evidence/remux/normal-video.mp4', import.meta.url)));
const audio = asArrayBuffer(await readFile(new URL('../evidence/remux/normal-audio.m4a', import.meta.url)));
const complete = await (await remuxTracks(video, audio)).arrayBuffer();

test('有声音和画面的完整MP4允许直接保存', () => {
  assert.doesNotThrow(() => validateDirectMp4(complete, complete.byteLength));
});
test('HTTP成功但文件截短时，拒绝保存', () => {
  assert.throws(() => validateDirectMp4(complete.slice(0, -20)), /截断|不完整|无效/);
});
test('只有文件头或没有声音的文件不作为有声MP4保存', () => {
  const ftypSize = new DataView(complete).getUint32(0);
  assert.throws(() => validateDirectMp4(complete.slice(0, ftypSize)), /不完整|初始化/);
  assert.throws(() => validateDirectMp4(video), /声音|画面/);
});
test('来源站点报告的精确大小不符时拒绝保存', () => {
  assert.throws(() => validateDirectMp4(complete, complete.byteLength + 1), /长度/);
});
