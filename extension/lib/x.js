const POST_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'm.twitter.com']);

export function parseXPostUrl(input) {
  let url;
  try { url = new URL(String(input).trim()); }
  catch { throw new Error('请输入完整的 X 帖子链接。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !POST_HOSTS.has(url.hostname)) {
    throw new Error('请输入受支持的 X 公开帖子链接。');
  }
  const match = url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}\/status|i\/(?:web\/)?status)\/(\d{5,22})(?:\/video\/([1-9]\d*))?\/?$/);
  if (!match) throw new Error('请使用包含 /status/ 的 X 视频帖子链接。');
  const mediaIndex = match[2] ? Number(match[2]) : null;
  if (mediaIndex !== null && !Number.isSafeInteger(mediaIndex)) throw new Error('视频编号无效。');
  return { id: match[1], mediaIndex, url: `https://x.com${url.pathname.replace(/\/$/, '')}` };
}

export function safeXMediaUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.hostname !== 'video.twimg.com' || url.username || url.password || url.port || !/\.mp4$/i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function safeCoverUrl(input) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && url.hostname === 'pbs.twimg.com' && !url.username && !url.password && !url.port ? url.href : '';
  } catch { return ''; }
}

// The public embed uses this numerical token; it is not a login credential.
export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function normalizeXPlayInfo(input, data) {
  const post = parseXPostUrl(input);
  if (!data || data.id_str !== post.id) throw new Error('X 未返回完整的视频信息，请确认这是公开帖子链接。');
  const originalMedia = Array.isArray(data.mediaDetails) ? data.mediaDetails : [];
  let media = originalMedia;
  // Top-level embed video exists in some responses without mediaDetails.
  // Do not merge quoted posts, which could silently change the selected source.
  if (!media.length && data.video?.variants?.length) {
    media = [{
      type: 'video', media_url_https: data.video.poster,
      ext_media_availability: data.video.mediaAvailability,
      video_info: { duration_millis: data.video.durationMs, variants: data.video.variants.map(variant => ({ content_type: variant.type, url: variant.src })) }
    }];
  }
  const playable = media.map((item, index) => ({ item, mediaIndex: index + 1 }))
    .filter(({ item }) => ['video', 'animated_gif'].includes(item.type));
  if (!playable.length) throw new Error('这条帖子没有公开提供可直接下载的 MP4 视频。');
  const selected = post.mediaIndex === null ? playable[0] : playable.find(item => item.mediaIndex === post.mediaIndex);
  if (!selected) throw new Error(`帖子中的媒体 ${post.mediaIndex} 不是可下载视频。请检查 /video/ 后的编号。`);
  const availability = selected.item.ext_media_availability?.status;
  if (availability && String(availability).toLowerCase() !== 'available') throw new Error('这段视频目前未公开提供播放资源。');
  const info = selected.item.video_info || {};
  const duration = Number(info.duration_millis) > 0 ? Number(info.duration_millis) / 1000 : 0;
  const seen = new Set();
  const options = (Array.isArray(info.variants) ? info.variants : []).flatMap((variant, index) => {
    if (variant.content_type !== 'video/mp4') return [];
    const videoUrl = safeXMediaUrl(variant.url);
    if (!videoUrl || seen.has(videoUrl)) return [];
    seen.add(videoUrl);
    const resolution = new URL(videoUrl).pathname.match(/\/(\d{2,5})x(\d{2,5})\//);
    const width = resolution ? Number(resolution[1]) : 0;
    const height = resolution ? Number(resolution[2]) : 0;
    const bitrate = Number(variant.bitrate) > 0 ? Number(variant.bitrate) : 0;
    const quality = width && height ? Math.min(width, height) : 0;
    return [{
      id: `x-${post.id}-${selected.mediaIndex}-${quality}-${bitrate || index}`,
      quality, label: width && height ? `${width} × ${height}` : bitrate ? `MP4 · ${Math.round(bitrate / 1000)} kbps` : 'MP4',
      codec: 'MP4', width, height,
      estimatedBytes: duration && bitrate ? Math.ceil(duration * bitrate / 8) : 0,
      videoUrl, videoBackups: [], kind: 'direct', mimeType: 'video/mp4', extension: 'mp4', bitrate,
      ...(selected.item.type === 'animated_gif' ? { allowNoAudio: true } : {})
    }];
  }).sort((a, b) => b.quality - a.quality || b.bitrate - a.bitrate);
  if (!options.length) throw new Error('X 未公开提供这段视频的 MP4 直链。分段流和受限资源暂不支持。');
  const hasMultipleMedia = media.length > 1;
  const text = String(data.text || 'X 视频').replace(/\s+/g, ' ').trim().slice(0, 300);
  const title = `${text}${hasMultipleMedia ? ` · 媒体 ${selected.mediaIndex}/${media.length}` : ''}`;
  const canonicalBase = post.url.replace(/\/video\/\d+$/, '');
  return {
    ok: true,
    video: {
      bvid: post.id, cid: selected.mediaIndex, title, part: '', page: 1, pages: [],
      cover: safeCoverUrl(selected.item.media_url_https), duration,
      url: `${canonicalBase}${hasMultipleMedia || post.mediaIndex !== null ? `/video/${selected.mediaIndex}` : ''}`,
      mediaIndex: selected.mediaIndex, mediaCount: media.length, videoCount: playable.length
    },
    options,
    ...(hasMultipleMedia ? { warning: `当前选择帖子中的媒体 ${selected.mediaIndex}/${media.length}。其他视频请使用对应的 /video/编号 链接。` } : {})
  };
}

export async function inspectX(input) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const post = parseXPostUrl(input);
    const endpoint = new URL('https://cdn.syndication.twimg.com/tweet-result');
    endpoint.search = new URLSearchParams({ id: post.id, token: syndicationToken(post.id), lang: 'en' });
    const response = await fetch(endpoint.href, {
      credentials: 'omit', signal: controller.signal, redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'X 暂时限制了请求，请稍后重试。' : `X 未提供公开视频资源（${response.status}）。`);
    return normalizeXPlayInfo(input, await response.json());
  } catch (error) {
    return { ok: false, error: error.name === 'AbortError' ? 'X 响应超时，请稍后重试。' : error.name === 'SyntaxError' ? 'X 返回了未识别的响应，请稍后重试。' : error.message || '未能读取这条 X 视频帖子。' };
  } finally { clearTimeout(timeout); }
}
