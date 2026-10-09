import { MAX_INPUT_BYTES, safeHttpUrl, safeFilename, validateWebM } from './lib/media.js';
import { remuxTracks, validateDirectMp4 } from './lib/remux.js';
import { downloadHls } from './lib/hls.js';

const $ = id => document.getElementById(id);
const id = new URL(location.href).searchParams.get('job');
const key = `job:${id}`;
let job;
let controller;
let blob;
let blobUrl;
let currentDownload;
let busy = false;
let loaded = [0, 0];
let totals = [0, 0];
let startedAt;

const bytes = value => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
function progress(value, stage, detail) {
  const percentage = Math.min(100, Math.max(0, Math.round(value)));
  $('progress-value').textContent = `${percentage}%`;
  $('progress-bar').style.width = `${percentage}%`;
  $('progress-bar').parentElement.setAttribute('aria-valuenow', String(percentage));
  $('stage-label').textContent = stage;
  if (detail) $('transfer-detail').textContent = detail;
}
async function status(value, extra = {}) {
  const latest = (await chrome.storage.session.get(key))[key];
  job = { ...job, ...latest, ...extra, status: value };
  await chrome.storage.session.set({ [key]: job });
}
function clearActions() {
  for (const name of ['retry-button', 'save-button', 'result-link', 'open-downloads']) $(name).hidden = true;
  $('error-message').hidden = true;
  $('cancel-button').hidden = false;
  $('cancel-button').disabled = false;
  $('status-orb').className = 'status-orb';
}
function networkProgress() {
  const received = loaded[0] + loaded[1];
  const total = totals[0] + totals[1];
  const known = totals[0] > 0 && (job.option.kind === 'direct' || totals[1] > 0);
  const estimate = known ? total : job.option.estimatedBytes;
  const percent = estimate > 0 ? Math.min(75, received / estimate * 75) : Math.min(65, received / 1024 ** 2);
  const speed = received / Math.max(1, (performance.now() - startedAt) / 1000);
  progress(percent, '正在下载视频', `${bytes(received)}${known ? ` / ${bytes(total)}` : ''} · ${bytes(speed)}/s`);
}

async function fetchTrack(urls, index, signal) {
  let lastError;
  for (const raw of [...new Set(urls)].filter(Boolean)) {
    signal.throwIfAborted();
    const url = safeHttpUrl(raw);
    if (!url) continue;
    loaded[index] = 0;
    totals[index] = 0;
    const local = new AbortController();
    const cancel = () => local.abort(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    let timer;
    let timedOut = false;
    const heartbeat = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; local.abort(); }, 35000);
    };
    let reader;
    try {
      await authorizeUrl(url);
      heartbeat();
      const response = await fetch(url, { credentials: 'omit', signal: local.signal, cache: 'no-store', redirect: 'error' });
      if (!response.ok) throw new Error(response.status === 403 || response.status === 410 ? '视频地址已过期或被来源网站拒绝，请重新识别后下载。' : `视频服务器返回 ${response.status}，请稍后重试。`);
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
        if (!range || Number(range[1]) !== 0 || Number(range[2]) + 1 !== Number(range[3])) throw new Error('服务器只返回了部分视频，未保存不完整文件。请重试。');
      }
      if (/text\/|application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('视频服务器返回了错误页面，请在来源页重新播放后再试。');
      totals[index] = Number(response.headers.get('content-length')) || 0;
      if (totals[0] + totals[1] > MAX_INPUT_BYTES) throw new Error('视频超过本版的512 MB合成上限，请选择较低清晰度。');
      reader = response.body?.getReader();
      if (!reader) throw new Error('浏览器没有返回视频数据，请重试。');
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        heartbeat();
        loaded[index] += value.byteLength;
        if (loaded[0] + loaded[1] > MAX_INPUT_BYTES) throw new Error('视频超过本版的512 MB合成上限，请选择较低清晰度。');
        chunks.push(value);
        networkProgress();
      }
      if (!loaded[index] || (totals[index] && loaded[index] !== totals[index])) throw new Error('视频传输中断，未保存不完整文件。请重试。');
      const data = new Uint8Array(loaded[index]);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
      chunks.length = 0;
      return data.buffer;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      lastError = new Error(timedOut ? '视频下载超时，请检查网络后重试。' : error.message);
      if (error.message?.includes('512 MB')) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (reader) await reader.cancel().catch(() => {});
    }
  }
  throw lastError || new Error('没有可访问的视频地址，请重新识别。');
}

async function authorizeUrl(url) {
  if (!safeHttpUrl(url)) throw new Error('视频资源地址不可用。');
  const result = await chrome.runtime.sendMessage({ type: 'MEDIA_ORIGIN', jobId: id, url });
  if (!result?.ok) throw new Error(result?.error || '无法准备视频连接。');
}

function showComplete() {
  busy = false;
  $('cancel-button').hidden = true;
  $('status-orb').className = 'status-orb complete';
  progress(100, '已保存到电脑', job.filename);
  $('open-downloads').hidden = false;
  if (blobUrl && job.outputMime !== 'video/mp2t') {
    $('result-link').textContent = '预览视频';
    $('result-link').href = blobUrl;
    $('result-link').target = '_blank';
    $('result-link').rel = 'noopener';
    $('result-link').hidden = false;
  }
  document.querySelector('.keep-open').textContent = '下载完成，可以关闭此页面。';
}

async function saveBlob() {
  if (!blob || busy) return;
  busy = true;
  clearActions();
  $('cancel-button').disabled = true;
  progress(98, '正在保存到电脑', '正在交给浏览器保存…');
  await status('saving');
  if (!blobUrl) blobUrl = URL.createObjectURL(blob);
  let watcher;
  try {
    const finished = new Promise((resolve, reject) => {
      watcher = delta => {
        if (delta.id !== currentDownload) return;
        if (delta.state?.current === 'complete') resolve();
        else if (delta.state?.current === 'interrupted') reject(new Error(delta.error?.current === 'USER_CANCELED' ? '已取消保存，可以再次保存视频。' : `浏览器未能保存文件（${delta.error?.current || '传输中断'}）。`));
      };
      chrome.downloads.onChanged.addListener(watcher);
    });
    // Attach a rejection handler immediately so an early browser failure cannot
    // become an unhandled rejection while storage/search is pending.
    finished.catch(() => {});
    currentDownload = await chrome.downloads.download({ url: blobUrl, filename: job.filename, conflictAction: 'uniquify', saveAs: job.saveAs });
    $('cancel-button').disabled = false;
    await status('saving', { downloadId: currentDownload });
    const [entry] = await chrome.downloads.search({ id: currentDownload });
    if (entry?.state === 'complete') { /* The local blob may finish before the listener's ID was assigned. */ }
    else if (entry?.state === 'interrupted') throw new Error('浏览器取消了保存，可以再次保存视频。');
    else await finished;
    await status('done');
    showComplete();
  } catch (error) {
    busy = false;
    currentDownload = null;
    await status('ready');
    $('cancel-button').hidden = true;
    $('save-button').hidden = false;
    $('error-message').textContent = error.message || '未能保存文件，请再次点击保存视频。';
    $('error-message').hidden = false;
    progress(98, '视频已准备好', '点击“保存视频”继续。');
  } finally {
    if (watcher) chrome.downloads.onChanged.removeListener(watcher);
  }
}

async function recoverSavedDownload() {
  if (job.downloadId == null) return false;
  currentDownload = job.downloadId;
  busy = true;
  clearActions();
  progress(98, '正在检查保存状态', '正在读取浏览器中的已有下载…');
  let watcher;
  try {
    const finished = new Promise((resolve, reject) => {
      watcher = delta => {
        if (delta.id !== currentDownload) return;
        if (delta.state?.current === 'complete') resolve();
        else if (delta.state?.current === 'interrupted') reject(new Error('浏览器中的下载已经中断。'));
      };
      chrome.downloads.onChanged.addListener(watcher);
    });
    finished.catch(() => {});
    const [entry] = await chrome.downloads.search({ id: currentDownload });
    if (!entry || entry.exists === false || entry.state === 'interrupted') {
      busy = false;
      currentDownload = null;
      return false;
    }
    if (entry.state !== 'complete') {
      await status('saving');
      progress(98, '浏览器正在保存', '继续等待已有下载，不会重复保存…');
      await finished;
    }
    await status('done');
    showComplete();
    return true;
  } catch (error) {
    busy = false;
    currentDownload = null;
    await status('failed');
    $('cancel-button').hidden = true;
    $('retry-button').hidden = false;
    $('stage-label').textContent = '保存未完成';
    $('status-orb').className = 'status-orb failed';
    $('error-message').textContent = error.message;
    $('error-message').hidden = false;
    return true;
  } finally {
    if (watcher) chrome.downloads.onChanged.removeListener(watcher);
  }
}

async function run(refresh = false) {
  if (busy) return;
  busy = true;
  controller = new AbortController();
  const signal = controller.signal;
  clearActions();
  loaded = [0, 0];
  totals = [0, 0];
  startedAt = performance.now();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  blobUrl = null;
  blob = null;
  currentDownload = null;
  try {
    await status('running');
    if (refresh) {
      progress(0, '正在重新识别', '正在更新视频地址…');
      const result = await chrome.runtime.sendMessage({ type: 'INSPECT', tabId: job.sourceTabId });
      signal.throwIfAborted();
      if (!result?.ok) throw new Error(result?.error || '请回到原视频页重新识别。');
      if (result.video.bvid !== job.video.bvid || result.video.cid !== job.video.cid) throw new Error('原视频页已切换到其他视频或分段，请回到原视频页后重试。');
      const option = result.options.find(item => item.id === job.option.id);
      if (!option) throw new Error('当前清晰度已不可用，请回到视频页选择其他清晰度。');
      await status('running', { option });
    }
    if (job.option.estimatedBytes > MAX_INPUT_BYTES) throw new Error('视频预计超过512 MB，请回到视频页选择较低清晰度。');
    progress(0, '正在下载视频', '正在连接视频服务器…');
    let videoData;
    let audioData;
    if (job.option.kind === 'dash') {
      [videoData, audioData] = await Promise.all([
        fetchTrack([job.option.videoUrl, ...(job.option.videoBackups || [])], 0, signal),
        fetchTrack([job.option.audioUrl, ...(job.option.audioBackups || [])], 1, signal)
      ]);
      signal.throwIfAborted();
      progress(78, '正在合成MP4', '保留原清晰度，正在合成声音和画面…');
      blob = await remuxTracks(videoData, audioData, {
        signal,
        onProgress: update => progress(78 + (update.progress || 0) * 19, '正在合成MP4', update.phase === 'write' ? '正在整理视频文件…' : '保留原清晰度，正在合成声音和画面…')
      });
    } else if (job.option.kind === 'hls') {
      const result = await downloadHls(job.option.videoUrl, { signal, maxBytes: MAX_INPUT_BYTES,
        onResolvedUrl: authorizeUrl,
        onProgress: update => progress((update.progress || 0) * 97, update.phase === 'mux' ? '正在合成MP4' : '正在下载分段视频',
          `${bytes(update.downloadedBytes || 0)} · ${update.completedSegments || 0} / ${update.totalSegments || 0} 段`)
      });
      blob = result.blob;
      await status('running', { filename: safeFilename(job.video, result.extension), outputMime: result.mimeType });
      $('job-subtitle').textContent = `${job.option.label} · ${result.extension.toUpperCase()}${result.extension === 'ts' ? ' · 使用本地播放器打开' : ''}`;
    } else {
      videoData = await fetchTrack([job.option.videoUrl, ...(job.option.videoBackups || [])], 0, signal);
      const webm = job.option.extension === 'webm' || job.option.mimeType === 'video/webm';
      if (webm) validateWebM(videoData);
      else validateDirectMp4(videoData, job.option.exactBytes || 0, { allowNoAudio: !!job.option.allowNoAudio });
      blob = new Blob([videoData], { type: webm ? 'video/webm' : 'video/mp4' });
      await status('running', { outputMime: blob.type });
    }
    videoData = null;
    audioData = null;
    signal.throwIfAborted();
    busy = false;
    await saveBlob();
  } catch (error) {
    const cancelled = signal.aborted;
    if (!signal.aborted) controller.abort(error);
    busy = false;
    await status(cancelled ? 'cancelled' : 'failed');
    $('cancel-button').hidden = true;
    $('retry-button').hidden = false;
    $('status-orb').className = `status-orb ${cancelled ? 'cancelled' : 'failed'}`;
    $('stage-label').textContent = cancelled ? '已取消下载' : '下载未完成';
    $('transfer-detail').textContent = cancelled ? '可以重新下载，或关闭此页面。' : '可以重试；视频地址会重新获取。';
    $('error-message').textContent = cancelled ? '' : (error.message || '下载失败，请重试。');
    $('error-message').hidden = cancelled;
  }
}

$('cancel-button').addEventListener('click', () => {
  $('cancel-button').disabled = true;
  if (currentDownload != null) chrome.downloads.cancel(currentDownload).catch(() => {});
  else controller?.abort(new DOMException('已取消下载', 'AbortError'));
});
$('retry-button').addEventListener('click', () => run(true));
$('save-button').addEventListener('click', saveBlob);
$('open-downloads').addEventListener('click', () => {
  if (job.downloadId != null) chrome.downloads.show(job.downloadId);
  else chrome.tabs.create({ url: 'chrome://downloads/' });
});
addEventListener('beforeunload', event => {
  if (busy) { event.preventDefault(); event.returnValue = ''; }
});
addEventListener('unload', () => {
  controller?.abort();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});

try {
  job = (await chrome.storage.session.get(key))[key];
  if (!job || Date.now() - job.createdAt > 86400000) throw new Error('下载任务已过期。请回到视频页重新开始下载。');
  const tab = await chrome.tabs.getCurrent();
  if (job.downloadTabId != null && job.downloadTabId !== tab.id) {
    const existing = await chrome.tabs.get(job.downloadTabId).catch(() => null);
    if (existing) throw new Error('这个下载任务已经在另一个标签页中打开。');
  }
  await status(job.status, { downloadTabId: tab.id });
  $('job-title').textContent = job.video.title;
  $('job-subtitle').textContent = `${job.video.pages?.length > 1 ? `第 ${job.video.page} 段 · ${job.video.part} · ` : ''}${job.option.label}${job.option.kind === 'hls' ? '' : ` · ${(job.option.extension || 'mp4').toUpperCase()}`}`;
  if (['done', 'saving', 'cancelled'].includes(job.status) && await recoverSavedDownload()) { /* Existing browser download restored. */ }
  else if (job.status === 'done') {
    $('cancel-button').hidden = true;
    $('retry-button').hidden = false;
    progress(0, '文件已不在浏览器下载记录中', '可以重新下载，或在电脑上查找此前保存的文件。');
  } else run();
} catch (error) {
  $('stage-label').textContent = '无法开始下载';
  $('status-orb').className = 'status-orb failed';
  $('error-message').textContent = error.message;
  $('error-message').hidden = false;
  $('cancel-button').hidden = true;
  $('transfer-detail').textContent = '请重新打开插件，粘贴来源链接后重试。';
}
