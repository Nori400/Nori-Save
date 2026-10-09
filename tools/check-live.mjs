import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { library, browserExecutable, ffmpeg, ffprobe } from './runtime.mjs';
const { chromium } = library('playwright');
if (!process.env.NORI_SAVE_TEST_URL) throw new Error('请设置 NORI_SAVE_TEST_URL 为要测试的普通视频链接。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const evidence = path.join(root, 'evidence');
await fs.mkdir(evidence, { recursive: true });
const profile = await fs.mkdtemp(path.join(evidence, 'qa-live-profile-'));
const downloadDirectory = path.join(evidence, 'live-browser-downloads');
await fs.mkdir(downloadDirectory, { recursive: true });
const report = {
  startedAtUtc: new Date().toISOString(),
  browser: 'Microsoft Edge, headless, isolated new profile',
  sourceUrl: process.env.NORI_SAVE_TEST_URL,
  cookiesImported: false,
  mockedRequests: false,
  siteAttempts: 1,
  profile,
  passed: false,
  apiResponses: [],
  extensionMediaResponses: [],
  extensionPageErrors: [],
  sitePageErrors: [],
  requestFailures: []
};
const pageLabel = request => {
  try { return request.frame().url().startsWith('chrome-extension:') ? 'extension' : 'site'; }
  catch { return 'worker'; }
};
const pendingNetworkRecords = [];
const context = await chromium.launchPersistentContext(profile, {
  executablePath: browserExecutable,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
  downloadsPath: downloadDirectory
});
let source;
let popup;
let downloadPage;
context.on('page', page => page.on('pageerror', error => {
  const target = page.url().startsWith('chrome-extension:') ? report.extensionPageErrors : report.sitePageErrors;
  if (target.length < 20) target.push(error.message.slice(0, 500));
}));
context.on('requestfailed', request => {
  if (pageLabel(request) !== 'extension' || report.requestFailures.length >= 20) return;
  const url = new URL(request.url());
  report.requestFailures.push({ host: url.hostname, pathname: url.pathname, failure: request.failure()?.errorText });
});
context.on('response', response => {
  const request = response.request();
  const url = new URL(response.url());
  const isApi = /\/(?:player\/(?:wbi\/)?playurl|web-interface\/view|tweet-result|player\/metadata\/video\/[^/]+|video\/\d+\/config)$/.test(url.pathname);
  const isExtensionMedia = !isApi && pageLabel(request) === 'extension' && ['http:', 'https:'].includes(url.protocol);
  if (request.resourceType() === 'document' && url.hostname === new URL(report.sourceUrl).hostname) report.sourceStatus = response.status();
  if (!isApi && !isExtensionMedia) return;
  pendingNetworkRecords.push((async () => {
    const requestHeaders = await request.allHeaders();
    const responseHeaders = await response.allHeaders();
    const record = {
      host: url.hostname, pathname: url.pathname.replace(/sec\d\([^)]+\)/g, 'sec(redacted)'), status: response.status(),
      origin: requestHeaders.origin || null, referer: requestHeaders.referer || null,
      contentType: responseHeaders['content-type'] || null,
      contentLength: Number(responseHeaders['content-length']) || null,
      source: pageLabel(request)
    };
    if (isApi) {
      record.bvid = url.searchParams.get('bvid');
      record.cid = url.searchParams.get('cid');
      try {
        const json = await response.json();
        record.code = json.code;
        record.message = json.message;
        record.quality = json.data?.quality || json.result?.quality || null;
      } catch { /* HTML wind-control errors are recorded by HTTP status. */ }
      if (report.apiResponses.length < 20) report.apiResponses.push(record);
    } else if (report.extensionMediaResponses.length < 20 && /video\/|audio\/|mpegurl|octet-stream/.test(record.contentType || '')) report.extensionMediaResponses.push(record);
  })().catch(error => { report.requestFailures.push({ host: url.hostname, pathname: url.pathname, failure: error.message }); }));
});

try {
  report.browserVersion = context.browser()?.version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  report.extensionId = extensionId;
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const createdSource = context.waitForEvent('page');
  await popup.locator('#link-input').fill(report.sourceUrl);
  await popup.locator('#inspect-link-button').click();
  source = await createdSource;
  await popup.waitForFunction(() => document.getElementById('loading-state').hidden, null, { timeout: 60000 });
  report.sourceFinalUrl = source.url();
  report.sourceDocumentTitle = await source.title();
  report.userAgent = await source.evaluate(() => navigator.userAgent);
  const sourceTab = await worker.evaluate(async () => {
    const all = await chrome.storage.session.get(null);
    const key = Object.keys(all).find(key => key.startsWith('inspect:'));
    return key ? { id: Number(key.slice(8)) } : null;
  });
  await popup.screenshot({ path: path.join(evidence, 'live-popup.png'), clip: { x: 0, y: 0, width: 420, height: 600 } });
  if (!(await popup.locator('#video-content').isVisible())) {
    report.inspectionError = await popup.locator('#empty-description').textContent();
    throw new Error(`Real source inspection failed: ${report.inspectionError}`);
  }
  report.popup = {
    title: await popup.locator('#video-title').textContent(),
    part: await popup.locator('#video-part').textContent(),
    qualities: await popup.locator('#quality-select').textContent()
  };
  const cache = await worker.evaluate(async tabId => (await chrome.storage.session.get(`inspect:${tabId}`))[`inspect:${tabId}`], sourceTab.id);
  report.inspection = {
    bvid: cache.video.bvid, cid: cache.video.cid, page: cache.video.page,
    qualities: cache.options.map(option => ({ quality: option.quality, codec: option.codec, kind: option.kind }))
  };
  assert.ok(cache.video.bvid && Number.isInteger(cache.video.cid));
  assert.ok(cache.options.length);
  const newPage = context.waitForEvent('page', { timeout: 15000 });
  await popup.locator('#download-button').click();
  downloadPage = await newPage;
  await downloadPage.waitForLoadState('domcontentloaded');
  await downloadPage.waitForFunction(() => ['已保存到电脑', '下载未完成', '无法开始下载', '视频已准备好'].includes(document.getElementById('stage-label').textContent), null, { timeout: 120000 });
  report.downloadStage = await downloadPage.locator('#stage-label').textContent();
  report.downloadError = await downloadPage.locator('#error-message').textContent();
  await downloadPage.screenshot({ path: path.join(evidence, 'live-download.png') });
  assert.equal(report.downloadStage, '已保存到电脑', report.downloadError);
  const jobId = new URL(downloadPage.url()).searchParams.get('job');
  const job = await worker.evaluate(async id => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], jobId);
  assert.equal(job.status, 'done');
  const [saved] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
  assert.equal(saved.state, 'complete');
  const output = path.join(evidence, `live-browser-result${path.extname(job.filename)}`);
  await fs.copyFile(saved.filename, output);
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8', timeout: 30000 }));
  assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  assert.ok(Number(probe.format.duration) > 0);
  execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { stdio: 'pipe', timeout: 45000 });
  report.download = {
    output, status: job.status, bytes: (await fs.stat(output)).size,
    duration: Number(probe.format.duration),
    streams: probe.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, duration: Number(stream.duration) })),
    fullDecodePassed: true
  };
  report.headerRule = (await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules())).find(rule => rule.condition.tabIds?.includes(downloadPage ? job.downloadTabId : -1));
  await Promise.allSettled(pendingNetworkRecords);
  assert.ok(report.extensionMediaResponses.filter(response => response.status === 200 || response.status === 206).length >= 1, 'Media must be fetched from real CDN servers.');
  assert.deepEqual(report.extensionPageErrors, []);
  report.passed = true;
} catch (error) {
  report.error = error.message;
  if (popup) await popup.screenshot({ path: path.join(evidence, 'live-popup.png'), clip: { x: 0, y: 0, width: 420, height: 600 } }).catch(() => {});
  if (source) report.sourceBodyExcerpt = (await source.locator('body').innerText().catch(() => '')).slice(0, 1800);
  if (downloadPage) report.downloadBodyExcerpt = (await downloadPage.locator('body').innerText().catch(() => '')).slice(0, 1800);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(pendingNetworkRecords);
  report.finishedAtUtc = new Date().toISOString();
  await fs.writeFile(path.join(evidence, 'live-browser-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await context.close();
}
