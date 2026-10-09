export const MAX_INPUT_BYTES = 512 * 1024 * 1024;

export function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host || (!host.includes('.') && !host.includes(':')) || host === 'localhost' || /\.(?:localhost|local|internal|lan|home|home\.arpa)$/.test(host)) return null;
    if (host.includes(':')) {
      const first = Number.parseInt(host.split(':')[0], 16);
      if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff || /^2001:db8:/i.test(host)) return null;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b))) return null;
    }
    return url.href;
  } catch { return null; }
}

export function safeFilename(video, extension = 'mp4') {
  const suffix = ['mp4', 'webm', 'ts'].includes(extension) ? extension : 'mp4';
  const title = String(video.title || '视频').normalize('NFC');
  const part = video.pages?.length > 1 ? ` - P${video.page} ${video.part || ''}` : '';
  const base = `${title}${part}`.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 150) || '视频';
  return `${/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(base) ? '_' : ''}${base}.${suffix}`;
}

export function mediaKind(url, mimeType = '') {
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  if (/\.m3u8$/.test(path) || /(?:mpegurl|m3u8)/.test(mime)) return 'hls';
  if (/\.mpd$/.test(path) || mime === 'application/dash+xml') return 'manifest';
  if (/\.m4s$|(?:^|[\/_-])(?:audio|init|segment|chunk)(?:[\/_-]|\d)/.test(path) || mime.startsWith('audio/')) return null;
  if (/\.webm$/.test(path) || mime === 'video/webm') return 'webm';
  if (/\.mp4$/.test(path) || ['video/mp4', 'video/quicktime'].includes(mime)) return 'mp4';
  return null;
}

export function normalizeCandidates(candidates) {
  const unique = new Map();
  for (const raw of candidates) {
    const url = safeHttpUrl(raw.url);
    const type = url && mediaKind(url, raw.mimeType || raw.type);
    if (!url || !type || type === 'manifest') continue;
    const old = unique.get(url);
    if (old) { Object.assign(old, Object.fromEntries(Object.entries(raw).filter(([, value]) => value)), { url }); continue; }
    unique.set(url, { ...raw, url, mediaType: type });
  }
  return [...unique.values()].slice(0, 60).map((item, index) => {
    let identity = 2166136261;
    for (const character of item.url) identity = Math.imul(identity ^ character.charCodeAt(0), 16777619);
    const kind = item.mediaType === 'hls' ? 'hls' : 'direct';
    const extension = item.mediaType === 'webm' ? 'webm' : kind === 'hls' ? '' : 'mp4';
    const dimensions = item.height ? `${item.height}P` : `资源 ${index + 1}`;
    return { id: `media-${identity >>> 0}`, quality: Number(item.height) || 0, label: `${dimensions} · ${kind === 'hls' ? 'HLS' : extension.toUpperCase()}`,
      codec: extension === 'webm' ? 'WebM' : 'MP4', width: Number(item.width) || 0, height: Number(item.height) || 0,
      estimatedBytes: Number(item.size) || 0, exactBytes: Number(item.size) || 0,
      videoUrl: item.url, videoBackups: [], kind, extension, mimeType: extension === 'webm' ? 'video/webm' : 'video/mp4' };
  });
}

export function validateWebM(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 32 || ![0x1a, 0x45, 0xdf, 0xa3].every((value, index) => bytes[index] === value)) throw new Error('下载内容不是完整的WebM视频。');
  const read = (offset, id = false) => {
    if (offset >= bytes.length || bytes[offset] === 0) throw new Error('WebM文件头无效或被截断。');
    let length = 1;
    while (length <= 8 && !(bytes[offset] & (0x80 >> (length - 1)))) length++;
    if (length > (id ? 4 : 8) || offset + length > bytes.length) throw new Error('WebM文件头无效或被截断。');
    let value = id ? bytes[offset] : bytes[offset] & ((0x80 >> (length - 1)) - 1);
    let unknown = !id && value === ((0x80 >> (length - 1)) - 1);
    for (let i = 1; i < length; i++) { value = value * 256 + bytes[offset + i]; unknown &&= bytes[offset + i] === 255; }
    return { length, value, unknown };
  };
  let offset = 0;
  let segment;
  while (offset < bytes.length) {
    const tag = read(offset, true);
    const size = read(offset + tag.length);
    const start = offset + tag.length + size.length;
    const end = size.unknown ? bytes.length : start + size.value;
    if (end > bytes.length || !Number.isSafeInteger(end)) throw new Error('WebM视频被截断，未保存不完整文件。');
    if (tag.value === 0x18538067) segment = { start, end };
    offset = end;
  }
  if (!segment) throw new Error('WebM视频缺少媒体数据。');
  let hasTracks = false;
  let hasCluster = false;
  offset = segment.start;
  while (offset < segment.end) {
    const tag = read(offset, true);
    const size = read(offset + tag.length);
    const start = offset + tag.length + size.length;
    const end = size.unknown ? segment.end : start + size.value;
    if (end > segment.end || !Number.isSafeInteger(end)) throw new Error('WebM视频数据不完整。');
    hasTracks ||= tag.value === 0x1654ae6b;
    hasCluster ||= tag.value === 0x1f43b675;
    offset = end;
  }
  if (!hasTracks || !hasCluster) throw new Error('WebM文件没有完整的视频轨道。');
}
