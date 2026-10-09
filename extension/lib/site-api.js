export const CDN_DOMAINS = ['bilivideo.com', 'bilivideo.cn', 'bilivideo.net', 'akamaized.net'];
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;

export function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!CDN_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url.href;
  } catch { return null; }
}

export function mediaUrls(stream) {
  return [...new Set([stream?.baseUrl, stream?.base_url, stream?.url, ...(stream?.backupUrl || stream?.backup_url || [])].map(safeMediaUrl).filter(Boolean))];
}

export function safeFilename(video) {
  const title = String(video.title || video.bvid || '视频').normalize('NFC');
  const part = video.pages?.length > 1 ? ` - P${video.page} ${video.part || ''}` : '';
  const base = `${title}${part}`.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 150) || '视频';
  return `${/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base) ? '_' : ''}${base}.mp4`;
}

export function normalizePlayInfo(video, raw) {
  const data = raw?.data && typeof raw.data === 'object' ? raw.data
    : raw?.result && typeof raw.result === 'object' ? raw.result : raw;
  if (!data || data.is_drm || data.drm_tech_type || data.drm) throw new Error('这段视频受保护，无法下载。');
  const descriptions = new Map((data.accept_quality || []).map((id, index) => [Number(id), data.accept_description?.[index]]));
  const names = { 127: '8K', 126: '杜比视界', 125: 'HDR', 120: '4K', 116: '1080P 60帧', 112: '1080P 高码率', 80: '1080P', 74: '720P 60帧', 64: '720P', 32: '480P', 16: '360P' };
  const label = id => descriptions.get(Number(id)) || names[id] || `${id} 清晰度`;
  const duration = Number(data.timelength) / 1000 || Number(data.dash?.duration) || Number(video.duration) || 0;
  if (data.dash?.video?.length) {
    const audios = (data.dash.audio || []).filter(item => /^mp4a/i.test(item.codecs || '') && mediaUrls(item).length && !item.drm_tech_type);
    audios.sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth));
    const audio = audios[0];
    if (!audio) throw new Error('没有找到可合成的音轨。请播放几秒后重试。');
    const byQuality = new Map();
    const rank = codec => /^avc[13]/i.test(codec) ? 0 : /^(hvc1|hev1)/i.test(codec) ? 1 : /^av01/i.test(codec) ? 2 : 9;
    for (const stream of data.dash.video) {
      if (!mediaUrls(stream).length || rank(stream.codecs || '') === 9 || stream.drm_tech_type) continue;
      const old = byQuality.get(Number(stream.id));
      if (!old || rank(stream.codecs) < rank(old.codecs)) byQuality.set(Number(stream.id), stream);
    }
    const audioUrls = mediaUrls(audio);
    return [...byQuality].sort(([a], [b]) => b - a).map(([quality, stream]) => {
      const urls = mediaUrls(stream);
      return {
        id: `dash-${quality}-${stream.codecid || stream.codecs}`,
        quality, label: label(quality), codec: rank(stream.codecs) === 0 ? 'H.264' : rank(stream.codecs) === 1 ? 'H.265' : 'AV1',
        width: Number(stream.width) || 0, height: Number(stream.height) || 0,
        estimatedBytes: Math.ceil((Number(stream.bandwidth || 0) + Number(audio.bandwidth || 0)) * duration / 8),
        videoUrl: urls[0], videoBackups: urls.slice(1), audioUrl: audioUrls[0], audioBackups: audioUrls.slice(1), kind: 'dash'
      };
    });
  }
  if (data.durl?.length === 1 && /mp4/i.test(data.format || '') && mediaUrls(data.durl[0]).length) {
    const urls = mediaUrls(data.durl[0]);
    return [{ id: `direct-${data.quality}`, quality: Number(data.quality), label: label(data.quality), codec: 'MP4', width: 0, height: 0,
      estimatedBytes: Number(data.durl[0].size) || 0, videoUrl: urls[0], videoBackups: urls.slice(1), kind: 'direct' }];
  }
  throw new Error('这个视频暂时没有可用的MP4资源。请在网页中播放后重新识别。');
}

// This function runs only when the user opens the popup, inside the submitted source page.
// It must be self-contained because Chrome serializes it for scripting.executeScript.
export async function readSourcePage() {
  try {
    if (location.hostname !== 'www.bilibili.com' || !/^\/video\/(BV[\w]+|av\d+)/i.test(location.pathname)) {
      return { ok: false, error: '请先打开普通视频播放页。直播和番剧暂不支持。' };
    }
    const match = location.pathname.match(/^\/video\/(BV[\w]+|av\d+)/i)[1];
    const isBV = /^BV/.test(match);
    const initial = window.__INITIAL_STATE__ || {};
    let info = initial.videoData;
    const matches = value => isBV ? value?.bvid === match : Number(value?.aid) === Number(match.slice(2));
    async function api(path) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetch(`https://api.bilibili.com${path}`, { credentials: 'include', signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 412 ? '来源网站暂时限制了请求。请稍后在网页播放视频后重试。' : `来源请求失败（${response.status}）。`);
        const json = await response.json();
        if (json.code !== 0) throw new Error(`来源未提供播放资源：${String(json.message || json.code).slice(0, 160)}`);
        return json.data || json.result;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('来源响应超时，请稍后重试。');
        throw error;
      } finally { clearTimeout(timeout); }
    }
    if (!matches(info) || !info.pages?.length) {
      info = await api(`/x/web-interface/view?${isBV ? `bvid=${encodeURIComponent(match)}` : `aid=${Number(match.slice(2))}`}`);
    }
    const page = Number(new URL(location.href).searchParams.get('p') || 1);
    const current = info.pages?.find(item => Number(item.page) === page);
    if (!current || !Number.isSafeInteger(page) || page < 1) throw new Error('没有找到当前分P，请重新打开这个分P后重试。');
    const video = {
      bvid: info.bvid, cid: Number(current.cid), title: String(info.title || document.title).slice(0, 500), part: String(current.part || '').slice(0, 500),
      page, pages: info.pages.map(item => ({ cid: Number(item.cid), page: Number(item.page), part: String(item.part || '').slice(0, 500) })),
      cover: String(info.pic || '').replace(/^http:/, 'https:'), duration: Number(current.duration || info.duration || 0),
      url: `https://www.bilibili.com/video/${info.bvid}/?p=${page}`
    };
    // Always request the selected CID. Page globals such as __playinfo__ can
    // survive a part switch and silently refer to a different video.
    const playInfo = await api(`/x/player/playurl?bvid=${encodeURIComponent(video.bvid)}&cid=${video.cid}&qn=127&fnval=4048&fourk=1`);
    return { ok: true, video, playInfo };
  } catch (error) {
    return { ok: false, error: error.message || '未能读取这个视频，请刷新视频页面后重试。' };
  }
}

