const $ = (id) => document.getElementById(id);
let inspection = null;
let inspectSequence = 0;
let started = false;
let starting = false;
let openingImages = false;

function setView(view) {
  $('loading-state').hidden = view !== 'loading';
  $('empty-state').hidden = view !== 'empty';
  $('video-content').hidden = view !== 'video';
  document.querySelector('.popup').dataset.view = view;
  const busy = view === 'loading' || starting || openingImages;
  $('refresh-button').disabled = busy || !$('link-input').value.trim();
  $('inspect-link-button').disabled = busy;
  $('inspect-link-button').textContent = view === 'loading' ? '识别中' : '识别';
  $('link-input').disabled = busy;
  $('current-video-button').disabled = busy;
  $('current-images-button').disabled = busy;
}

function showEmpty(title, description, retry = false) {
  $('empty-title').textContent = title;
  $('empty-description').textContent = description;
  $('retry-inspect-button').hidden = !retry;
  setView('empty');
}

function formatBytes(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) <= 0) return '';
  const value = Number(bytes);
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${Math.ceil(value / 1024 ** 2)} MB`;
}

function formatDuration(seconds) {
  const total = Math.floor(Number(seconds));
  if (!Number.isFinite(total) || total <= 0) return '';
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
}

function selectedOption() {
  return inspection?.options.find((option) => String(option.id) === $('quality-select').value);
}

function outputFormat(option) {
  if (!option || option.kind === 'hls') return '';
  const extension = String(option.extension || '').replace(/^\./, '').toLowerCase();
  const mime = String(option.mimeType || '').toLowerCase();
  if (extension === 'webm' || mime.includes('webm')) return 'WebM';
  if (extension === 'mp4' || mime.includes('mp4') || option.kind === 'dash') return 'MP4';
  return '';
}

function downloadLabel(option) {
  const format = outputFormat(option);
  return format ? `下载 ${format}` : '下载视频';
}

function updateQualityDetail() {
  const option = selectedOption();
  const size = formatBytes(option?.estimatedBytes);
  const resolution = Number(option?.width) > 0 && Number(option?.height) > 0 ? `${option.width} × ${option.height}` : '';
  $('quality-detail').textContent = [outputFormat(option), resolution, size ? `预计 ${size}` : '大小将在下载时确认'].filter(Boolean).join(' · ');
  if (!started && !starting) $('download-label').textContent = downloadLabel(option);
}

function renderVideo(result) {
  const video = result.video;
  $('video-title').textContent = video.title || '视频';
  $('video-title').title = video.title || '';
  $('video-id').textContent = '';
  const cover = typeof video.cover === 'string' && video.cover.startsWith('//') ? `https:${video.cover}` : video.cover;
  try {
    const coverUrl = new URL(cover);
    if (coverUrl.protocol === 'http:') coverUrl.protocol = 'https:';
    if (coverUrl.protocol === 'https:') $('video-cover').src = coverUrl.href;
    else $('video-cover').removeAttribute('src');
  } catch {
    $('video-cover').removeAttribute('src');
  }
  const duration = formatDuration(video.duration);
  $('video-duration').textContent = duration;
  $('video-duration').hidden = !duration;
  const pages = Array.isArray(video.pages) ? video.pages : [];
  const currentPage = Number(video.page) || 1;
  $('video-part').hidden = pages.length <= 1;
  $('video-part').textContent = pages.length > 1 ? `第 ${currentPage} 段 / 共 ${pages.length} 段${video.part ? ` · ${video.part}` : ''}` : '';
  $('quality-select').replaceChildren(...result.options.map((option) => {
    const node = document.createElement('option');
    node.value = String(option.id);
    node.textContent = option.label || (option.quality ? `${option.quality} 清晰度` : '视频资源');
    return node;
  }));
  $('warning-message').textContent = result.warning || '';
  $('warning-message').hidden = !result.warning;
  $('action-error').hidden = true;
  $('action-error').textContent = '';
  $('action-status').textContent = '';
  $('download-label').textContent = '下载视频';
  $('download-button').disabled = false;
  $('quality-select').disabled = false;
  started = false;
  updateQualityDetail();
  setView('video');
}

async function inspect() {
  if (starting || $('inspect-link-button').disabled) return;
  const url = $('link-input').value.trim();
  if (!url) {
    inspection = null;
    $('link-input').setAttribute('aria-invalid', 'true');
    showEmpty('先粘贴一个视频链接', '可以粘贴视频网页链接、媒体直链，也可以直接粘贴包含链接的分享文字。');
    $('link-input').focus();
    return;
  }
  const sequence = ++inspectSequence;
  inspection = null;
  $('link-input').removeAttribute('aria-invalid');
  $('entry-status').hidden = true;
  $('loading-text').textContent = '正在识别链接…';
  $('loading-explanation').textContent = '会打开来源页，查找网页实际提供的视频资源。';
  setView('loading');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'INSPECT_LINK', url });
    if (sequence !== inspectSequence) return;
    if (!result?.ok) throw new Error(result?.error || '暂时无法识别链接，请检查链接后重试。');
    if (!result.video || !Array.isArray(result.options) || !result.options.length) throw new Error('没有找到可下载的视频。请在来源页播放几秒，再点击“重新识别”。');
    if (!Number.isInteger(result.sourceTabId)) throw new Error('来源页面不可用，请重新识别链接。');
    inspection = result;
    renderVideo(result);
  } catch (error) {
    if (sequence !== inspectSequence) return;
    showEmpty('暂时无法识别链接', error?.message || '请检查链接后重试。', true);
  }
}

async function inspectCurrent() {
  if ($('current-video-button').disabled) return;
  const sequence = ++inspectSequence;
  inspection = null;
  $('entry-status').hidden = true;
  $('loading-text').textContent = '正在检索当前页视频…';
  $('loading-explanation').textContent = '查找当前网页播放器和请求中实际提供的视频资源。';
  setView('loading');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'INSPECT_CURRENT' });
    if (sequence !== inspectSequence) return;
    if (!result?.ok) throw new Error(result?.error || '暂时无法检索当前页，请在网页中播放几秒后重试。');
    if (!result.video || !Array.isArray(result.options) || !result.options.length) throw new Error('没有找到可下载的视频。请在当前页播放几秒，再点击“当前页视频”。');
    if (!Number.isInteger(result.sourceTabId)) throw new Error('当前网页不可用，请切换到网页后重试。');
    inspection = result;
    if (result.video.url) $('link-input').value = result.video.url;
    $('link-input').removeAttribute('aria-invalid');
    renderVideo(result);
  } catch (error) {
    if (sequence !== inspectSequence) return;
    showEmpty('暂时没有找到视频', error?.message || '请在当前页播放几秒后重试。');
  }
}

async function openImages() {
  if ($('current-images-button').disabled) return;
  openingImages = true;
  $('entry-status').textContent = '正在打开当前页图片…';
  $('entry-status').classList.remove('entry-error');
  $('entry-status').hidden = false;
  setView(document.querySelector('.popup').dataset.view || 'empty');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'OPEN_IMAGES' });
    if (!result?.ok) throw new Error(result?.error || '无法打开图片页，请切换到普通网页后重试。');
    $('entry-status').textContent = '图片检索页已打开。';
  } catch (error) {
    $('entry-status').textContent = error?.message || '无法打开图片页，请重试。';
    $('entry-status').classList.add('entry-error');
  } finally {
    openingImages = false;
    setView(document.querySelector('.popup').dataset.view || 'empty');
  }
}

async function startDownload() {
  const option = selectedOption();
  if (!inspection || !option || started || starting) return;
  starting = true;
  $('download-button').disabled = true;
  $('quality-select').disabled = true;
  $('download-label').textContent = '正在准备…';
  $('action-error').hidden = true;
  $('action-status').textContent = '';
  setView('video');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'START_DOWNLOAD',
      tabId: inspection.sourceTabId,
      bvid: inspection.video.bvid,
      cid: inspection.video.cid,
      optionId: String(option.id),
      saveAs: $('save-as').checked,
    });
    if (!result?.ok) throw new Error(result?.error || '未能开始下载，请重试。');
    started = true;
    $('download-label').textContent = '下载已开始';
    $('action-status').textContent = '在新打开的下载页查看进度。';
  } catch (error) {
    $('action-error').textContent = error?.message || '未能开始下载，请重试。';
    $('action-error').hidden = false;
    $('download-label').textContent = `重试${downloadLabel(option)}`;
    $('download-button').disabled = false;
    $('quality-select').disabled = false;
  } finally {
    starting = false;
    setView('video');
  }
}

$('link-form').addEventListener('submit', (event) => { event.preventDefault(); inspect(); });
$('current-video-button').addEventListener('click', inspectCurrent);
$('current-images-button').addEventListener('click', openImages);
$('link-input').addEventListener('input', () => {
  inspection = null;
  started = false;
  $('link-input').removeAttribute('aria-invalid');
  showEmpty('粘贴链接，保存视频', '从链接中查找可下载的视频，再选择清晰度保存。可用资源由来源网页决定。');
});
$('refresh-button').addEventListener('click', inspect);
$('retry-inspect-button').addEventListener('click', inspect);
$('quality-select').addEventListener('change', updateQualityDetail);
$('download-button').addEventListener('click', startDownload);
$('video-cover').addEventListener('error', () => { $('video-cover').style.visibility = 'hidden'; });
$('video-cover').addEventListener('load', () => { $('video-cover').style.visibility = ''; });
$('save-as').addEventListener('change', () => {
  chrome.storage.local.set({ saveAs: $('save-as').checked }).catch(() => {});
});
chrome.storage.local.get('saveAs').then((preferences) => {
  $('save-as').checked = Boolean(preferences.saveAs);
}).catch(() => {});
setView('empty');
