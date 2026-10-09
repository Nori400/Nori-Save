// Public player metadata only. No account tokens, passwords, proxy services,
// private APIs, or remote executable code are used by these adapters.
// Public field references (not a dependency):
// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/vimeo.py
// https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/dailymotion.py
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

export function publicMediaUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) return null;
    // Official metadata points to named public CDNs. Refuse IP literals and
    // local-only names rather than turning metadata into a local-network fetch.
    if (!host.includes('.') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':') ||
      /(?:^|\.)(?:localhost|local|lan|internal|invalid|test|example)$/.test(host) || host.endsWith('.home.arpa')) return null;
    url.hostname = host;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

async function getMetadata(url, site, { fetchImpl, signal }) {
  const timeout = AbortSignal.timeout(20000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal: requestSignal });
  if (!response.ok) {
    if ([401, 403, 429].includes(response.status)) throw new Error(`${site} 暂时拒绝公开资源请求，可能需要登录或稍后重试。`);
    if (response.status === 404) throw new Error(`${site} 没有找到这个公开视频。`);
    throw new Error(`${site} 资源请求失败（${response.status}）。`);
  }
  if (response.url && !publicMediaUrl(response.url)) throw new Error('来源响应地址不受支持。');
  const declared = Number(response.headers?.get('content-length')) || 0;
  if (declared > MAX_METADATA_BYTES) throw new Error('来源视频信息过大，未继续读取。');
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES) throw new Error('来源视频信息过大，未继续读取。');
  try { return JSON.parse(text); }
  catch { throw new Error(`${site} 没有提供公开的视频信息，请在来源页确认视频可以播放。`); }
}

const number = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;
function videoInfo(site, id, url, { title, cover, duration }) {
  return { bvid: `${site}:${id}`, cid: 0, title: String(title || `${site} 视频`).slice(0, 500),
    part: '', page: 1, pages: [], cover: publicMediaUrl(cover) || '', duration: number(duration), url };
}

function directOption(site, descriptor, index) {
  const videoUrl = publicMediaUrl(descriptor.url);
  if (!videoUrl) return null;
  const height = number(descriptor.height) || number(String(descriptor.quality || '').replace(/p$/i, ''));
  const width = number(descriptor.width);
  const mime = String(descriptor.mime || descriptor.type || 'video/mp4').toLowerCase();
  if (!mime.includes('mp4')) return null;
  return { id: `${site}-mp4-${height || 'original'}-${index}`, quality: height,
    label: height ? `${height}P · MP4` : '原始视频 · MP4', codec: 'MP4', width, height,
    estimatedBytes: number(descriptor.size || descriptor.filesize), videoUrl, videoBackups: [],
    kind: 'direct', mimeType: 'video/mp4', extension: 'mp4' };
}

function hlsOption(site, urls) {
  const valid = [...new Set(urls.map(publicMediaUrl).filter(Boolean))];
  if (!valid.length) return null;
  // Keep the master playlist intact so the downloader checks external audio,
  // encryption and live status before selecting a rendition.
  return { id: `${site}-hls-auto`, quality: 0, label: '自动清晰度', codec: 'MP4', width: 0, height: 0,
    estimatedBytes: 0, videoUrl: valid[0], videoBackups: valid.slice(1), kind: 'hls',
    mimeType: 'application/vnd.apple.mpegurl', extension: 'ts' };
}

async function inspectVimeo(url, args) {
  const segments = url.pathname.split('/').filter(Boolean);
  const id = url.hostname === 'player.vimeo.com' ? url.pathname.match(/^\/video\/(\d+)(?:\/|$)/)?.[1] : segments.findLast(part => /^\d+$/.test(part));
  if (!id) return null;
  const idIndex = segments.indexOf(id);
  const suppliedHash = url.searchParams.get('h') || (/^[a-f\d]{8,64}$/i.test(segments[idIndex + 1] || '') ? segments[idIndex + 1] : '');
  const configUrl = new URL(`https://player.vimeo.com/video/${id}/config`);
  if (suppliedHash) configUrl.searchParams.set('h', suppliedHash);
  const config = await getMetadata(configUrl.href, 'Vimeo', args);
  if (config.view === 4 || config.video?.password_protected) throw new Error('Vimeo 视频需要密码，无法通过公开资源下载。');
  if (config.error) throw new Error('Vimeo 没有提供可访问的公开资源。');
  const data = config.video || {};
  if (String(data.id || '') !== id) throw new Error('Vimeo 返回的视频信息与输入链接不一致。');
  if (data.is_live || data.live_event?.status === 'started') throw new Error('暂不支持直播视频。');
  const files = data.files || config.request?.files || {};
  const direct = (files.progressive || []).map((item, index) => directOption('vimeo', item, index)).filter(Boolean);
  const hls = files.hls || {};
  const cdns = hls.cdns || {};
  const preferred = hls.default_cdn && cdns[hls.default_cdn] ? [cdns[hls.default_cdn], ...Object.values(cdns)] : Object.values(cdns);
  const streaming = hlsOption('vimeo', preferred.flatMap(cdn => [cdn.avc_url, cdn.url, cdn.fallback_url]).filter(Boolean));
  const options = direct.length ? direct.sort((a, b) => b.height - a.height) : streaming ? [streaming] : [];
  if (!options.length) throw new Error('Vimeo 没有提供可处理的公开视频资源，可能需要登录或受到访问限制。');
  return { ok: true, video: videoInfo('vimeo', id, url.href, { title: data.title, duration: data.duration,
    cover: data.thumbs?.[1280] || data.thumbs?.[640] || Object.values(data.thumbs || {})[0] }), options };
}

async function inspectDailymotion(url, args) {
  const id = url.hostname === 'dai.ly' ? url.pathname.match(/^\/([a-z\d]+)(?:\/|$)/i)?.[1]
    : url.pathname.match(/\/(?:video|embed\/video|crawler\/video)\/([a-z\d]+)(?:[_/]|$)/i)?.[1] || url.searchParams.get('video');
  if (!id || !/^[a-z\d]{3,40}$/i.test(id)) return null;
  const metadata = await getMetadata(`https://www.dailymotion.com/player/metadata/video/${encodeURIComponent(id)}`, 'Dailymotion', args);
  if (metadata.error) {
    const reason = String(metadata.error.title || metadata.error.message || metadata.error.raw_message || '资源不可用').slice(0, 180);
    throw new Error(`Dailymotion 未提供可用视频：${reason}`);
  }
  if (metadata.is_password_protected || metadata.private) throw new Error('Dailymotion 视频需要访问权限，无法通过公开资源下载。');
  if (metadata.media_type === 'live' || metadata.stream_type === 'live') throw new Error('暂不支持直播视频。');
  const direct = [];
  const hlsUrls = [];
  for (const [quality, descriptors] of Object.entries(metadata.qualities || {})) {
    for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
      const type = String(descriptor.type || '').toLowerCase();
      if (/mpegurl/.test(type)) { if (descriptor.url) hlsUrls.push(descriptor.url); }
      else if (type === 'video/mp4') {
        const option = directOption('dailymotion', { ...descriptor, quality }, direct.length);
        if (option) direct.push(option);
      }
    }
  }
  const streaming = hlsOption('dailymotion', hlsUrls);
  const options = direct.length ? direct.sort((a, b) => b.height - a.height) : streaming ? [streaming] : [];
  if (!options.length) throw new Error('Dailymotion 没有提供可处理的公开视频资源。');
  const thumbs = metadata.posters || metadata.thumbnails || {};
  const cover = Object.entries(thumbs).sort(([a], [b]) => number(b) - number(a)).map(([, value]) => value).find(value => publicMediaUrl(value));
  return { ok: true, video: videoInfo('dailymotion', id, url.href, { title: metadata.title, duration: metadata.duration, cover }), options };
}

export async function inspectPublicSite(input, { fetchImpl = fetch, signal } = {}) {
  const normalized = publicMediaUrl(input);
  if (!normalized) return null;
  const url = new URL(normalized);
  const args = { fetchImpl, signal };
  if (['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(url.hostname)) return inspectVimeo(url, args);
  if (['dailymotion.com', 'www.dailymotion.com', 'geo.dailymotion.com', 'dai.ly'].includes(url.hostname)) return inspectDailymotion(url, args);
  return null;
}
