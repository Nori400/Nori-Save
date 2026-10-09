import { normalizePlayInfo, readSourcePage } from './lib/site-api.js';
import { parseVideoLink } from './lib/links.js';
import { mediaKind, normalizeCandidates, safeHttpUrl, safeFilename } from './lib/media.js';
import { readVideoPage } from './lib/page.js';
import { inspectX } from './lib/x.js';
import { inspectPublicSite } from './lib/public-sites.js';
import { readImagesPage, imageFilename } from './lib/images.js';

// Only tabs explicitly submitted by the user are observed.
const captureQueues = new Map();
const mediaQueues = new Map();
let startQueue = Promise.resolve();
let ruleQueue = Promise.resolve();
let imageQueue = Promise.resolve();

async function scopedRule(preferredId, action, condition) {
  const pending = ruleQueue.catch(() => {}).then(async () => {
    let ruleId = preferredId;
    if (!ruleId) {
      const used = new Set((await chrome.declarativeNetRequest.getSessionRules()).map(rule => rule.id));
      ruleId = 100;
      while (used.has(ruleId)) ruleId++;
    }
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules: [{ id: ruleId, priority: 2, action, condition }] });
    return ruleId;
  });
  ruleQueue = pending;
  return pending;
}

async function currentSource() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !safeHttpUrl(tab.url)) throw new Error('请先切换到需要检索的网页，再点击插件图标。浏览器内部页面无法检索。');
  return tab;
}

async function inspectCurrent() {
  const tab = await currentSource();
  await watchTab(tab.id, tab.url, tab.url);
  const result = await inspect(tab.id, tab.url);
  const watch = (await chrome.storage.session.get(`watch:${tab.id}`))[`watch:${tab.id}`];
  if (watch) await chrome.storage.session.set({ [`watch:${tab.id}`]: { ...watch, loadedUrl: tab.url } });
  return { ...result, sourceTabId: tab.id };
}

async function inspectImages(tabId, sender) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !safeHttpUrl(tab.url)) throw new Error('来源网页已关闭或无法读取，请回到网页重新打开图片检索。');
  const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: readImagesPage });
  const unique = new Map();
  for (const result of results) for (const image of result.result?.images || []) {
    const url = safeHttpUrl(image.url);
    if (!url) continue;
    const prior = unique.get(url);
    unique.set(url, { ...image, url, width: Math.max(prior?.width || 0, image.width || 0), height: Math.max(prior?.height || 0, image.height || 0) });
  }
  const main = results.find(result => result.result?.page?.url === tab.url)?.result;
  const value = { page: { title: main?.page?.title || tab.title || '当前页面', url: tab.url }, images: [...unique.values()].slice(0, 1200), capturedAt: Date.now() };
  await chrome.storage.session.set({ [`images:${tabId}`]: value });
  if (sender?.tab?.id != null && sender.url === chrome.runtime.getURL(`images.html?source=${tabId}`)) {
    const galleryKey = `gallery:${sender.tab.id}`;
    const prior = (await chrome.storage.session.get(galleryKey))[galleryKey];
    const domains = [...new Set(value.images.map(image => new URL(image.url).hostname))];
    if (domains.length) {
      const ruleId = await scopedRule(prior?.ruleId,
        { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: tab.url }] },
        { tabIds: [sender.tab.id], initiatorDomains: [chrome.runtime.id], requestDomains: domains, resourceTypes: ['image'] });
      await chrome.storage.session.set({ [galleryKey]: { ruleId, sourceTabId: tabId } });
    } else if (prior?.ruleId) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [prior.ruleId] });
      await chrome.storage.session.remove(galleryKey);
    }
  }
  return { ok: true, ...value };
}

async function saveImage(message, sender) {
  if (!sender.url?.startsWith(chrome.runtime.getURL('images.html?source='))) throw new Error('请从图片列表中选择要保存的图片。');
  const sourceId = Number(new URL(sender.url).searchParams.get('source'));
  const cached = (await chrome.storage.session.get(`images:${sourceId}`))[`images:${sourceId}`];
  const tab = await chrome.tabs.get(sourceId).catch(() => null);
  const url = safeHttpUrl(message.url);
  if (message.tabId !== sourceId || !cached || !tab || tab.url !== cached.page.url || !url || !cached.images.some(image => image.url === url)) throw new Error('来源页或图片列表已改变，请重新检索后保存。');
  let ruleId;
  try {
    ruleId = await scopedRule(null, { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: cached.page.url }] },
      { tabIds: [-1], initiatorDomains: [chrome.runtime.id], urlFilter: `|${url}|`, resourceTypes: ['xmlhttprequest', 'other'] });
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000), cache: 'no-store' });
    if (!response.ok) throw new Error(`图片服务器返回 ${response.status}，未保存该图片。`);
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
    if (!extensions[mime]) throw new Error('来源返回的内容不是可保存的图片。');
    const maximum = 32 * 1024 * 1024;
    const expected = response.headers.get('content-encoding') ? 0 : Number(response.headers.get('content-length')) || 0;
    if (expected > maximum) throw new Error('单张图片超过32 MB，请通过来源网页保存。');
    if (response.status === 206) {
      const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
      if (!range || Number(range[1]) !== 0 || Number(range[2]) + 1 !== Number(range[3])) throw new Error('图片只返回部分内容，未保存不完整文件。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('图片没有返回数据。');
    const chunks = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maximum) throw new Error('单张图片超过32 MB，请通过来源网页保存。');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!received || (expected && expected !== received)) throw new Error('图片传输不完整，请重试。');
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    const filename = imageFilename(cached.page.title, message.filename, extensions[mime]);
    const downloadId = await chrome.downloads.download({ url: `data:${mime};base64,${btoa(binary)}`, filename, saveAs: false, conflictAction: 'uniquify' });
    return { ok: true, downloadId, filename };
  } finally { if (ruleId) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {}); }
}
chrome.webRequest.onResponseStarted.addListener(details => {
  if (details.tabId < 0) return;
  const header = name => details.responseHeaders?.find(item => item.name.toLowerCase() === name)?.value || '';
  const mimeType = header('content-type');
  const kind = mediaKind(details.url, mimeType);
  if (!kind || kind === 'manifest' || !safeHttpUrl(details.url)) return;
  const pending = (captureQueues.get(details.tabId) || Promise.resolve()).then(async () => {
    const key = `watch:${details.tabId}`;
    const watch = (await chrome.storage.session.get(key))[key];
    if (!watch || Date.now() - watch.startedAt > 3600000) return;
    const range = header('content-range').match(/^bytes \d+-\d+\/(\d+)$/i);
    const item = { url: details.url, mimeType, size: Number(range?.[1] || header('content-length')) || 0 };
    const candidates = [...(watch.candidates || []).filter(previous => previous.url !== item.url), item].slice(-60);
    await chrome.storage.session.set({ [key]: { ...watch, candidates } });
  }).catch(console.error);
  captureQueues.set(details.tabId, pending);
  pending.finally(() => { if (captureQueues.get(details.tabId) === pending) captureQueues.delete(details.tabId); });
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

function sourceVideo(url, title = '视频', extra = {}) {
  let hash = 2166136261;
  for (const character of url) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return { bvid: `page-${hash >>> 0}`, cid: 0, title, part: '', page: 1, pages: [], cover: '', duration: 0, url, ...extra };
}

async function watchTab(tabId, url, loadedUrl) {
  const key = `watch:${tabId}`;
  const prior = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.set({ [key]: { url, loadedUrl, startedAt: Date.now(), candidates: prior?.url === url ? prior.candidates : [] } });
}

async function inspect(tabId, requestUrl) {
  if (!Number.isInteger(tabId)) throw new Error('没有找到来源标签页。');
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('来源页已关闭，请重新粘贴链接并识别。');
  const previous = (await chrome.storage.session.get(`inspect:${tabId}`))[`inspect:${tabId}`];
  const input = parseVideoLink(requestUrl || previous?.requestUrl || tab.url);
  let result;
  let independent = false;
  let adapterError;
  if (input.kind === 'x') {
    result = await inspectX(input.url);
    if (!result?.ok) throw new Error(result?.error || 'X 未提供可用的公开视频资源。');
    independent = true;
  } else if (input.kind === 'direct') {
    const options = normalizeCandidates([{ url: input.url }]);
    result = { video: sourceVideo(input.url, new URL(input.url).pathname.split('/').pop() || '视频'), options };
    independent = true;
  } else {
    try { result = await inspectPublicSite(input.url); independent = !!result; }
    catch (error) { adapterError = error; }
  }
  if (!result && /^https:\/\/www\.bilibili\.com\/video\/(BV\w+|av\d+)/i.test(tab.url || '')) {
    const [execution] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readSourcePage });
    const snapshot = execution?.result;
    if (!snapshot?.ok) throw new Error(snapshot?.error || '请刷新来源页后重试。');
    result = { video: snapshot.video, options: normalizePlayInfo(snapshot.video, snapshot.playInfo), warning: snapshot.warning };
  }
  if (!result) {
    if (!safeHttpUrl(tab.url)) throw adapterError || new Error('来源页未能打开，请检查链接后重试。');
    const executions = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: readVideoPage });
    const pages = executions.map(item => item.result).filter(Boolean);
    await captureQueues.get(tabId);
    const watch = (await chrome.storage.session.get(`watch:${tabId}`))[`watch:${tabId}`];
    const options = normalizeCandidates([...pages.flatMap(page => page.candidates || []), ...(watch?.candidates || [])]);
    if (!options.length) {
      if (pages.some(page => page.protectedVideo)) throw new Error('此视频使用加密播放，无法直接下载。');
      throw adapterError || new Error('还没有找到完整视频资源。请在打开的来源页播放几秒，再点击重新识别。');
    }
    const main = pages.find(page => page.url === tab.url) || pages[0] || {};
    result = { video: sourceVideo(tab.url, main.title || '视频', { cover: main.cover || '', duration: main.duration || 0 }), options,
      warning: '资源由来源网页提供；如有多段，请选择需要的视频。' };
  }
  if (!result.options?.length) throw new Error('来源页未提供可下载的视频。请确认视频可以播放后重试。');
  const value = { ...result, independent, capturedAt: Date.now(), tabUrl: tab.url, requestUrl: input.url };
  await chrome.storage.session.set({ [`inspect:${tabId}`]: value });
  return { ok: true, video: value.video, options: value.options, warning: value.warning };
}

async function waitForSource(tabId) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); chrome.tabs.onRemoved.removeListener(removed); };
    const check = tab => {
      if (tab.status !== 'complete' || /^https:\/\/b23\.tv\//i.test(tab.url || '')) return;
      cleanup();
      if (safeHttpUrl(tab.url)) resolve(tab);
      else reject(new Error('来源页未能打开，请检查链接后重试。'));
    };
    const updated = (changedId, _change, tab) => { if (changedId === tabId) check(tab); };
    const removed = changedId => { if (changedId === tabId) { cleanup(); reject(new Error('来源页已关闭，请重新识别。')); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('来源页加载超时，请在打开的来源页确认视频能播放后重新识别。')); }, 30000);
    chrome.tabs.onUpdated.addListener(updated);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(tabId).then(check).catch(() => { cleanup(); reject(new Error('来源页已关闭，请重新识别。')); });
  });
}

async function inspectLink(input) {
  const parsed = parseVideoLink(input);
  const sourceKey = `source:${parsed.url}`;
  const stored = (await chrome.storage.session.get(sourceKey))[sourceKey];
  let source = stored?.tabId != null ? await chrome.tabs.get(stored.tabId).catch(() => null) : null;
  if (source && source.url !== stored.resolvedUrl) source = null;
  if (!source) {
    const tabs = await chrome.tabs.query({ url: `${new URL(parsed.url).origin}/*` });
    source = tabs.find(tab => { try { return parseVideoLink(tab.url).url === parsed.url; } catch { return false; } });
  }
  if (!source) {
    source = await chrome.tabs.create({ url: 'about:blank', active: false });
    if (parsed.kind !== 'direct') await watchTab(source.id, parsed.url);
    await chrome.storage.session.set({ [sourceKey]: { tabId: source.id, resolvedUrl: parsed.kind === 'direct' ? 'about:blank' : parsed.url } });
    if (parsed.kind !== 'direct') await chrome.tabs.update(source.id, { url: parsed.url });
  } else await watchTab(source.id, parsed.url, source.url);
  if (['x', 'direct'].includes(parsed.kind) || /^(?:www\.|player\.|geo\.)?(?:vimeo\.com|dailymotion\.com|dai\.ly)$/.test(new URL(parsed.url).hostname)) {
    const result = await inspect(source.id, parsed.url).catch(async error => {
      await chrome.storage.session.remove(`watch:${source.id}`);
      throw error;
    });
    if ((await chrome.storage.session.get(`inspect:${source.id}`))[`inspect:${source.id}`]?.independent) await chrome.storage.session.remove(`watch:${source.id}`);
    return { ...result, sourceTabId: source.id };
  }
  const loaded = await waitForSource(source.id).catch(async error => {
    await chrome.storage.session.remove(`watch:${source.id}`);
    throw error;
  });
  await chrome.storage.session.set({ [sourceKey]: { tabId: source.id, resolvedUrl: loaded.url } });
  const watch = (await chrome.storage.session.get(`watch:${source.id}`))[`watch:${source.id}`];
  if (watch) await chrome.storage.session.set({ [`watch:${source.id}`]: { ...watch, loadedUrl: loaded.url } });
  const result = await inspect(source.id, parsed.url);
  return { ...result, sourceTabId: source.id };
}

async function mediaHeaders(job, raw) {
  const url = safeHttpUrl(raw);
  if (!url) throw new Error('视频资源地址不可用。');
  const domains = [...new Set([...(job.mediaDomains || []), new URL(url).hostname])];
  if (domains.length > 80) throw new Error('视频来源过多，无法继续此下载。');
  const referer = safeHttpUrl(job.video.url) || url;
  const ruleId = await scopedRule(job.headerRuleId,
    { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
    { tabIds: [job.downloadTabId], initiatorDomains: [chrome.runtime.id], requestDomains: domains, resourceTypes: ['xmlhttprequest', 'other'] });
  const latest = (await chrome.storage.session.get(`job:${job.id}`))[`job:${job.id}`] || job;
  const next = { ...job, ...latest, downloadTabId: job.downloadTabId, headerRuleId: ruleId, mediaDomains: domains };
  await chrome.storage.session.set({ [`job:${job.id}`]: next });
  return next;
}

async function authorizeMedia(message, sender) {
  const pending = (mediaQueues.get(message.jobId) || Promise.resolve()).catch(() => {}).then(async () => {
    const job = (await chrome.storage.session.get(`job:${message.jobId}`))[`job:${message.jobId}`];
    if (!job || sender.tab?.id !== job.downloadTabId || sender.url !== chrome.runtime.getURL(`download.html?job=${job.id}`) || !['created', 'running'].includes(job.status)) throw new Error('下载任务已失效，请重新开始。');
    await mediaHeaders(job, message.url);
    return { ok: true };
  });
  mediaQueues.set(message.jobId, pending);
  try { return await pending; }
  finally { if (mediaQueues.get(message.jobId) === pending) mediaQueues.delete(message.jobId); }
}

async function startDownload(message) {
  const key = `inspect:${message.tabId}`;
  let cached = (await chrome.storage.session.get(key))[key];
  const tab = await chrome.tabs.get(message.tabId);
  if (!cached || (!cached.independent && cached.tabUrl !== tab.url) || cached.video.bvid !== message.bvid || cached.video.cid !== message.cid) throw new Error('视频页面已切换，请重新识别后下载。');
  if (Date.now() - cached.capturedAt > 120000) {
    await inspect(message.tabId);
    cached = (await chrome.storage.session.get(key))[key];
    if (cached.video.bvid !== message.bvid || cached.video.cid !== message.cid) throw new Error('当前视频已改变，请重新识别后下载。');
  }
  const option = cached.options.find(item => item.id === message.optionId);
  if (!option) throw new Error('这个资源暂时不可用，请重新识别。');
  const all = await chrome.storage.session.get(null);
  const oldJobs = Object.entries(all).filter(([name, value]) => name.startsWith('job:') && Date.now() - value.createdAt > 86400000).map(([name]) => name);
  if (oldJobs.length) await chrome.storage.session.remove(oldJobs);
  const active = Object.values(all).filter(value => value?.type === 'download-job' && ['created', 'running', 'saving'].includes(value.status) && Date.now() - value.createdAt < 86400000);
  if (active.length >= 3) throw new Error('已有3个下载任务，请先完成或取消其中一个。');
  const id = crypto.randomUUID();
  let job = { type: 'download-job', id, sourceTabId: message.tabId, createdAt: Date.now(), status: 'created', video: cached.video, option, filename: safeFilename(cached.video, option.extension || 'mp4'), saveAs: !!message.saveAs };
  await chrome.storage.session.set({ [`job:${id}`]: job });
  let downloadTab;
  try {
    downloadTab = await chrome.tabs.create({ url: 'about:blank' });
    job = { ...job, downloadTabId: downloadTab.id };
    await chrome.storage.session.set({ [`job:${id}`]: job });
    for (const url of [option.videoUrl, ...(option.videoBackups || []), option.audioUrl, ...(option.audioBackups || [])].filter(Boolean)) job = await mediaHeaders(job, url);
    await chrome.tabs.update(downloadTab.id, { url: chrome.runtime.getURL(`download.html?job=${id}`) });
  } catch (error) {
    await chrome.storage.session.remove(`job:${id}`);
    if (downloadTab) await chrome.tabs.remove(downloadTab.id).catch(() => {});
    throw error;
  }
  return { ok: true, jobId: id };
}

chrome.runtime.onInstalled.addListener(() => chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1] }).catch(console.error));
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const task = message?.type === 'INSPECT_LINK' ? () => inspectLink(message.url)
    : message?.type === 'INSPECT_CURRENT' ? inspectCurrent
    : message?.type === 'OPEN_IMAGES' ? async () => {
      const tab = await currentSource();
      await chrome.tabs.create({ url: chrome.runtime.getURL(`images.html?source=${tab.id}`) });
      return { ok: true };
    }
    : message?.type === 'INSPECT_IMAGES' ? () => inspectImages(message.tabId, sender)
    : message?.type === 'SAVE_IMAGE' ? () => {
      const pending = imageQueue.catch(() => {}).then(() => saveImage(message, sender));
      imageQueue = pending;
      return pending;
    }
    : message?.type === 'INSPECT' ? () => inspect(message.tabId)
    : message?.type === 'START_DOWNLOAD' ? () => {
      const pending = startQueue.catch(() => {}).then(() => startDownload(message));
      startQueue = pending;
      return pending;
    }
    : message?.type === 'MEDIA_ORIGIN' ? () => authorizeMedia(message, sender) : null;
  if (!task) return false;
  task().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || '操作失败，请重试。' }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  captureQueues.delete(tabId);
  await chrome.storage.session.remove([`inspect:${tabId}`, `watch:${tabId}`, `images:${tabId}`, `gallery:${tabId}`]);
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.filter(rule => rule.condition.tabIds?.includes(tabId)).map(rule => rule.id) }).catch(() => {});
  const all = await chrome.storage.session.get(null);
  for (const [key, job] of Object.entries(all)) {
    if (key.startsWith('job:') && job.downloadTabId === tabId && ['running', 'created', 'saving'].includes(job.status)) await chrome.storage.session.set({ [key]: { ...job, status: 'cancelled' } });
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  (async () => {
    const watch = (await chrome.storage.session.get(`watch:${tabId}`))[`watch:${tabId}`];
    if (watch?.loadedUrl && change.url !== watch.loadedUrl) await chrome.storage.session.remove(`watch:${tabId}`);
  })().catch(console.error);
});

