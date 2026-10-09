import { createFile } from '../vendor/mp4box.mjs';
import { remuxTracks } from './remux.js';

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 100000;

function abort(signal) {
  if (signal?.aborted) throw new DOMException('已取消下载', 'AbortError');
}

function privateV4(parts) {
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function privateV6(host) {
  const halves = host.split('::');
  if (halves.length > 2) return true;
  const left = halves[0] ? halves[0].split(':').map(value => parseInt(value, 16)) : [];
  const right = halves[1] ? halves[1].split(':').map(value => parseInt(value, 16)) : [];
  const words = halves.length === 2 ? [...left, ...new Array(8 - left.length - right.length).fill(0), ...right] : left;
  if (words.length !== 8 || words.some(value => !Number.isInteger(value))) return true;
  if (words.slice(0, 5).every(value => value === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    return privateV4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255]);
  }
  // Only global unicast addresses are accepted; this excludes loopback, ULA,
  // link-local, site-local, multicast and the unspecified address.
  return (words[0] & 0xe000) !== 0x2000 || (words[0] === 0x2001 && words[1] === 0x0db8);
}

function resolveUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw new Error('HLS 包含无效的下载地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('HLS 只允许无账号凭据的 HTTP(S) 地址');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host) ||
    (!host.includes('.') && !host.includes(':')) ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(host) && privateV4(host.split('.').map(Number))) ||
    (host.includes(':') && privateV6(host))) {
    throw new Error('HLS 不允许本机、局域网或保留地址');
  }
  url.hash = '';
  return url.href;
}

function attributes(text) {
  const result = {};
  let position = 0;
  while (position < text.length) {
    while (text[position] === ',' || /\s/.test(text[position] || '')) position++;
    if (position >= text.length) break;
    const match = text.slice(position).match(/^([A-Z0-9-]+)=/);
    if (!match) throw new Error('HLS 属性格式无效');
    const name = match[1];
    position += match[0].length;
    let value;
    if (text[position] === '"') {
      const end = text.indexOf('"', position + 1);
      if (end === -1) throw new Error('HLS 属性引号不完整');
      value = text.slice(position + 1, end);
      position = end + 1;
    } else {
      const end = text.indexOf(',', position);
      value = text.slice(position, end === -1 ? undefined : end).trim();
      position = end === -1 ? text.length : end;
    }
    if (name in result || (position < text.length && text[position] !== ',')) throw new Error('HLS 属性格式无效');
    result[name] = value;
  }
  return result;
}

function whole(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error(`HLS ${label}无效`);
  return number;
}

function range(value) {
  if (!/^\d+(?:@\d+)?$/.test(value)) throw new Error('HLS 字节范围无效');
  const [length, offset] = value.split('@');
  return { length: whole(length, '字节长度', 1), offset: offset === undefined ? null : whole(offset, '字节偏移') };
}

function resolvedRange(value, url, previous) {
  if (!value) return null;
  const offset = value.offset ?? (previous?.url === url ? previous.range.offset + previous.range.length : null);
  if (offset === null || !Number.isSafeInteger(offset + value.length)) throw new Error('HLS 隐含字节范围缺少前一段位置');
  return { offset, length: value.length };
}

/** Parse a complete HLS manifest without performing network requests. */
export function parseHls(text, baseURL) {
  const base = resolveUrl(baseURL);
  if (typeof text !== 'string' || text.length > MAX_PLAYLIST_BYTES) throw new Error('HLS 播放列表过大或无效');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.shift() !== '#EXTM3U') throw new Error('此地址没有返回有效的 HLS 播放列表');
  const result = { kind: 'media', url: base, variants: [], audioGroups: [], segments: [],
    endList: false, encrypted: false, discontinuity: false, discontinuitySequence: 0,
    hasGaps: false, iframeOnly: false };
  let pendingVariant;
  let duration;
  let title = '';
  let pendingRange;
  let previousRange;
  let previousMapRange;
  let initMap = null;
  let sequence = 0;
  let pendingDiscontinuity = false;
  for (const line of lines) {
    if (!line.startsWith('#')) {
      const url = resolveUrl(line, base);
      if (pendingVariant) {
        result.variants.push({ url, bandwidth: whole(pendingVariant.BANDWIDTH || 0, '码率'),
          averageBandwidth: whole(pendingVariant['AVERAGE-BANDWIDTH'] || 0, '平均码率'),
          resolution: pendingVariant.RESOLUTION || null, codecs: pendingVariant.CODECS || '',
          audioGroup: pendingVariant.AUDIO || null });
        pendingVariant = undefined;
      } else {
        if (duration === undefined || result.endList) throw new Error('HLS 媒体段缺少时长或位于结束标记之后');
        const byteRange = resolvedRange(pendingRange, url, previousRange);
        result.segments.push({ url, duration, title, sequence: sequence++, byteRange,
          initMap, discontinuity: pendingDiscontinuity });
        if (result.segments.length > MAX_SEGMENTS) throw new Error('HLS 媒体段过多');
        previousRange = byteRange ? { url, range: byteRange } : null;
        duration = undefined;
        pendingRange = undefined;
        pendingDiscontinuity = false;
      }
      continue;
    }
    const colon = line.indexOf(':');
    const tag = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1);
    if (tag === '#EXT-X-STREAM-INF') {
      if (pendingVariant || duration !== undefined) throw new Error('HLS 子播放列表地址缺失');
      pendingVariant = attributes(value);
    } else if (tag === '#EXT-X-MEDIA') {
      const attrs = attributes(value);
      if (attrs.TYPE === 'AUDIO') result.audioGroups.push({ groupId: attrs['GROUP-ID'] || '', name: attrs.NAME || '',
        url: attrs.URI ? resolveUrl(attrs.URI, base) : null, default: attrs.DEFAULT === 'YES', autoselect: attrs.AUTOSELECT === 'YES' });
    } else if (tag === '#EXTINF') {
      if (duration !== undefined) throw new Error('HLS 媒体段地址缺失');
      const comma = value.indexOf(',');
      duration = Number(comma === -1 ? value : value.slice(0, comma));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('HLS 媒体段时长无效');
      title = comma === -1 ? '' : value.slice(comma + 1);
    } else if (tag === '#EXT-X-KEY' || tag === '#EXT-X-SESSION-KEY') {
      const attrs = attributes(value);
      if (!attrs.METHOD || attrs.METHOD !== 'NONE' || (attrs.KEYFORMAT && attrs.KEYFORMAT !== 'identity')) result.encrypted = true;
    } else if (tag === '#EXT-X-BYTERANGE') {
      if (pendingRange) throw new Error('HLS 字节范围重复');
      pendingRange = range(value);
    } else if (tag === '#EXT-X-MAP') {
      const attrs = attributes(value);
      if (!attrs.URI) throw new Error('HLS 初始化段地址缺失');
      const url = resolveUrl(attrs.URI, base);
      const byteRange = resolvedRange(attrs.BYTERANGE ? range(attrs.BYTERANGE) : null, url, previousMapRange);
      initMap = { url, byteRange };
      previousMapRange = byteRange ? { url, range: byteRange } : null;
    } else if (tag === '#EXT-X-MEDIA-SEQUENCE') sequence = whole(value, '媒体序号');
    else if (tag === '#EXT-X-DISCONTINUITY-SEQUENCE') result.discontinuitySequence = whole(value, '间断序号');
    else if (tag === '#EXT-X-DISCONTINUITY') { result.discontinuity = true; pendingDiscontinuity = true; }
    else if (tag === '#EXT-X-ENDLIST') result.endList = true;
    else if (tag === '#EXT-X-GAP') result.hasGaps = true;
    else if (tag === '#EXT-X-I-FRAMES-ONLY') result.iframeOnly = true;
    else if (tag === '#EXT-X-DEFINE') throw new Error('暂不支持使用变量的 HLS 播放列表');
  }
  if (duration !== undefined || pendingVariant || pendingRange) throw new Error('HLS 播放列表末尾不完整');
  if (result.variants.length || result.audioGroups.length) {
    if (result.segments.length) throw new Error('HLS 主列表与媒体列表混合');
    result.kind = 'master';
  }
  return result;
}

async function body(response, { signal, limit, onChunk }) {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel?.(); } catch { /* Best-effort connection release. */ }
    throw new Error('HLS 下载超过大小上限');
  }
  const parts = [];
  let bytes = 0;
  function accept(part) {
    bytes += part.byteLength;
    if (bytes > limit) throw new Error('HLS 下载超过大小上限');
    parts.push(part);
    onChunk?.(part.byteLength, bytes, declared > 0 ? declared : undefined);
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        abort(signal);
        const { value, done } = await reader.read();
        abort(signal);
        if (done) break;
        accept(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  } else {
    abort(signal);
    accept(new Uint8Array(await response.arrayBuffer()));
    abort(signal);
  }
  if (!bytes) throw new Error('HLS 返回了空媒体数据');
  return { parts, bytes };
}

function prefix(parts, size = 65536) {
  const bytes = new Uint8Array(Math.min(size, parts.reduce((sum, part) => sum + part.byteLength, 0)));
  let offset = 0;
  for (const part of parts) {
    const length = Math.min(bytes.length - offset, part.byteLength);
    if (!length) break;
    bytes.set(part.subarray(0, length), offset);
    offset += length;
  }
  return bytes;
}

function byteReader(parts) {
  let index = 0;
  let start = 0;
  return offset => {
    while (index < parts.length && offset >= start + parts[index].byteLength) start += parts[index++].byteLength;
    return parts[index]?.[offset - start];
  };
}

function mp4Boxes(parts, requireInit) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const read = byteReader(parts);
  const read32 = offset => read(offset) * 2 ** 24 + read(offset + 1) * 2 ** 16 + read(offset + 2) * 256 + read(offset + 3);
  const types = [];
  let offset = 0;
  while (offset < total) {
    if (offset + 8 > total) throw new Error('HLS fragmented MP4 文件头不完整');
    let size = read32(offset);
    const type = String.fromCharCode(read(offset + 4), read(offset + 5), read(offset + 6), read(offset + 7));
    types.push(type);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > total) throw new Error('HLS fragmented MP4 文件头不完整');
      size = read32(offset + 8) * 2 ** 32 + read32(offset + 12);
      header = 16;
    } else if (size === 0) throw new Error('HLS MP4 包含未限定长度的数据块，无法安全拼接');
    if (size < header || !Number.isSafeInteger(size) || offset + size > total) throw new Error('HLS fragmented MP4 数据被截断');
    offset += size;
  }
  if (requireInit ? !types.includes('moov') : !types.includes('moof') || !types.includes('mdat')) throw new Error('HLS 没有返回预期的 fragmented MP4 数据');
  if (!requireInit && (types.includes('moov') || types.includes('ftyp'))) throw new Error('HLS 媒体段包含新的初始化数据，无法安全拼接不同编码');
}

function transportSignature(parts) {
  const data = prefix(parts);
  let start = 0;
  if (data[0] === 73 && data[1] === 68 && data[2] === 51 && data.length >= 10) {
    start = 10 + ((data[6] & 127) << 21) + ((data[7] & 127) << 14) + ((data[8] & 127) << 7) + (data[9] & 127);
  }
  if (data[start] !== 0x47 || data[start + 188] !== 0x47 || data[start + 376] !== 0x47) {
    throw new Error('HLS 没有返回预期的 MPEG-TS 数据');
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  if ((total - start) % 188 !== 0) throw new Error('HLS MPEG-TS 数据被截断');
  const read = byteReader(parts);
  for (let packet = start; packet < total; packet += 188) if (read(packet) !== 0x47) throw new Error('HLS MPEG-TS 包结构不完整');
  let programPid;
  for (let packet = start; packet + 188 <= data.length; packet += 188) {
    if (data[packet] !== 0x47) throw new Error('HLS MPEG-TS 包结构不完整');
    const pid = ((data[packet + 1] & 31) << 8) | data[packet + 2];
    if (!(data[packet + 1] & 64)) continue;
    const adaptation = (data[packet + 3] >> 4) & 3;
    if (adaptation !== 1 && adaptation !== 3) continue;
    let payload = packet + 4 + (adaptation === 3 ? 1 + data[packet + 4] : 0);
    if (payload >= packet + 188) continue;
    payload += 1 + data[payload];
    if (payload + 12 >= packet + 188) continue;
    const sectionEnd = payload + 3 + (((data[payload + 1] & 15) << 8) | data[payload + 2]) - 4;
    if (sectionEnd > packet + 188) continue; // Large tables are not guessed.
    if (pid === 0 && data[payload] === 0) {
      for (let position = payload + 8; position + 4 <= sectionEnd; position += 4) {
        if (data[position] || data[position + 1]) { programPid = ((data[position + 2] & 31) << 8) | data[position + 3]; break; }
      }
    } else if (pid === programPid && data[payload] === 2) {
      const tracks = [];
      let position = payload + 12 + (((data[payload + 10] & 15) << 8) | data[payload + 11]);
      while (position + 5 <= sectionEnd) {
        const length = ((data[position + 3] & 15) << 8) | data[position + 4];
        if (position + 5 + length > sectionEnd) throw new Error('HLS MPEG-TS 节目表无效');
        tracks.push([data[position], ((data[position + 1] & 31) << 8) | data[position + 2],
          [...data.subarray(position + 5, position + 5 + length)].join('.')]);
        position += 5 + length;
      }
      if (tracks.length) return JSON.stringify(tracks);
    }
  }
  return null;
}

/** Download an unencrypted complete HLS VOD without transcoding.
 * Muxed TS/fMP4 is copied; separate fMP4 video + AAC audio uses remuxTracks.
 * Separate TS audio, live streams and discontinuous media are rejected.
 * onResolvedUrl(url, {kind,parentUrl}) may asynchronously reject each origin.
 * onProgress receives {phase:'playlist'|'download'|'mux'|'write', progress,
 * downloadedBytes,completedSegments,totalSegments}; bytes counts both inputs.
 * extension is 'ts' or 'mp4', without a leading dot.
 */
export async function downloadHls(url, { signal, onProgress, fetchImpl = fetch, onResolvedUrl, maxBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new Error('HLS 下载大小上限无效');
  let downloadedBytes = 0;
  let completedSegments = 0;
  let totalSegments = 0;
  function progress(phase, value) {
    onProgress?.({ phase, progress: Math.max(0, Math.min(1, value)), downloadedBytes, completedSegments, totalSegments });
  }
  async function request(address, kind, parentUrl, byteRange) {
    abort(signal);
    const resolved = resolveUrl(address, parentUrl);
    await onResolvedUrl?.(resolved, { kind, parentUrl });
    abort(signal);
    const response = await fetchImpl(resolved, { signal, credentials: 'omit', redirect: 'error',
      headers: byteRange ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` } : {} });
    try {
      if (!response.ok) throw new Error(`HLS 请求失败（${response.status}）`);
      if (response.url && resolveUrl(response.url) !== resolved) await onResolvedUrl?.(resolveUrl(response.url), { kind, parentUrl });
      if (byteRange) {
        const contentRange = response.headers?.get('content-range') || '';
        const match = contentRange.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/);
        if (response.status !== 206 || !match || Number(match[1]) !== byteRange.offset || Number(match[2]) !== byteRange.offset + byteRange.length - 1) {
          throw new Error('HLS 服务器没有返回正确的字节范围');
        }
      } else if (response.status === 206) throw new Error('HLS 服务器只返回了部分数据');
      return { response, url: resolved };
    } catch (error) {
      try { await response.body?.cancel?.(); } catch { /* Best-effort connection release. */ }
      throw error;
    }
  }
  progress('playlist', 0);
  let audioSource;
  async function selectPlaylist(address, allowExternalAudio) {
    let current = resolveUrl(address);
    let parentUrl;
    const visited = new Set();
    for (let depth = 0; depth < 5; depth++) {
      if (visited.has(current)) throw new Error('HLS 播放列表循环引用');
      visited.add(current);
      const { response } = await request(current, 'playlist', parentUrl);
      const data = await body(response, { signal, limit: MAX_PLAYLIST_BYTES });
      const playlist = parseHls(await new Blob(data.parts).text(), current);
      if (playlist.encrypted) throw new Error('此 HLS 视频含 AES 加密或 DRM 保护，无法下载');
      if (playlist.kind === 'media') return { playlist, current };
      const variant = [...playlist.variants].sort((a, b) => (b.bandwidth || b.averageBandwidth) - (a.bandwidth || a.averageBandwidth))[0];
      if (!variant) throw new Error('HLS 主播放列表没有可用的视频清晰度');
      if (variant.audioGroup) {
        const group = playlist.audioGroups.filter(audio => audio.groupId === variant.audioGroup);
        if (!group.length) throw new Error('HLS 独立音轨信息缺失，无法合成有声视频');
        const selected = group.find(audio => audio.default) || group.find(audio => audio.autoselect) || group[0];
        if (selected.url) {
          if (!allowExternalAudio || (audioSource && audioSource !== selected.url)) throw new Error('暂不支持多层独立音轨 HLS');
          audioSource = selected.url;
        }
      }
      parentUrl = current;
      current = variant.url;
    }
    throw new Error('HLS 子播放列表层级过多');
  }
  const mapKey = map => JSON.stringify(map);
  function validateMedia(playlist) {
    if (!playlist.endList) throw new Error('暂不支持直播或尚未结束的 HLS 视频');
    if (!playlist.segments.length) throw new Error('HLS 播放列表没有媒体段');
    if (playlist.discontinuity) throw new Error('HLS 含时间轴间断或编码切换，无法安全拼接');
    if (playlist.hasGaps || playlist.iframeOnly) throw new Error('HLS 媒体不完整或只有关键帧预览');
    const firstMap = playlist.segments[0].initMap;
    if (playlist.segments.some(segment => mapKey(segment.initMap) !== mapKey(firstMap))) throw new Error('HLS 初始化段发生变化，无法安全拼接不同编码');
    return firstMap;
  }
  const video = await selectPlaylist(url, true);
  const firstMap = validateMedia(video.playlist);
  let audio;
  if (audioSource) {
    if (!firstMap) throw new Error('此 HLS 使用独立的外部音轨，只有 fMP4 音视频可合成，TS 暂不支持');
    audio = await selectPlaylist(audioSource, false);
    if (!validateMedia(audio.playlist)) throw new Error('独立音轨不是 fMP4，当前版本无法合成有声视频');
  }
  totalSegments = video.playlist.segments.length + (audio?.playlist.segments.length || 0);
  const downloadEnd = audio ? 0.9 : 0.99;
  async function download(address, kind, byteRange, parentUrl) {
    const { response } = await request(address, kind, parentUrl, byteRange);
    const downloaded = await body(response, { signal, limit: maxBytes - downloadedBytes,
      onChunk: (bytes, received, declared) => {
        downloadedBytes += bytes;
        progress('download', (completedSegments + (kind === 'init' ? 0 : declared ? Math.min(received / declared, 1) : 0)) / totalSegments * downloadEnd);
      } });
    if (byteRange && downloaded.bytes !== byteRange.length) throw new Error('HLS 字节范围数据不完整');
    return downloaded;
  }
  async function downloadPlaylist({ playlist, current }) {
    const firstMap = playlist.segments[0].initMap;
    const output = [];
    if (firstMap) {
      const init = await download(firstMap.url, 'init', firstMap.byteRange, current);
      mp4Boxes(init.parts, true);
      const buffer = await new Blob(init.parts).arrayBuffer();
      buffer.fileStart = 0;
      const parsed = createFile();
      parsed.appendBuffer(buffer);
      if (!parsed.moov) throw new Error('HLS 初始化段无法读取');
      if (['encv', 'enca', 'sinf', 'tenc', 'senc', 'pssh'].some(type => parsed.getBox(type))) {
        throw new Error('此 HLS 初始化段含 DRM 加密保护，无法下载');
      }
      output.push(...init.parts);
    }
    let signature;
    for (const segment of playlist.segments) {
      const data = await download(segment.url, 'segment', segment.byteRange, current);
      if (firstMap) mp4Boxes(data.parts, false);
      else {
        const nextSignature = transportSignature(data.parts);
        if (signature && nextSignature && nextSignature !== signature) throw new Error('HLS MPEG-TS 音视频编码发生变化，无法安全拼接');
        signature ||= nextSignature;
      }
      output.push(...data.parts);
      completedSegments++;
      progress('download', completedSegments / totalSegments * downloadEnd);
      abort(signal);
    }
    return new Blob(output, { type: firstMap ? 'video/mp4' : 'video/mp2t' });
  }
  let blob = await downloadPlaylist(video);
  if (audio) {
    const audioBlob = await downloadPlaylist(audio);
    blob = await remuxTracks(await blob.arrayBuffer(), await audioBlob.arrayBuffer(), { signal,
      onProgress: update => progress('mux', 0.9 + update.progress * 0.09) });
  }
  progress('write', 0.99);
  abort(signal);
  const mimeType = firstMap ? 'video/mp4' : 'video/mp2t';
  progress('write', 1);
  return { blob, mimeType, extension: firstMap ? 'mp4' : 'ts' };
}
