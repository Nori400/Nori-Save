import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { library, browserExecutable, ffmpeg, ffprobe } from './runtime.mjs';
const { chromium } = library('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const evidence = path.join(root, 'evidence');
await fs.mkdir(evidence, { recursive: true });
const profile = await fs.mkdtemp(path.join(evidence, 'qa-profile-'));
const downloads = path.join(evidence, 'browser-downloads');
await fs.mkdir(downloads, { recursive: true });
const metadata = JSON.parse(await fs.readFile(path.join(root, 'tools/fixtures/metadata.json'), 'utf8')).initialState;
const playInfo = JSON.parse(await fs.readFile(path.join(root, 'tools/fixtures/playinfo.json'), 'utf8')).response;
const videoBytes = await fs.readFile(path.join(evidence, 'remux/fragmented-video.mp4'));
const audioBytes = await fs.readFile(path.join(evidence, 'remux/fragmented-audio.m4a'));
playInfo.data.timelength = 3067;
playInfo.data.dash.duration = 3.067;
metadata.videoData.pages[0].duration = 3;
const codecs = playInfo.data.dash;
const videoStream = codecs.video.find(item => /^avc/.test(item.codecs));
const audioStream = codecs.audio[0];
const sourceUrl = `https://www.bilibili.com/video/${metadata.bvid}/?p=1`;
const allUrls = item => [item.baseUrl || item.base_url, ...(item.backupUrl || item.backup_url || [])].map(url => url.replace(/^http:/, 'https:'));
let failMedia = false;
let slowMedia = false;
let apiError = false;
const context = await chromium.launchPersistentContext(profile, {
  executablePath: browserExecutable,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true, downloadsPath: downloads
});
const pageErrors = [];
context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
const results = {};
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  results.loadedExtension = extensionId;
  await context.route('https://www.bilibili.com/video/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>来源站点测试页</title><script>window.__INITIAL_STATE__=${JSON.stringify(metadata).replace(/</g, '\\u003c')}</script><h1>来源站点公开响应测试页</h1><video></video>` }));
  await context.route('https://api.bilibili.com/**', route => {
    const url = new URL(route.request().url());
    return route.fulfill({ status: apiError ? 412 : 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': 'https://www.bilibili.com', 'access-control-allow-credentials': 'true' },
      body: JSON.stringify(url.pathname.includes('/view') ? { code: 0, data: metadata.videoData } : playInfo) });
  });
  for (const url of allUrls(videoStream)) await context.route(url, async route => {
    if (slowMedia) await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ status: failMedia ? 403 : 200, contentType: 'video/mp4', body: failMedia ? 'forbidden' : videoBytes }).catch(() => {});
  });
  for (const url of allUrls(audioStream)) await context.route(url, async route => {
    if (slowMedia) await new Promise(resolve => setTimeout(resolve, 1500));
    await route.fulfill({ status: failMedia ? 403 : 200, contentType: 'audio/mp4', body: failMedia ? 'forbidden' : audioBytes }).catch(() => {});
  });
  await context.route('https://*.hdslb.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#f3d9e2"/><rect x="260" y="145" width="120" height="90" rx="12" fill="#e47a9c"/><path d="M309 166v46l40-23z" fill="white"/></svg>' }));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  assert.equal(await popup.locator('#video-content').isVisible(), false);
  await popup.screenshot({ path: path.join(evidence, 'popup-start.png'), clip: { x: 0, y: 0, width: 420, height: 550 } });
  const sourcePromise = context.waitForEvent('page');
  await popup.locator('#link-input').fill(sourceUrl);
  await popup.locator('#inspect-link-button').click();
  const source = await sourcePromise;
  await popup.locator('#video-content').waitFor({ state: 'visible', timeout: 30000 });
  const [sourceTab] = await worker.evaluate(() => chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' }));
  assert.equal(sourceTab.url, sourceUrl);
  assert.equal(await popup.locator('#quality-select option').count(), 1);
  assert.equal(await popup.locator('#video-title').textContent(), metadata.videoData.title);
  assert.match(await popup.locator('#video-part').textContent(), /1.*10/);
  await popup.screenshot({ path: path.join(evidence, 'popup.png'), clip: { x: 0, y: 0, width: 420, height: 600 } });
  results.popup = { title: metadata.videoData.title, qualities: await popup.locator('#quality-select').textContent(), part: await popup.locator('#video-part').textContent() };
  const downloadPagePromise = context.waitForEvent('page');
  await popup.locator('#download-button').click();
  const downloadPage = await downloadPagePromise;
  await downloadPage.waitForLoadState();
  await downloadPage.locator('#stage-label').filter({ hasText: '已保存到电脑' }).waitFor({ timeout: 90000 });
  assert.equal(await downloadPage.locator('#progress-value').textContent(), '100%');
  const jobId = new URL(downloadPage.url()).searchParams.get('job');
  const job = await worker.evaluate(async id => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], jobId);
  assert.equal(job.status, 'done');
  const entries = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
  assert.equal(entries[0].state, 'complete');
  const actualFile = entries[0].filename;
  const savedFile = path.join(evidence, 'browser-result.mp4');
  await fs.copyFile(actualFile, savedFile);
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', savedFile], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  assert.ok(Math.abs(Number(probe.format.duration) - 3.067) < 0.01);
  execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', savedFile, '-f', 'null', '-'], { stdio: 'pipe' });
  results.download = { status: job.status, bytes: (await fs.stat(savedFile)).size, streams: probe.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, duration: stream.duration })), duration: probe.format.duration };
  const countBeforeRestore = (await worker.evaluate(() => chrome.downloads.search({}))).length;
  const restoredJob = { ...job, id: crypto.randomUUID(), status: 'saving', downloadTabId: 987654321 };
  await worker.evaluate(job => chrome.storage.session.set({ [`job:${job.id}`]: job }), restoredJob);
  const restored = await context.newPage();
  await restored.goto(`chrome-extension://${extensionId}/download.html?job=${restoredJob.id}`);
  await restored.locator('#stage-label').filter({ hasText: '已保存到电脑' }).waitFor();
  assert.equal((await worker.evaluate(() => chrome.downloads.search({}))).length, countBeforeRestore);
  results.restore = 'recovered existing download after tab replacement; no duplicate file';
  await restored.close();
  await downloadPage.screenshot({ path: path.join(evidence, 'download-complete.png') });
  const previewPromise = context.waitForEvent('page');
  await downloadPage.locator('#result-link').click();
  const preview = await previewPromise;
  await preview.waitForLoadState();
  const playback = await preview.evaluate(async () => {
    const video = document.querySelector('video');
    if (!video) throw new Error('No native player');
    if (video.readyState < 1) await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    video.muted = true;
    await video.play();
    await new Promise(resolve => setTimeout(resolve, 1000));
    const beforeSeek = video.currentTime;
    video.currentTime = 2;
    await new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
    return { duration: video.duration, beforeSeek, afterSeek: video.currentTime, width: video.videoWidth, height: video.videoHeight };
  });
  assert.ok(playback.beforeSeek > 0);
  assert.ok(playback.afterSeek >= 2);
  results.playback = playback;
  await preview.close();
  // A failed CDN response must never produce a success or an incomplete MP4.
  failMedia = true;
  const failJob = { ...job, id: crypto.randomUUID(), status: 'created', downloadTabId: undefined, downloadId: undefined, createdAt: Date.now() };
  await worker.evaluate(job => chrome.storage.session.set({ [`job:${job.id}`]: job }), failJob);
  const failed = await context.newPage();
  await failed.goto(`chrome-extension://${extensionId}/download.html?job=${failJob.id}`);
  await failed.locator('#stage-label').filter({ hasText: '下载未完成' }).waitFor({ timeout: 30000 });
  assert.equal(await failed.locator('#progress-value').textContent() === '100%', false);
  assert.equal(await failed.locator('#result-link').isVisible(), false);
  results.failure = await failed.locator('#error-message').textContent();
  failMedia = false;
  await failed.locator('#retry-button').click();
  await failed.locator('#stage-label').filter({ hasText: '已保存到电脑' }).waitFor({ timeout: 90000 });
  results.retry = 'refreshed and saved';
  // A part switch after inspection must block the old cached download.
  await source.evaluate(() => history.replaceState(null, '', '?p=2'));
  const mismatch = await popup.evaluate(async info => chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', tabId: info.tabId, bvid: info.bvid, cid: info.cid, optionId: info.optionId }), { tabId: sourceTab.id, bvid: job.video.bvid, cid: job.video.cid, optionId: job.option.id });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /切换/);
  results.partSwitch = mismatch.error;
  await source.evaluate(url => history.replaceState(null, '', url), sourceUrl);
  // Explicit cancellation while the server is still transferring.
  slowMedia = true;
  const cancelJob = { ...failJob, id: crypto.randomUUID(), createdAt: Date.now() };
  await worker.evaluate(job => chrome.storage.session.set({ [`job:${job.id}`]: job }), cancelJob);
  const cancelled = await context.newPage();
  await cancelled.goto(`chrome-extension://${extensionId}/download.html?job=${cancelJob.id}`);
  await cancelled.locator('#stage-label').filter({ hasText: '正在下载视频' }).waitFor();
  await cancelled.locator('#cancel-button').click();
  await cancelled.locator('#stage-label').filter({ hasText: '已取消下载' }).waitFor();
  assert.equal(await cancelled.locator('#result-link').isVisible(), false);
  results.cancel = 'cancelled with no output';
  slowMedia = false;
  apiError = true;
  const apiFailure = await popup.evaluate(tabId => chrome.runtime.sendMessage({ type: 'INSPECT', tabId }), sourceTab.id);
  assert.equal(apiFailure.ok, false);
  assert.match(apiFailure.error, /限制/);
  results.apiFailure = apiFailure.error;
  apiError = false;
  await popup.locator('#link-input').fill('http://127.0.0.1/private');
  await popup.locator('#inspect-link-button').click();
  await popup.locator('#empty-state').waitFor({ state: 'visible' });
  assert.match(await popup.locator('#empty-description').textContent(), /公开网页/);
  results.invalidInput = 'local URL rejected';
  assert.deepEqual(pageErrors, []);
  results.pageErrors = pageErrors;
  const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  assert.equal(rules[0].condition.initiatorDomains[0], extensionId);
  results.headerRule = rules[0];
  await fs.writeFile(path.join(evidence, 'browser-check.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, pageErrors, pages: await Promise.all(context.pages().map(async page => ({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000) }))) }, null, 2));
  throw error;
} finally {
  await context.close();
}
