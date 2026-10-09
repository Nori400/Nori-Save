import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { library, browserExecutable, ffmpeg, ffprobe } from './runtime.mjs';

// Popup DOM and gallery UI integration; all media is locally authored. A background
// popup tab exercises its controls while the source remains the browser's active
// tab, since headless action.openPopup exposes no inspectable page target.
const { chromium } = library('playwright');
const sharp = library('sharp');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const evidence = path.join(root, 'evidence/page-media');
await fs.mkdir(evidence, { recursive: true });
const video = await fs.readFile(path.join(root, 'evidence/hls/external-fmp4-audio.mp4')).catch(() => { throw new Error('先运行 node tools/test-hls.mjs，生成自有有声 MP4。'); });
const picture = sharp({ create: { width: 96, height: 64, channels: 3, background: '#fc735c' } });
const png = await picture.clone().png().toBuffer();
const jpeg = await picture.clone().jpeg({ quality: 87 }).toBuffer();
const webp = await picture.clone().webp({ quality: 82 }).toBuffer();
const lazy = await sharp({ create: { width: 80, height: 60, channels: 3, background: '#548efa' } }).png().toBuffer();
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="90" height="70"><rect width="90" height="70" fill="#08af74"/></svg>');
const images = new Map([
  ['/photo.png', { bytes: png, mime: 'image/png', extension: 'png' }],
  ['/misnamed.png', { bytes: jpeg, mime: 'image/jpeg', extension: 'jpg' }],
  ['/photo.webp', { bytes: webp, mime: 'image/webp', extension: 'webp' }],
  ['/without-extension', { bytes: png, mime: 'image/png', extension: 'png' }],
  ['/background.svg', { bytes: svg, mime: 'image/svg+xml', extension: 'svg' }],
  ['/lazy.png', { bytes: lazy, mime: 'image/png', extension: 'png' }],
  ['/shadow.webp', { bytes: webp, mime: 'image/webp', extension: 'webp' }],
  ['/frame-image.jpg', { bytes: jpeg, mime: 'image/jpeg', extension: 'jpg' }],
]);
for (const [name, item] of images) await fs.writeFile(path.join(evidence, name.slice(1)), item.bytes);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const profile = await fs.mkdtemp(path.join(evidence, 'profile-'));
const downloads = await fs.mkdtemp(path.join(evidence, 'downloads-'));
await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
await fs.writeFile(path.join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } }));
const browserProcess = spawn(browserExecutable || chromium.executablePath(), [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900', ...(process.env.NORI_SAVE_HEADFUL === '1' ? [] : ['--headless=new']),
  `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank'
], { windowsHide: true, stdio: 'ignore' });
let debugPort;
for (let attempts = 0; attempts < 100; attempts++) {
  try { debugPort = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!debugPort) { browserProcess.kill(); throw new Error('Browser did not expose DevTools port'); }
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { noDefaults: true });
const context = browser.contexts()[0];
const results = { source: 'Extension popup DOM and gallery; source active before current-page controls; mocked HTTPS sites; authored images and testsrc2+sine video', images: [] };
const pageErrors = [];
const messages = [];
context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
try {
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js'))
    || await context.waitForEvent('serviceworker', { predicate: item => item.url().endsWith('/background.js'), timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:') return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.__qaMessages = [];
    chrome.runtime.sendMessage = (...args) => {
      const message = args[0];
      const value = original(...args);
      if (value?.then) value.then(response => globalThis.__qaMessages.push({ message, response }));
      return value;
    };
  });
  await context.route('https://assets.page-media.example.test/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/video.mp4') return route.fulfill({ contentType: 'video/mp4', body: video });
    const item = images.get(pathname);
    return route.fulfill({ status: item ? 200 : 404, contentType: item?.mime || 'text/plain', body: item?.bytes || 'missing' });
  });
  await context.route('https://frame.page-media.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><img src="https://assets.page-media.example.test/frame-image.jpg" alt="frame image">' }));
  await context.route('https://page-media.example.test/**', route => {
    if (new URL(route.request().url()).pathname !== '/source') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>没有媒体</title><p>空页面</p>' });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>自有图片与视频演示</title>
      <img src="https://assets.page-media.example.test/photo.png" alt="PNG"><img src="https://assets.page-media.example.test/photo.png" alt="重复PNG">
      <picture><source srcset="https://assets.page-media.example.test/misnamed.png 1x, https://assets.page-media.example.test/photo.webp 2x"><img src="https://assets.page-media.example.test/photo.png" srcset="https://assets.page-media.example.test/without-extension 1x, https://assets.page-media.example.test/photo.webp 2x"></picture>
      <img data-src="https://assets.page-media.example.test/lazy.png" alt="懒加载"><div style="width:90px;height:70px;background-image:url('https://assets.page-media.example.test/background.svg')"></div>
      <video controls preload="metadata" poster="https://assets.page-media.example.test/photo.png" src="https://assets.page-media.example.test/video.mp4"></video>
      <div id="shadow"></div><iframe src="https://frame.page-media.example.test/frame"></iframe>
      <script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<img src="https://assets.page-media.example.test/shadow.webp" alt="shadow image">';</script>` });
  });
  const source = await context.newPage();
  await source.goto('https://page-media.example.test/source');
  await source.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  const [{ id: sourceTabId }] = await worker.evaluate(() => chrome.tabs.query({ url: 'https://page-media.example.test/source' }));
  async function extensionPage(fragment) {
    for (let attempts = 0; attempts < 100; attempts++) {
      const page = context.pages().find(item => item.url().includes(fragment));
      if (page) return page;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`Extension page did not open: ${fragment}`);
  }
  async function popupFor(page) {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.setViewportSize({ width: 450, height: 720 });
    await popup.locator('#current-video-button').waitFor();
    await page.bringToFront();
    return popup;
  }
  const popup = await popupFor(source);
  assert.equal(await popup.locator('#link-input').inputValue(), '');
  await popup.locator('#current-video-button').click({ force: true });
  await popup.locator('#video-content').waitFor({ state: 'visible' });
  assert.equal(await popup.locator('#link-input').inputValue(), 'https://page-media.example.test/source');
  await popup.bringToFront();
  await popup.locator('#download-button').click();
  const runner = await extensionPage('/download.html?job=');
  await runner.locator('#stage-label').filter({ hasText: '已保存到电脑' }).waitFor({ timeout: 45000 });
  const jobId = new URL(runner.url()).searchParams.get('job');
  const job = await worker.evaluate(async id => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], jobId);
  const [savedVideo] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
  assert.equal(savedVideo.state, 'complete');
  assert.ok(savedVideo.filename.endsWith('.mp4'));
  const videoOutput = await fs.readFile(savedVideo.filename);
  assert.equal(hash(videoOutput), hash(video));
  const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', savedVideo.filename], { encoding: 'utf8' }));
  assert.deepEqual(probe.streams.map(item => item.codec_type).sort(), ['audio', 'video']);
  execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', savedVideo.filename, '-f', 'null', '-'], { stdio: 'pipe' });
  messages.push(...await popup.evaluate(() => globalThis.__qaMessages));
  results.video = { sourceTabId, jobSourceTabId: job.sourceTabId, actualFilename: path.basename(savedVideo.filename), bytes: video.length, sha256: hash(videoOutput), streams: probe.streams.map(item => item.codec_name), currentPageMessage: messages.some(item => item.message.type === 'INSPECT_CURRENT') };
  assert.equal(job.sourceTabId, sourceTabId);
  assert.equal(results.video.currentPageMessage, true);
  console.log('Current-page video downloaded and fully decoded.');
  await popup.close().catch(() => {});
  const imagePopup = await popupFor(source);
  assert.equal(await imagePopup.locator('#link-input').inputValue(), '');
  await imagePopup.locator('#current-images-button').click({ force: true });
  const gallery = await extensionPage('/images.html?source=');
  await gallery.setViewportSize({ width: 1280, height: 900 });
  await gallery.bringToFront();
  await gallery.locator('.image-card').first().waitFor();
  const cached = await worker.evaluate(async id => (await chrome.storage.session.get(`images:${id}`))[`images:${id}`], sourceTabId);
  assert.equal(cached.page.url, 'https://page-media.example.test/source');
  assert.equal(cached.images.length, images.size);
  assert.equal(await gallery.locator('.image-card').count(), images.size);
  assert.deepEqual(cached.images.map(item => new URL(item.url).pathname).sort(), [...images.keys()].sort());
  console.log(`Gallery found ${cached.images.length} deduplicated image URLs, including shadow DOM and iframe.`);
  async function checkSavedImages() {
    const events = await gallery.evaluate(() => globalThis.__qaMessages.filter(item => item.message.type === 'SAVE_IMAGE'));
    for (const event of events.filter(item => item.response?.ok && !results.images.some(prior => prior.downloadId === item.response.downloadId))) {
      const [entry] = await worker.evaluate(id => chrome.downloads.search({ id }), event.response.downloadId);
      assert.equal(entry.state, 'complete');
      const item = images.get(new URL(event.message.url).pathname);
      assert.ok(entry.filename.endsWith(`.${item.extension}`));
      const bytes = await fs.readFile(entry.filename);
      assert.equal(hash(bytes), hash(item.bytes));
      results.images.push({ source: new URL(event.message.url).pathname, downloadId: entry.id, filename: path.basename(entry.filename), mime: item.mime, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  // Save the misleading .png URL as a single card; backend must choose JPEG.
  const jpegIndex = cached.images.findIndex(item => item.url.endsWith('/misnamed.png'));
  await gallery.locator(`.image-card[data-index="${jpegIndex}"] .card-save`).click();
  await gallery.locator('#batch-status').filter({ hasText: '已保存 1 张' }).waitFor();
  await checkSavedImages();
  assert.equal(results.images.length, 1);
  // A real user selection/batch completes all remaining image encodings.
  for (let index = 0; index < cached.images.length; index++) if (index !== jpegIndex) await gallery.locator(`.image-card[data-index="${index}"] .image-checkbox input`).check();
  await gallery.locator('#save-selected').click();
  await gallery.locator('#batch-status').filter({ hasText: `已保存 ${images.size - 1} 张` }).waitFor({ timeout: 45000 });
  await checkSavedImages();
  assert.equal(results.images.length, images.size);
  await gallery.screenshot({ path: path.join(evidence, 'gallery-saved.png'), fullPage: true });
  const [beforeNav] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  await source.goto('https://page-media.example.test/empty');
  await gallery.locator('.image-card').first().locator('.card-save').click();
  await gallery.locator('#batch-status').filter({ hasText: '已保存 0 张 · 1 张未完成' }).waitFor();
  assert.match(await gallery.locator('#batch-errors').innerText(), /来源页或图片列表已改变/);
  const [afterNav] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
  assert.equal(afterNav.id, beforeNav.id, 'stale gallery must not start a download');
  results.staleGalleryRejected = true;
  await gallery.locator('#refresh-images').click();
  await gallery.locator('#images-empty').waitFor({ state: 'visible' });
  assert.equal(await gallery.locator('.image-card').count(), 0);
  assert.equal(await gallery.locator('#save-selected').isEnabled(), false);
  results.emptyGallery = true;
  const emptyPopup = await popupFor(source);
  await emptyPopup.locator('#current-video-button').click({ force: true });
  await emptyPopup.locator('#empty-state').waitFor({ state: 'visible' });
  assert.equal(await emptyPopup.locator('#video-content').isVisible(), false);
  assert.match(await emptyPopup.locator('#empty-description').innerText(), /找到完整视频资源/);
  results.emptyVideoRejected = true;
  const internal = await context.newPage();
  await internal.goto('edge://version');
  const internalPopup = await popupFor(internal);
  await internalPopup.locator('#current-images-button').click({ force: true });
  await internalPopup.locator('#entry-status').filter({ hasText: '内部页面无法检索' }).waitFor({ state: 'visible' });
  assert.match(await internalPopup.locator('#entry-status').innerText(), /内部页面无法检索/);
  const internalVideo = await popupFor(internal);
  await internalVideo.locator('#current-video-button').click({ force: true });
  await internalVideo.locator('#empty-state').waitFor({ state: 'visible' });
  assert.match(await internalVideo.locator('#empty-description').innerText(), /内部页面无法检索/);
  results.internalPageRejected = true;
  messages.push(...await imagePopup.evaluate(() => globalThis.__qaMessages));
  assert.ok(messages.some(item => item.message.type === 'OPEN_IMAGES'));
  assert.deepEqual(pageErrors, []);
  results.pageErrors = pageErrors;
  await fs.writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  results.error = error.message;
  results.pageErrors = pageErrors;
  results.pages = await Promise.all(context.pages().map(async page => ({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 3000) })));
  await fs.writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  throw error;
} finally { await browser.close(); browserProcess.kill(); }
