import { BoxParser, DataStream, createFile } from '../vendor/mp4box.mjs';

const UINT32_MAX = 0xffffffff;
const MOVIE_TIMESCALE = 1000;
const VIDEO_TYPES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01']);
const PROTECTION_TYPES = ['encv', 'enca', 'sinf', 'tenc', 'senc', 'pssh'];
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消合成', 'AbortError');
}

function report(onProgress, phase, progress) {
  onProgress?.({ phase, progress: Math.max(0, Math.min(1, progress)) });
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`媒体数据不受支持：${label}`);
  }
  return value;
}

// Validate complete box boundaries before parsing. A CDN error body or partial
// range response must never silently become a shorter downloadable MP4.
function inspectTopLevel(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 24) {
    throw new Error('媒体文件为空或不是完整的 MP4');
  }
  const view = new DataView(buffer);
  const boxes = [];
  let position = 0;
  while (position < buffer.byteLength) {
    if (position + 8 > buffer.byteLength) throw new Error('媒体文件末尾不完整');
    let size = view.getUint32(position);
    const type = String.fromCharCode(...new Uint8Array(buffer, position + 4, 4));
    let header = 8;
    if (size === 1) {
      if (position + 16 > buffer.byteLength) throw new Error('媒体文件头不完整');
      size = view.getUint32(position + 8) * 2 ** 32 + view.getUint32(position + 12);
      header = 16;
    } else if (size === 0) size = buffer.byteLength - position;
    if (!Number.isSafeInteger(size) || size < header || position + size > buffer.byteLength) {
      throw new Error('媒体文件被截断或包含无效的 MP4 数据');
    }
    boxes.push({ type, start: position, end: position + size, header });
    position += size;
  }
  if (!boxes.some(box => box.type === 'ftyp') || !boxes.some(box => box.type === 'moov')) {
    throw new Error('此媒体不是带有完整初始化数据的 MP4');
  }
  return boxes.filter(box => box.type === 'mdat');
}

// The progressive MP4 path must enforce the same complete-file requirement as
// remuxing. An HTTP 200 or a valid ftyp alone does not prove a usable video.
export function validateDirectMp4(buffer, expectedBytes = 0, { allowNoAudio = false } = {}) {
  if (expectedBytes > 0 && buffer.byteLength !== expectedBytes) throw new Error('视频长度与来源提供的信息不符，未保存不完整文件。');
  const mediaBoxes = inspectTopLevel(buffer);
  const file = createFile();
  let parseError;
  file.onError = error => { parseError = String(error); };
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();
  if (parseError || !file.moov || PROTECTION_TYPES.some(type => file.getBox(type))) throw new Error('视频结构无效或受保护，无法保存。');
  const info = file.getInfo();
  if (!info.tracks.some(track => track.type === 'video') || (!allowNoAudio && !info.tracks.some(track => track.type === 'audio'))) throw new Error('没有找到完整的声音和画面，未保存该文件。');
  for (const entry of info.tracks) {
    const samples = file.getTrackById(entry.id).samples;
    if (!samples?.length || samples.some(sample => !mediaBoxes.some(box => sample.offset >= box.start + box.header && sample.offset + sample.size <= box.end))) {
      throw new Error('视频数据不完整，未保存该文件。');
    }
  }
}

async function extractTrack(buffer, kind, { signal, onProgress }, progressStart) {
  checkAbort(signal);
  const mediaBoxes = inspectTopLevel(buffer);
  const file = createFile();
  let parseError;
  file.onError = error => { parseError = String(error); };
  buffer.fileStart = 0;
  file.appendBuffer(buffer);
  file.flush();
  if (parseError || !file.moov || !file.ftyp) throw new Error('无法读取 MP4 媒体结构');
  if (PROTECTION_TYPES.some(type => file.getBox(type))) {
    throw new Error('此视频含加密或 DRM 保护，无法合成');
  }
  const info = file.getInfo();
  const candidates = info.tracks.filter(track => track.type === kind);
  if (candidates.length !== 1 || info.tracks.length !== 1) {
    throw new Error(`需要单独的${kind === 'video' ? '视频' : '音频'}轨道文件`);
  }
  const trackInfo = candidates[0];
  const track = file.getTrackById(trackInfo.id);
  const entries = track.mdia.minf.stbl.stsd.entries;
  if (entries.length !== 1) throw new Error('暂不支持播放过程中改变编码配置的媒体');
  const description = entries[0];
  if (kind === 'video' ? !VIDEO_TYPES.has(description.type) : description.type !== 'mp4a') {
    throw new Error('暂不支持此媒体编码，请选择 AVC/H264 视频和 AAC 音频');
  }
  if (kind === 'audio' && !/^mp4a\.40\./.test(trackInfo.codec)) {
    throw new Error('暂不支持非 AAC 音频');
  }
  const timescale = integer(track.mdia.mdhd.timescale, '时间刻度', 1, UINT32_MAX);
  const samples = track.samples;
  if (!samples?.length) throw new Error('媒体轨道没有可读取的音视频帧');
  if (file.moofs.length && samples.some(sample => sample.cts < sample.dts)) {
    // Fragmented signed CTS offsets are interpreted differently by ordinary
    // MP4 demuxers. Refuse rather than silently move video relative to audio.
    throw new Error('暂不支持此流媒体时间轴，请选择其他 AVC 视频清晰度');
  }
  const firstDts = integer(samples[0].dts, '起始时间');
  let expectedDts = firstDts;
  let mediaEnd = 0;
  let presentationEnd = 0;
  let mdatIndex = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    integer(sample.size, '帧长度', 1, UINT32_MAX);
    integer(sample.offset, '帧偏移');
    integer(sample.duration, '帧时长', 1, UINT32_MAX);
    integer(sample.dts, '解码时间');
    integer(sample.cts, '呈现时间', -Number.MAX_SAFE_INTEGER);
    integer(sample.cts - sample.dts, '帧时间偏移', -0x80000000, 0x7fffffff);
    if (sample.dts !== expectedDts) {
      throw new Error('媒体时间轴有间断或重复，请重新获取完整视频');
    }
    if (sample.description_index !== 0) throw new Error('媒体编码配置发生变化');
    while (mdatIndex < mediaBoxes.length && sample.offset >= mediaBoxes[mdatIndex].end) mdatIndex++;
    const mdat = mediaBoxes[mdatIndex];
    if (!mdat || sample.offset < mdat.start + mdat.header || sample.offset + sample.size > mdat.end) {
      throw new Error('媒体帧缺失，下载可能不完整');
    }
    // MP4Box has already resolved the normal/fMP4 sample tables. Using views of
    // the original complete buffer avoids allocating a second media-sized copy.
    sample.data = new Uint8Array(buffer, sample.offset, sample.size);
    sample.alreadyRead = sample.size;
    expectedDts = sample.dts + sample.duration;
    mediaEnd = expectedDts - firstDts;
    presentationEnd = Math.max(presentationEnd, sample.cts + sample.duration - firstDts);
    if (index % 8192 === 8191) {
      report(onProgress, 'parse', progressStart + (index / samples.length) * 0.2);
      await pause();
      checkAbort(signal);
    }
  }
  if (kind === 'video' && !samples[0].is_sync) throw new Error('视频缺少起始关键帧');
  const extracted = [];
  file.discardMdatData = false;
  file.onSamples = (_id, _user, batch) => extracted.push(...batch);
  file.setExtractionOptions(trackInfo.id, null, { nbSamples: 512 });
  file.start();
  file.flush();
  file.stop();
  if (extracted.length !== samples.length) throw new Error('未能提取完整媒体轨道');
  return { buffer, samples: extracted, track, trackInfo, description, timescale, firstDts, mediaEnd, presentationEnd,
    movieTimescale: integer(file.moov.mvhd.timescale, '影片时间刻度', 1, UINT32_MAX) };
}

function runLength(values) {
  const counts = [];
  const result = [];
  for (const value of values) {
    if (result.length && result.at(-1) === value) counts[counts.length - 1]++;
    else { result.push(value); counts.push(1); }
  }
  return { counts, values: result };
}

function writeHeaders(output) {
  const stream = new DataStream();
  output.ftyp.write(stream);
  output.moov.write(stream);
  return stream.buffer;
}

function addOutputTrack(output, input, id, kind) {
  const { trackInfo, description, timescale, mediaEnd, firstDts, presentationEnd } = input;
  const newId = output.addTrack({ id, type: description.type, timescale,
    width: trackInfo.video?.width, height: trackInfo.video?.height,
    hdlr: kind === 'video' ? 'vide' : 'soun', language: trackInfo.language || 'und',
    name: kind === 'video' ? 'Video' : 'Audio', media_duration: mediaEnd });
  if (newId !== id) throw new Error('无法创建 MP4 轨道');
  const track = output.getTrackById(id);
  const stbl = track.mdia.minf.stbl;
  // Preserve the exact original decoder configuration (avcC/hvcC/av1C/esds)
  // and colour/aspect ratio boxes, rather than re-creating a codec declaration.
  description.data_reference_index = 1;
  stbl.stsd.entries = [description];
  track.tkhd.width = input.track.tkhd.width;
  track.tkhd.height = input.track.tkhd.height;
  track.tkhd.matrix = [...input.track.tkhd.matrix];
  track.tkhd.volume = kind === 'audio' ? 256 : 0;
  track.mdia.mdhd.duration = mediaEnd;
  const durations = runLength(input.samples.map(sample => sample.duration));
  stbl.stts.sample_counts = durations.counts;
  stbl.stts.sample_deltas = durations.values;
  const composition = runLength(input.samples.map(sample => sample.cts - sample.dts));
  if (composition.values.some(value => value !== 0)) {
    const ctts = stbl.addBox(new BoxParser.box.ctts());
    ctts.sample_counts = composition.counts;
    ctts.sample_offsets = composition.values;
  }
  stbl.stsz.sample_sizes = input.samples.map(sample => sample.size);
  stbl.stsz.sample_size = 0;
  if (kind === 'video') {
    const stss = stbl.addBox(new BoxParser.box.stss());
    stss.sample_numbers = input.samples.flatMap((sample, index) => sample.is_sync ? [index + 1] : []);
  }
  let edits = input.track.edts?.elst?.entries;
  if (edits?.length) {
    if (edits.length > 16) throw new Error('暂不支持复杂的剪辑时间轴');
    edits = edits.map((edit, index) => {
      if (edit.media_rate_integer !== 1 || edit.media_rate_fraction !== 0) {
        throw new Error('暂不支持非正常播放速度的媒体');
      }
      const mediaTime = edit.media_time === -1 ? -1 : edit.media_time - firstDts;
      integer(mediaTime, '剪辑起始时间', edit.media_time === -1 ? -1 : 0);
      let segmentDuration = Math.round(edit.segment_duration * MOVIE_TIMESCALE / input.movieTimescale);
      // DASH init segments commonly declare a zero-length final media edit.
      // Its actual duration is known only after all moof samples are received.
      if (segmentDuration === 0 && edit.media_time >= 0) {
        if (index !== edits.length - 1) throw new Error('暂不支持复杂的流媒体剪辑时间轴');
        segmentDuration = Math.round((presentationEnd - mediaTime) * MOVIE_TIMESCALE / timescale);
      }
      return { ...edit, media_time: mediaTime,
        segment_duration: integer(segmentDuration, '剪辑时长', 0, UINT32_MAX) };
    });
  } else if (firstDts > 0) {
    edits = [
      { segment_duration: Math.round(firstDts * MOVIE_TIMESCALE / timescale), media_time: -1, media_rate_integer: 1, media_rate_fraction: 0 },
      { segment_duration: Math.ceil(presentationEnd * MOVIE_TIMESCALE / timescale), media_time: 0, media_rate_integer: 1, media_rate_fraction: 0 }
    ];
  }
  if (edits?.length) {
    const edts = track.addBox(new BoxParser.box.edts());
    const elst = edts.addBox(new BoxParser.box.elst());
    elst.version = edits.some(edit => edit.media_time > 0x7fffffff) ? 1 : 0;
    elst.flags = 0;
    elst.entries = edits;
    track.tkhd.duration = edits.reduce((sum, edit) => sum + edit.segment_duration, 0);
  } else track.tkhd.duration = Math.ceil(presentationEnd * MOVIE_TIMESCALE / timescale);
  integer(track.tkhd.duration, '影片时长', 1, UINT32_MAX);

  // One-second chunks keep audio/video interleaved and make the sample index
  // compact. MP4's stsc+stco tables provide ordinary player seek support.
  const chunks = [];
  for (const sample of input.samples) {
    const second = Math.floor((sample.dts - firstDts) / timescale);
    let chunk = chunks.at(-1);
    if (!chunk || chunk.second !== second) {
      chunk = { second, id, input, samples: [], size: 0, time: sample.dts / timescale };
      chunks.push(chunk);
    }
    chunk.samples.push(sample);
    chunk.size += sample.size;
  }
  stbl.stco.chunk_offsets = new Array(chunks.length).fill(0);
  stbl.stsc.first_chunk = [];
  stbl.stsc.samples_per_chunk = [];
  stbl.stsc.sample_description_index = [];
  let previousCount = -1;
  chunks.forEach((chunk, index) => {
    chunk.trackChunkIndex = index;
    if (chunk.samples.length !== previousCount) {
      stbl.stsc.first_chunk.push(index + 1);
      stbl.stsc.samples_per_chunk.push(chunk.samples.length);
      stbl.stsc.sample_description_index.push(1);
      previousCount = chunk.samples.length;
    }
  });
  return { track, chunks };
}

/**
 * Losslessly combine complete DASH / fMP4 video and audio buffers.
 * Does not decode, transcode, decrypt, or access the network.
 * Returns an indexed fast-start MP4 Blob with copied compressed samples.
 * onProgress receives { phase: 'parse'|'mux'|'write', progress: 0..1 }.
 */
export async function remuxTracks(videoBuffer, audioBuffer, { onProgress, signal } = {}) {
  checkAbort(signal);
  report(onProgress, 'parse', 0);
  await pause();
  const video = await extractTrack(videoBuffer, 'video', { signal, onProgress }, 0);
  report(onProgress, 'parse', 0.2);
  await pause();
  const audio = await extractTrack(audioBuffer, 'audio', { signal, onProgress }, 0.2);
  checkAbort(signal);
  report(onProgress, 'mux', 0.4);
  const output = createFile();
  output.init({ timescale: MOVIE_TIMESCALE, brands: ['isom', 'iso2', 'mp41'] });
  const videoOutput = addOutputTrack(output, video, 1, 'video');
  const audioOutput = addOutputTrack(output, audio, 2, 'audio');
  // This is a regular, indexed MP4, so remove the fragment-only mvex/trex.
  output.moov.boxes = output.moov.boxes.filter(box => box.type !== 'mvex');
  delete output.moov.mvex;
  output.moov.mvhd.duration = Math.max(videoOutput.track.tkhd.duration, audioOutput.track.tkhd.duration);
  output.moov.mvhd.volume = 256;
  const chunks = [...videoOutput.chunks, ...audioOutput.chunks].sort((a, b) => a.time - b.time || a.id - b.id);
  const headerSize = writeHeaders(output).byteLength;
  const mediaSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (headerSize + 8 + mediaSize > UINT32_MAX) throw new Error('媒体超过此版本支持的 4 GiB 文件大小');
  let offset = headerSize + 8;
  const mediaParts = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const track = chunk.id === 1 ? videoOutput.track : audioOutput.track;
    track.mdia.minf.stbl.stco.chunk_offsets[chunk.trackChunkIndex] = offset;
    offset += chunk.size;
    // Merge contiguous byte ranges without copying. Fragment headers are skipped.
    let start = chunk.samples[0].offset;
    let end = start;
    for (const sample of chunk.samples) {
      if (sample.offset !== end) {
        if (end > start) mediaParts.push(new Uint8Array(chunk.input.buffer, start, end - start));
        start = sample.offset;
      }
      end = sample.offset + sample.size;
    }
    mediaParts.push(new Uint8Array(chunk.input.buffer, start, end - start));
    if (index % 128 === 127) {
      report(onProgress, 'mux', 0.4 + 0.5 * index / chunks.length);
      await pause();
      checkAbort(signal);
    }
  }
  report(onProgress, 'write', 0.95);
  await pause();
  checkAbort(signal);
  const header = writeHeaders(output);
  if (header.byteLength !== headerSize) throw new Error('MP4 索引尺寸异常');
  const mdatHeader = new Uint8Array(8);
  const mdatView = new DataView(mdatHeader.buffer);
  mdatView.setUint32(0, mediaSize + 8);
  mdatHeader.set([109, 100, 97, 116], 4);
  const blob = new Blob([header, mdatHeader, ...mediaParts], { type: 'video/mp4' });
  if (blob.size !== headerSize + 8 + mediaSize) throw new Error('MP4 文件尺寸异常');
  report(onProgress, 'write', 1);
  return blob;
}
