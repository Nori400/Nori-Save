import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { library, browserExecutable, ffmpeg, ffprobe } from './runtime.mjs';
import { remuxTracks } from '../extension/lib/remux.js';
import { readVideoPage } from '../extension/lib/page.js';
import { parseVideoLink } from '../extension/lib/links.js';

const { chromium } = library('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const modes = new Set(process.argv.slice(2));
const runMock = !modes.has('--live-only');
const runLive = !modes.has('--mock-only');
const hash = data => createHash('sha256').update(data).digest('hex');
const ab = data => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
const probe = filename => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { encoding: 'utf8', timeout: 30000 }));
const decode = filename => execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', filename, '-f', 'null', '-'], { stdio: 'pipe', timeout: 45000 });
let failed = false;

async function browser(folder, report) {
  await fs.mkdir(folder, { recursive: true });
  const profile = await fs.mkdtemp(path.join(folder, 'profile-'));
  const downloads = path.join(folder, 'downloads');
  await fs.mkdir(downloads, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: browserExecutable,
    headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    viewport: { width: 1280, height: 1000 }, acceptDownloads: true, downloadsPath: downloads
  });
  report.browserVersion = context.browser()?.version();
  report.profile = profile;
  report.pageErrors = [];
  context.on('page', page => page.on('pageerror', error => report.pageErrors.push({ url: page.url(), error: error.message })));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extensionId = new URL(worker.url()).hostname;
  report.extensionId = extensionId;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return { context, worker, popup, extensionId };
}

async function inspectByInput(state, input) {
  const { popup, worker } = state;
  await popup.locator('#link-input').fill(input);
  await popup.locator('#inspect-link-button').click();
  await popup.waitForFunction(() => document.getElementById('loading-state').hidden, null, { timeout: 45000 });
  if (!(await popup.locator('#video-content').isVisible())) throw new Error(await popup.locator('#empty-description').textContent());
  const normalized = parseVideoLink(input).url;
  const cached = await worker.evaluate(async requestUrl => {
    const values = await chrome.storage.session.get(null);
    return Object.entries(values).filter(([key, value]) => key.startsWith('inspect:') && value.requestUrl === requestUrl)
      .map(([key, value]) => ({ ...value, sourceTabId: Number(key.slice(8)) })).sort((a, b) => b.capturedAt - a.capturedAt)[0];
  }, normalized);
  assert.ok(cached?.options?.length, 'The popup must have inspected real extension state.');
  return cached;
}

async function saveFromPopup(state, spec, folder) {
  const { context, worker, popup } = state;
  const cached = await inspectByInput(state, spec.input);
  if (spec.check) await spec.check(cached, state);
  const selected = spec.pick ? cached.options.find(spec.pick) : cached.options[0];
  assert.ok(selected, 'Expected downloadable option not found.');
  await popup.locator('#quality-select').selectOption(selected.id);
  const button = await popup.locator('#download-label').textContent();
  assert.match(button, spec.extension === 'webm' ? /WebM/ : /MP4/);
  await popup.waitForFunction(() => {
    const image = document.getElementById('video-cover');
    return !image.getAttribute('src') || image.complete;
  }, null, { timeout: 8000 }).catch(() => {});
  await popup.locator('.popup').screenshot({ path: path.join(folder, `${spec.name}-popup.png`) });
  const created = context.waitForEvent('page', { timeout: 15000 });
  await popup.locator('#download-button').click();
  const page = await created;
  await page.waitForURL(/chrome-extension:\/\/[^/]+\/download\.html/, { timeout: 15000 });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => ['已保存到电脑', '下载未完成', '无法开始下载', '视频已准备好'].includes(document.getElementById('stage-label')?.textContent), null, { timeout: 90000 });
  const stage = await page.locator('#stage-label').textContent();
  const error = await page.locator('#error-message').textContent();
  await page.screenshot({ path: path.join(folder, `${spec.name}-download.png`) });
  assert.equal(stage, '已保存到电脑', error);
  const jobId = new URL(page.url()).searchParams.get('job');
  const job = await worker.evaluate(async id => (await chrome.storage.session.get(`job:${id}`))[`job:${id}`], jobId);
  assert.equal(job.status, 'done');
  assert.equal(job.video.cid, cached.video.cid);
  const [entry] = await worker.evaluate(id => chrome.downloads.search({ id }), job.downloadId);
  assert.equal(entry.state, 'complete');
  // Playwright stores intercepted downloads under UUID paths. The extension's
  // requested filename is the user-visible name, while entry.filename locates
  // the actual downloaded bytes for validation.
  assert.ok(job.filename.endsWith(`.${spec.extension || 'mp4'}`));
  const output = path.join(folder, `${spec.name}.${spec.extension || 'mp4'}`);
  await fs.copyFile(entry.filename, output);
  const bytes = await fs.readFile(output);
  if (spec.bytes) assert.equal(hash(bytes), hash(spec.bytes), 'The saved file must contain the complete selected resource.');
  const media = probe(output);
  assert.deepEqual(media.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  if (spec.duration) assert.ok(Math.abs(Number(media.format.duration) - spec.duration) < 0.1);
  if (spec.width) assert.equal(media.streams.find(stream => stream.codec_type === 'video').width, spec.width);
  decode(output);
  const rules = await worker.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
  const rule = rules.find(item => item.id === job.headerRuleId);
  assert.deepEqual(rule?.condition.tabIds, [job.downloadTabId]);
  assert.deepEqual(rule.condition.initiatorDomains, [state.extensionId]);
  assert.ok(rule.condition.requestDomains.includes(new URL(selected.videoUrl).hostname));
  assert.equal(rule.action.requestHeaders.find(header => header.header.toLowerCase() === 'referer')?.value, job.video.url);
  return {
    name: spec.name, passed: true, source: parseVideoLink(spec.input).url,
    title: cached.video.title, cid: cached.video.cid, warning: cached.warning,
    listedOptions: cached.options.map(option => ({ label: option.label, kind: option.kind, extension: option.extension, url: option.videoUrl })),
    selected: selected.id, filename: job.filename, bytes: bytes.length,
    duration: Number(media.format.duration), fullDecodePassed: true,
    streams: media.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height })),
    headerRule: rule
  };
}

async function generateMedia(folder) {
  await fs.mkdir(folder, { recursive: true });
  let video;
  let audio;
  try {
    video = await fs.readFile(path.join(root, 'evidence/remux/normal-video.mp4'));
    audio = await fs.readFile(path.join(root, 'evidence/remux/normal-audio.m4a'));
  } catch {
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '3', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', path.join(folder, 'generated-video.mp4')], { stdio: 'pipe' });
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100', '-t', '3', '-vn', '-c:a', 'aac', path.join(folder, 'generated-audio.m4a')], { stdio: 'pipe' });
    video = await fs.readFile(path.join(folder, 'generated-video.mp4'));
    audio = await fs.readFile(path.join(folder, 'generated-audio.m4a'));
  }
  const merged = await remuxTracks(ab(video), ab(audio));
  const high = path.join(folder, 'generated.mp4');
  await fs.writeFile(high, new Uint8Array(await merged.arrayBuffer()));
  execFileSync(ffmpeg, ['-y', '-i', high, '-vf', 'scale=160:90', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'copy', path.join(folder, 'generated-low.mp4')], { stdio: 'pipe' });
  execFileSync(ffmpeg, ['-y', '-i', high, '-t', '1.5', '-vf', 'hue=h=90', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', path.join(folder, 'generated-second.mp4')], { stdio: 'pipe' });
  execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '1.5', '-c:v', 'libvpx-vp9', '-b:v', '160k', '-c:a', 'libopus', '-b:a', '48k', '-shortest', path.join(folder, 'generated.webm')], { stdio: 'pipe' });
  return {
    mp4: await fs.readFile(high), low: await fs.readFile(path.join(folder, 'generated-low.mp4')),
    second: await fs.readFile(path.join(folder, 'generated-second.mp4')), webm: await fs.readFile(path.join(folder, 'generated.webm')),
    duration: Number(probe(high).format.duration), secondDuration: Number(probe(path.join(folder, 'generated-second.mp4')).format.duration),
    webmDuration: Number(probe(path.join(folder, 'generated.webm')).format.duration)
  };
}

async function fulfillMedia(route, bytes, contentType) {
  const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(bytes.length - 1, range[2] ? Number(range[2]) : bytes.length - 1);
    headers['content-range'] = `bytes ${start}-${end}/${bytes.length}`;
    headers['content-length'] = String(end - start + 1);
    return route.fulfill({ status: 206, headers, body: bytes.subarray(start, end + 1) });
  }
  headers['content-length'] = String(bytes.length);
  return route.fulfill({ status: 200, headers, body: bytes });
}

async function mockChecks() {
  const folder = path.join(root, 'evidence/common');
  const report = { startedAtUtc: new Date().toISOString(), mockedRequests: true, generatedMedia: true, cases: [] };
  const media = await generateMedia(folder);
  const state = await browser(folder, report);
  const sourceOrigin = 'https://source.example.test';
  const mediaOrigin = 'https://cdn.example.test';
  const opaque = `${mediaOrigin}/assets/play?id=abc`;
  const fixture = JSON.parse(await fs.readFile(path.join(root, 'tools/fixtures/x-playinfo.json'), 'utf8'));
  const xOrigin = 'https://video.twimg.com/ext_tw_video';
  const highX = `${xOrigin}/1900000000000000001/pu/vid/320x180/high.mp4`;
  const lowX = `${xOrigin}/1900000000000000001/pu/vid/160x90/low.mp4`;
  const secondX = `${xOrigin}/1900000000000000003/pu/vid/320x180/second.mp4`;
  fixture.mediaDetails[0].video_info = { duration_millis: media.duration * 1000, variants: [
    { content_type: 'video/mp4', bitrate: 500000, url: highX }, { content_type: 'video/mp4', bitrate: 150000, url: lowX }
  ] };
  fixture.mediaDetails[2].video_info = { duration_millis: media.secondDuration * 1000, variants: [{ content_type: 'video/mp4', bitrate: 500000, url: secondX }] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e7eef9"/><rect x="170" y="70" width="300" height="210" rx="30" fill="#7998c7"/><path d="m280 125 100 55-100 55z" fill="white"/></svg>';
  let opaqueStarted;
  const opaqueRequest = new Promise(resolve => { opaqueStarted = resolve; });
  try {
    await state.context.route(`${sourceOrigin}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/ready.svg') {
        await opaqueRequest;
        await new Promise(resolve => setTimeout(resolve, 200));
        return route.fulfill({ contentType: 'image/svg+xml', body: svg });
      }
      if (url.pathname === '/cover.svg') return route.fulfill({ contentType: 'image/svg+xml', body: svg });
      let body;
      if (url.pathname === '/watch/mp4') body = `<video controls preload="metadata" src="${mediaOrigin}/assets/dom.mp4"></video>`;
      else if (url.pathname === '/watch/webm') body = `<video controls preload="metadata"><source src="${mediaOrigin}/assets/dom.webm" type="video/webm"></video>`;
      else if (url.pathname === '/watch/performance') body = '<script>const xhr=new XMLHttpRequest();xhr.open("GET","/assets/performance.mp4",false);xhr.send();</script>';
      else if (url.pathname === '/assets/performance.mp4') return fulfillMedia(route, media.mp4, 'video/mp4');
      else if (url.pathname === '/watch/network') body = `<script>fetch("${opaque}").then(r=>r.arrayBuffer()).then(b=>{const v=document.createElement("video");v.src=URL.createObjectURL(new Blob([b],{type:"video/mp4"}));v.controls=true;document.body.append(v);document.body.dataset.ready="yes";});</script><img src="/ready.svg">`;
      else return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Generated ${url.pathname.split('/').pop()} video</title><meta property="og:image" content="${sourceOrigin}/cover.svg"><body>${body}</body>` });
    });
    await state.context.route(`${mediaOrigin}/**`, route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/assets/play') { opaqueStarted(); return fulfillMedia(route, media.mp4, 'video/mp4'); }
      return fulfillMedia(route, url.pathname.endsWith('.webm') ? media.webm : media.mp4, url.pathname.endsWith('.webm') ? 'video/webm' : 'video/mp4');
    });
    await state.context.route('https://x.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Generated X source page</title>' }));
    await state.context.route('https://cdn.syndication.twimg.com/tweet-result?**', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture) }));
    await state.context.route('https://pbs.twimg.com/**', route => route.fulfill({ contentType: 'image/svg+xml', body: svg }));
    for (const [url, data] of [[highX, media.mp4], [lowX, media.low], [secondX, media.second]]) await state.context.route(url, route => fulfillMedia(route, data, 'video/mp4'));
    const sourcePageCheck = (expected, onlyNetwork = false) => async (cached, { context, worker }) => {
      const tab = await worker.evaluate(id => chrome.tabs.get(id), cached.sourceTabId);
      const page = context.pages().find(page => page.url() === tab.url);
      assert.ok(page);
      const snapshot = await page.evaluate(readVideoPage);
      if (onlyNetwork) {
        assert.equal(snapshot.candidates.length, 0, 'A MIME-only resource should not appear as a DOM/performance URL candidate.');
        const watch = await worker.evaluate(async id => (await chrome.storage.session.get(`watch:${id}`))[`watch:${id}`], cached.sourceTabId);
        assert.ok(watch.candidates.some(candidate => candidate.url === expected && candidate.mimeType.startsWith('video/mp4')));
      } else assert.ok(snapshot.candidates.some(candidate => candidate.url === expected));
      assert.ok(cached.options.some(option => option.videoUrl === expected));
    };
    const specs = [
      { name: 'generic-dom-mp4', input: `${sourceOrigin}/watch/mp4`, bytes: media.mp4, duration: media.duration, width: 320, check: sourcePageCheck(`${mediaOrigin}/assets/dom.mp4`) },
      { name: 'generic-dom-webm', input: `${sourceOrigin}/watch/webm`, extension: 'webm', bytes: media.webm, duration: media.webmDuration, width: 160, check: sourcePageCheck(`${mediaOrigin}/assets/dom.webm`) },
      { name: 'generic-performance', input: `${sourceOrigin}/watch/performance`, bytes: media.mp4, duration: media.duration, check: sourcePageCheck(`${sourceOrigin}/assets/performance.mp4`) },
      { name: 'generic-network-mime', input: `${sourceOrigin}/watch/network`, bytes: media.mp4, duration: media.duration, check: sourcePageCheck(opaque, true) },
      { name: 'x-first-low', input: `https://x.com/demo/status/${fixture.id_str}`, bytes: media.low, duration: media.duration, width: 160,
        pick: option => option.videoUrl === lowX, check: async cached => { assert.equal(cached.video.cid, 1); assert.match(cached.video.title, /媒体 1\/3/); assert.match(cached.warning, /1\/3/); } },
      { name: 'x-third-media', input: `https://x.com/demo/status/${fixture.id_str}/video/3`, bytes: media.second, duration: media.secondDuration, width: 320,
        check: async cached => { assert.equal(cached.video.cid, 3); assert.match(cached.video.title, /媒体 3\/3/); assert.equal(cached.options[0].videoUrl, secondX); } }
    ];
    for (const spec of specs) {
      try { report.cases.push(await saveFromPopup(state, spec, folder)); }
      catch (error) { failed = true; report.cases.push({ name: spec.name, passed: false, error: error.message }); }
      console.log(JSON.stringify(report.cases.at(-1)));
    }
    assert.deepEqual(report.pageErrors.filter(item => item.url.startsWith('chrome-extension:')), []);
  } catch (error) { failed = true; report.error = error.message; }
  finally {
    report.finishedAtUtc = new Date().toISOString();
    report.passed = !report.error && report.cases.length === 6 && report.cases.every(item => item.passed);
    await fs.writeFile(path.join(folder, 'browser-check.json'), JSON.stringify(report, null, 2));
    await state.context.close();
  }
}

async function liveXCheck() {
  const folder = path.join(root, 'evidence/x-browser');
  const report = { startedAtUtc: new Date().toISOString(), mockedRequests: false, cookiesImported: false, siteAttempts: 1, network: [] };
  const state = await browser(folder, report);
  const pending = [];
  state.context.on('response', response => {
    const url = new URL(response.url());
    if (!['cdn.syndication.twimg.com', 'video.twimg.com'].includes(url.hostname)) return;
    if (url.hostname === 'video.twimg.com') {
      try { if (!response.request().frame().url().startsWith('chrome-extension:')) return; }
      catch { return; }
    }
    pending.push((async () => {
      const headers = await response.request().allHeaders();
      report.network.push({ host: url.hostname, path: url.pathname, status: response.status(), referer: headers.referer || null, contentType: response.headers()['content-type'] || null });
    })().catch(() => {}));
  });
  try {
    report.download = await saveFromPopup(state, { name: 'real-x', input: 'https://x.com/DavidToons_/status/1578353380363501568', duration: 4.458667, width: 720 }, folder);
    await Promise.allSettled(pending);
    assert.ok(report.network.some(item => item.host === 'cdn.syndication.twimg.com' && item.status === 200));
    assert.ok(report.network.some(item => item.host === 'video.twimg.com' && item.status === 200));
    assert.deepEqual(report.pageErrors.filter(item => item.url.startsWith('chrome-extension:')), []);
    report.passed = true;
  } catch (error) {
    failed = true; report.passed = false; report.error = error.message;
    await state.popup.locator('.popup').screenshot({ path: path.join(folder, 'failure-popup.png') }).catch(() => {});
  } finally {
    await Promise.allSettled(pending);
    report.finishedAtUtc = new Date().toISOString();
    await fs.writeFile(path.join(folder, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ liveX: report }, null, 2));
    await state.context.close();
  }
}

if (runMock) await mockChecks();
if (runLive) await liveXCheck();
if (failed) process.exitCode = 1;
