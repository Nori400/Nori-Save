// Runs in the isolated world of the user-submitted source tab and its frames.
export function readVideoPage() {
  const candidates = [];
  let protectedVideo = false;
  let blobVideo = false;
  let duration = 0;
  const isMedia = url => /\.(?:mp4|webm|m3u8|mpd)(?:[?#]|$)/i.test(url || '');
  const add = (value, extra = {}) => {
    if (!value) return;
    try {
      const url = new URL(value, document.baseURI);
      if (['http:', 'https:'].includes(url.protocol)) candidates.push({ url: url.href, ...extra });
    } catch { /* Invalid page values are ignored. */ }
  };
  const visit = root => {
    for (const video of root.querySelectorAll('video')) {
      protectedVideo ||= !!video.mediaKeys;
      blobVideo ||= video.currentSrc?.startsWith('blob:');
      if (Number.isFinite(video.duration)) duration = Math.max(duration, video.duration);
      const extra = { width: video.videoWidth, height: video.videoHeight, type: 'video/mp4' };
      const src = video.currentSrc || video.src;
      if (src && !src.startsWith('blob:')) add(src, { ...extra, type: /\.webm(?:[?#]|$)/i.test(src) ? 'video/webm' : '' });
      for (const source of video.querySelectorAll('source')) add(source.src, { ...extra, type: source.type });
    }
    for (const anchor of root.querySelectorAll('a[href]')) if (isMedia(anchor.href)) add(anchor.href);
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  for (const meta of document.querySelectorAll('meta[property^="og:video"]')) {
    if (!meta.getAttribute('property')?.endsWith(':type')) add(meta.content, { type: document.querySelector('meta[property="og:video:type"]')?.content || '' });
  }
  for (const entry of performance.getEntriesByType('resource')) if (isMedia(entry.name)) add(entry.name);
  let visited = 0;
  const walk = (value, depth = 0) => {
    if (++visited > 15000 || depth > 10 || !value) return;
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); }
    else if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && /url|src|playaddr/i.test(key) && isMedia(child)) add(child);
        else if (typeof child === 'object') walk(child, depth + 1);
      }
    }
  };
  let scriptBytes = 0;
  for (const script of document.querySelectorAll('script:not([src])')) {
    const content = script.textContent || '';
    scriptBytes += content.length;
    if (scriptBytes > 1500000) break;
    if (/json/i.test(script.type)) { try { walk(JSON.parse(content)); } catch {} }
    const text = content.replaceAll('\\/', '/');
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:mp4|webm|m3u8|mpd)(?:\?[^\s"'<>\\]*)?/gi)) add(match[0]);
  }
  return { title: document.querySelector('meta[property="og:title"]')?.content || document.title || '视频',
    cover: document.querySelector('meta[property="og:image"]')?.content || document.querySelector('video[poster]')?.poster || '',
    url: location.href, duration, protectedVideo, blobVideo, candidates: candidates.slice(0, 100) };
}
