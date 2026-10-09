const $ = id => document.getElementById(id);
const sourceText = new URL(location.href).searchParams.get('source');
const tabId = sourceText === null ? NaN : Number(sourceText);
let images = [];
let selected = new Set();
let saved = new Set();
let failed = new Set();
let saving = new Set();
let busy = false;
let loading = false;
let loadSequence = 0;

function visibleImages() {
  const minimum = Number($('size-filter').value);
  return images.filter(item => !minimum || Math.min(item.width || 0, item.height || 0) >= minimum);
}

function nameFor(item) {
  if (item.alt?.trim()) return item.alt.trim().slice(0, 100);
  try { return decodeURIComponent(new URL(item.url).pathname.split('/').pop()) || `图片 ${item.index + 1}`; }
  catch { return `图片 ${item.index + 1}`; }
}

function dimensions(item) {
  return item.width > 0 && item.height > 0 ? `${item.width} × ${item.height} px` : '尺寸尚未读取';
}

function filenameFor(item) {
  let extension = 'jpg';
  try {
    const url = new URL(item.url);
    extension = url.pathname.match(/\.(avif|webp|png|jpe?g|gif|svg|bmp|ico|tiff?)$/i)?.[1] ||
      (/^(?:avif|webp|png|jpe?g|gif)$/i.test(url.searchParams.get('format') || '') ? url.searchParams.get('format') : 'jpg');
  } catch { /* The backend validates and corrects resource file types. */ }
  return `Nori Save-image-${String(item.index + 1).padStart(3, '0')}.${extension.toLowerCase()}`;
}

function updateControls() {
  const visible = visibleImages();
  $('select-all').disabled = busy || loading || !visible.length;
  $('clear-selection').disabled = busy || loading || !selected.size;
  $('size-filter').disabled = busy || loading || !images.length;
  $('save-selected').disabled = busy || loading || !selected.size;
  $('refresh-images').disabled = busy || loading;
  $('retry-images').disabled = busy || loading;
  $('selection-count').textContent = selected.size ? `已选 ${selected.size} 张` : '尚未选择';
  $('save-selected-label').textContent = selected.size ? `保存已选 (${selected.size})` : '保存已选';
  for (const input of document.querySelectorAll('.image-checkbox input')) input.disabled = busy;
  for (const button of document.querySelectorAll('.card-save')) button.disabled = busy;
  $('image-summary').textContent = images.length ? (visible.length === images.length ? `找到 ${images.length} 张图片` : `显示 ${visible.length} / ${images.length} 张图片`) : '当前页面没有可保存的图片';
}

function updateCardStates() {
  for (const card of document.querySelectorAll('.image-card')) {
    const index = Number(card.dataset.index);
    const item = images[index];
    if (!item) continue;
    card.classList.toggle('selected', selected.has(item.url));
    card.querySelector('input').checked = selected.has(item.url);
    const state = card.querySelector('.card-state');
    state.className = `card-state${failed.has(item.url) ? ' failed' : saved.has(item.url) ? ' saved' : ''}`;
    state.textContent = saving.has(item.url) ? '浏览器正在保存' : failed.has(item.url) ? '保存未完成' : saved.has(item.url) ? '已保存' : '';
    card.querySelector('.card-save').textContent = saved.has(item.url) ? '再次保存' : '保存';
  }
  updateControls();
}

function showPreview(item) {
  $('preview-title').textContent = nameFor(item);
  $('preview-image').src = item.url;
  $('preview-image').alt = item.alt || nameFor(item);
  $('preview-details').textContent = dimensions(item);
  $('image-preview').showModal();
}

function renderImages() {
  const visible = visibleImages();
  const fragment = document.createDocumentFragment();
  for (const item of visible) {
    const card = document.createElement('article');
    card.className = 'image-card';
    card.dataset.index = String(item.index);
    const stage = document.createElement('div');
    stage.className = 'image-stage';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'image-open';
    open.setAttribute('aria-label', `预览${nameFor(item)}`);
    open.addEventListener('click', () => showPreview(item));
    const image = document.createElement('img');
    image.src = item.url;
    image.alt = item.alt || nameFor(item);
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => { stage.classList.add('load-error'); open.setAttribute('aria-label', `预览未能加载的${nameFor(item)}`); });
    image.addEventListener('load', () => {
      item.width = image.naturalWidth;
      item.height = image.naturalHeight;
      card.querySelector('.card-details').textContent = dimensions(item);
    });
    open.append(image);
    const choice = document.createElement('label');
    choice.className = 'image-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `选择${nameFor(item)}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(item.url); else selected.delete(item.url);
      updateCardStates();
    });
    choice.append(checkbox);
    stage.append(open, choice);
    const body = document.createElement('div');
    body.className = 'card-body';
    const heading = document.createElement('div');
    heading.className = 'card-heading';
    const title = document.createElement('h2');
    title.textContent = nameFor(item);
    title.title = title.textContent;
    heading.append(title);
    const detail = document.createElement('p');
    detail.className = 'card-details';
    detail.textContent = dimensions(item);
    const footer = document.createElement('div');
    footer.className = 'card-footer';
    const state = document.createElement('span');
    state.className = 'card-state';
    const save = document.createElement('button');
    save.className = 'card-save';
    save.type = 'button';
    save.textContent = '保存';
    save.setAttribute('aria-label', `保存${nameFor(item)}`);
    save.addEventListener('click', () => saveImages([item]));
    footer.append(state, save);
    body.append(heading, detail, footer);
    card.append(stage, body);
    fragment.append(card);
  }
  $('image-grid').replaceChildren(fragment);
  $('image-grid').hidden = !visible.length;
  $('images-empty').hidden = Boolean(visible.length);
  if (!visible.length) {
    $('empty-title').textContent = images.length ? '没有符合尺寸的图片' : '没有找到图片';
    $('empty-description').textContent = images.length ? '可以选择“全部图片”，或降低尺寸筛选范围。' : '只检索当前网页已经加载的图片。可以滚动来源页加载更多，再重新检索。';
  }
  updateCardStates();
}

async function loadImages() {
  if (busy || loading) return;
  if (!Number.isInteger(tabId) || tabId < 0) {
    $('images-loading').hidden = true;
    $('images-empty').hidden = false;
    $('empty-title').textContent = '没有来源页面';
    $('empty-description').textContent = '请切换到网页，重新打开 Nori Save 并点击“当前页图片”。';
    updateControls();
    return;
  }
  const sequence = ++loadSequence;
  loading = true;
  $('images-loading').hidden = false;
  $('images-empty').hidden = true;
  $('image-grid').hidden = true;
  $('batch-progress').hidden = true;
  updateControls();
  $('image-summary').textContent = '正在读取当前页面的图片…';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'INSPECT_IMAGES', tabId });
    if (sequence !== loadSequence) return;
    if (!result?.ok) throw new Error(result?.error || '暂时无法读取当前页图片，请重试。');
    const unique = new Map();
    for (const item of Array.isArray(result.images) ? result.images : []) {
      if (typeof item?.url !== 'string' || !item.url || unique.has(item.url)) continue;
      unique.set(item.url, { url: item.url, alt: String(item.alt || ''), width: Number(item.width) || 0, height: Number(item.height) || 0, index: unique.size });
    }
    images = [...unique.values()];
    selected = new Set();
    saved = new Set();
    failed = new Set();
    $('page-title').textContent = result.page?.title || '当前页图片';
    try {
      const source = new URL(result.page?.url);
      if (!['http:', 'https:'].includes(source.protocol)) throw new Error('Unsupported source');
      $('page-source').href = source.href;
      $('page-source').textContent = source.href;
      $('page-source').hidden = false;
    } catch { $('page-source').hidden = true; }
    loading = false;
    $('images-loading').hidden = true;
    renderImages();
  } catch (error) {
    if (sequence !== loadSequence) return;
    images = [];
    selected.clear();
    loading = false;
    $('images-loading').hidden = true;
    $('images-empty').hidden = false;
    $('empty-title').textContent = '图片读取失败';
    $('empty-description').textContent = error?.message || '请回到来源页面确认图片已加载，再重新检索。';
    updateControls();
  }
}

function waitForDownload(downloadId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      chrome.downloads.onChanged.removeListener(changed);
      if (error) reject(error); else resolve();
    };
    const changed = delta => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') finish();
      else if (delta.state?.current === 'interrupted') finish(new Error(delta.error?.current === 'USER_CANCELED' ? '已取消保存' : '浏览器中断了保存，请重试'));
    };
    chrome.downloads.onChanged.addListener(changed);
    chrome.downloads.search({ id: downloadId }).then(([entry]) => {
      if (!entry) finish(new Error('下载记录不可用，请在浏览器下载页面确认结果'));
      else if (entry.state === 'complete') finish(entry.exists === false ? new Error('保存文件已被移除') : undefined);
      else if (entry.state === 'interrupted') finish(new Error(entry.error === 'USER_CANCELED' ? '已取消保存' : '浏览器未能完成保存'));
    }).catch(finish);
  });
}

async function saveImages(items) {
  if (busy || loading || !items.length) return;
  busy = true;
  $('batch-progress').hidden = false;
  $('batch-errors').hidden = true;
  const errors = [];
  let completed = 0;
  let success = 0;
  const updateProgress = () => {
    const percentage = Math.round(completed / items.length * 100);
    $('batch-progress-bar').style.width = `${percentage}%`;
    $('batch-progress-bar').parentElement.setAttribute('aria-valuenow', String(percentage));
    $('batch-status').textContent = completed === items.length ? `已保存 ${success} 张${errors.length ? ` · ${errors.length} 张未完成` : ''}` : `正在保存 ${completed + 1} / ${items.length} 张`;
  };
  updateProgress();
  updateControls();
  for (const item of items) {
    saving.add(item.url);
    failed.delete(item.url);
    updateCardStates();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'SAVE_IMAGE', tabId, url: item.url, filename: filenameFor(item) });
      if (!result?.ok) throw new Error(result?.error || '未能开始保存');
      if (!Number.isInteger(result.downloadId)) throw new Error('浏览器没有返回下载记录');
      await waitForDownload(result.downloadId);
      success++;
      saved.add(item.url);
    } catch (error) {
      failed.add(item.url);
      errors.push(`图片 ${item.index + 1}：${error?.message || '保存失败'}`);
    } finally {
      saving.delete(item.url);
      completed++;
      updateProgress();
      updateCardStates();
    }
  }
  busy = false;
  if (errors.length) {
    $('batch-errors').textContent = errors.join('；');
    $('batch-errors').hidden = false;
  }
  updateCardStates();
}

$('refresh-images').addEventListener('click', loadImages);
$('retry-images').addEventListener('click', loadImages);
$('select-all').addEventListener('click', () => { selected = new Set(visibleImages().map(item => item.url)); updateCardStates(); });
$('clear-selection').addEventListener('click', () => { selected.clear(); updateCardStates(); });
$('size-filter').addEventListener('change', () => {
  const visible = new Set(visibleImages().map(item => item.url));
  selected = new Set([...selected].filter(url => visible.has(url)));
  renderImages();
});
$('save-selected').addEventListener('click', () => saveImages(images.filter(item => selected.has(item.url))));
$('open-image-downloads').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads/' }));
$('close-preview').addEventListener('click', () => $('image-preview').close());
$('image-preview').addEventListener('click', event => {
  if (event.target !== $('image-preview')) return;
  const rect = $('image-preview').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('image-preview').close();
});
loadImages();
