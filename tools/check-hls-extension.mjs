import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { library, browserExecutable, ffmpeg, ffprobe } from './runtime.mjs';

// Only two integration paths are exercised here. Media generation and detailed
// parser/codec regression coverage belong to test-hls.mjs.
const { chromium } = library('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const evidence = path.join(root, 'evidence', 'hls-extension');
await fs.mkdir(evidence, { recursive: true });
for (const type of ['ts', 'video', 'audio']) {
  try { await fs.access(path.join(root, 'evidence/hls', type, 'playlist.m3u8')); }
  catch { throw new Error('先运行 node tools/test-hls.mjs，生成自有 HLS 测试媒体。'); }
}
const profile = await fs.mkdtemp(path.join(evidence, 'profile-'));
const downloads = path.join(evidence, 'browser-downloads');
await fs.mkdir(downloads, { recursive: true });
// Attach without Playwright download defaults: CDP's download override replaces
// Chrome extension API filenames with Blob UUIDs even when behavior is 'allow'.
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
const pageErrors = [];
context.on('page', page => {
  page.on('pageerror', error => pageErrors.push(error.message));
});
const results = { source: 'Locally generated testsrc2+sine HLS, mocked public pages/CDNs; no real website playback claims', cases: [] };

try {
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js'))
    || await context.waitForEvent('serviceworker', { predicate: item => item.url().endsWith('/background.js'), timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  results.extensionId = extensionId;
  await context.route('https://hls.example.test/**', route => {
    const name = new URL(route.request().url()).pathname.includes('external') ? 'external' : 'ts';
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>自有 HLS ${name} 演示</title><h1>自有媒体</h1><a href="https://streams.example.test/${name}-master.m3u8">视频资源</a>` });
  });
  await context.route('https://streams.example.test/**', route => {
    const external = new URL(route.request().url()).pathname.includes('external');
    const playlist = external
      ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Default",DEFAULT=YES,URI="https://cdn-audio.example.test/audio/playlist.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,AUDIO="a"\nhttps://cdn-video.example.test/video/playlist.m3u8\n'
      : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nhttps://cdn-video.example.test/ts/playlist.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nhttps://cdn-video.example.test/ts/playlist.m3u8\n';
    return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: playlist });
  });
  for (const origin of ['cdn-video', 'cdn-audio']) {
    await context.route(`https://${origin}.example.test/**`, async route => {
      const pathname = new URL(route.request().url()).pathname;
      const filename = path.resolve(root, 'evidence/hls', `.${pathname}`);
      if (!filename.startsWith(path.resolve(root, 'evidence/hls') + path.sep)) throw new Error('Fixture path escaped');
      const body = await fs.readFile(filename);
      await route.fulfill({ contentType: filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
        : filename.endsWith('.ts') ? 'video/mp2t' : 'video/mp4', body });
    });
  }
  const popup = await context.newPage();
  await context.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || !globalThis.chrome?.downloads) return;
    const original = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = (options, ...args) => { globalThis.__downloadOptions = options; return original(options, ...args); };
  });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.setViewportSize({ width: 450, height: 720 });
  for (const kind of ['ts', 'external']) {
    await popup.bringToFront();
    const sourceUrl = `https://hls.example.test/watch-${kind}`;
    await popup.locator('#link-input').fill(sourceUrl);
    await popup.locator('#inspect-link-button').click();
    await popup.locator('#video-content').waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await popup.locator('#quality-select option').count(), 1);
    assert.match(await popup.locator('#quality-select').textContent(), /HLS/);
    const nextPage = context.waitForEvent('page');
    await popup.locator('#download-button').click();
    const runner = await nextPage;
    await runner.locator('#stage-label').filter({ hasText: '已保存到电脑' }).waitFor({ timeout: 45000 });
    const jobId = new URL(runner.url()).searchParams.get('job');
    const job = await worker.evaluate(async id => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], jobId);
    assert.equal(job.status, 'done');
    const [download] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
    const requestedDownload = await runner.evaluate(() => globalThis.__downloadOptions);
    assert.equal(download.state, 'complete');
    const suffix = kind === 'ts' ? 'ts' : 'mp4';
    assert.ok(job.filename.endsWith(`.${suffix}`));
    assert.ok(download.filename.endsWith(`.${suffix}`));
    assert.equal(requestedDownload.filename, job.filename);
    const output = path.join(evidence, `popup-${kind}.${suffix}`);
    await fs.copyFile(download.filename, output);
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' }));
    assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
    assert.ok(Math.abs(Number(probe.format.duration) - 4) < 0.12);
    execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'], { stdio: 'pipe' });
    const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    const rule = rules.find(item => item.id === job.headerRuleId);
    assert.ok(rule, 'download must have its own header rule');
    assert.deepEqual(rule.condition.tabIds, [job.downloadTabId]);
    assert.deepEqual(rule.condition.initiatorDomains, [extensionId]);
    assert.ok(rule.condition.requestDomains.includes('streams.example.test'));
    assert.ok(rule.condition.requestDomains.includes('cdn-video.example.test'));
    if (kind === 'external') assert.ok(rule.condition.requestDomains.includes('cdn-audio.example.test'));
    assert.equal(rule.action.requestHeaders.find(item => item.header.toLowerCase() === 'referer').value, sourceUrl);
    const unauthorizedFromPopup = await popup.evaluate(id => chrome.runtime.sendMessage({ type: 'MEDIA_ORIGIN', jobId: id, url: 'https://unauthorized.example.test/video.ts' }), jobId);
    const afterCompletion = await runner.evaluate(id => chrome.runtime.sendMessage({ type: 'MEDIA_ORIGIN', jobId: id, url: 'https://unauthorized.example.test/video.ts' }), jobId);
    assert.equal(unauthorizedFromPopup.ok, false);
    assert.equal(afterCompletion.ok, false);
    assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules()), rules, 'rejected authorization must not modify header rules');
    assert.equal(await runner.locator('#result-link').isVisible(), kind === 'external');
    results.cases.push({ kind, status: job.status, filename: job.filename, actualDownloadName: path.basename(download.filename), bytes: (await fs.stat(output)).size,
      duration: Number(probe.format.duration), streams: probe.streams.map(stream => stream.codec_name),
      storedMediaDomains: job.mediaDomains || [], ruleMediaDomains: rule.condition.requestDomains,
      ruleTabId: rule.condition.tabIds[0], runnerTabId: job.downloadTabId, outputMime: job.outputMime,
      deniedNonRunner: !unauthorizedFromPopup.ok, deniedCompletedJob: !afterCompletion.ok });
    await runner.screenshot({ path: path.join(evidence, `complete-${kind}.png`) });
    if (kind === 'external') {
      const previewPage = context.waitForEvent('page');
      await runner.locator('#result-link').click();
      const preview = await previewPage;
      await preview.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      const playback = await preview.evaluate(async () => {
        const video = document.querySelector('video');
        video.muted = true;
        await video.play();
        await new Promise(resolve => { video.addEventListener('seeked', resolve, { once: true }); video.currentTime = 2.4; });
        return { duration: video.duration, seekTime: video.currentTime, width: video.videoWidth, height: video.videoHeight };
      });
      assert.ok(playback.seekTime >= 2.39);
      results.cases.at(-1).playback = playback;
      await preview.close();
    }
  }
  assert.deepEqual(pageErrors, []);
  results.pageErrors = pageErrors;
  const cacheMismatch = results.cases.filter(item => [...item.ruleMediaDomains].sort().join('|') !== [...item.storedMediaDomains].sort().join('|'));
  results.mediaDomainsMatch = cacheMismatch.length === 0;
  await fs.writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  assert.equal(cacheMismatch.length, 0, 'runner status overwrote the worker-authorized mediaDomains cache');
} catch (error) {
  results.error = error.message;
  results.pageErrors = pageErrors;
  results.pages = await Promise.all(context.pages().map(async page => ({ url: page.url(), body: (await page.locator('body').innerText().catch(() => '')).slice(0, 2500), inspectButton: await page.locator('#inspect-link-button').evaluate(button => ({ disabled: button.disabled, rect: button.getBoundingClientRect().toJSON(), visibility: getComputedStyle(button).visibility, display: getComputedStyle(button).display })).catch(() => null) })));
  await fs.writeFile(path.join(evidence, 'verification.json'), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
  throw error;
} finally { await browser.close(); browserProcess.kill(); }
