import { safeHttpUrl } from './media.js';

export function parseVideoLink(input) {
  const value = String(input || '').trim();
  if (!value || value.length > 6000) throw new Error('请输入视频链接，或粘贴包含链接的分享文字。');
  if (/^(?:file|ftp|javascript|data|blob):/i.test(value)) throw new Error('请输入公开网页的HTTP或HTTPS链接。');
  const match = value.match(/https?:\/\/[^\s<>"'\[\]{}]+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'\[\]{}]+/i);
  if (!match) throw new Error('没有找到有效链接，请粘贴完整的视频播放页地址。');
  const raw = match[0].replace(/[，。；！、（）《》【】]+$/g, '');
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { throw new Error('链接格式不正确，请检查后重试。'); }
  if (!safeHttpUrl(url.href)) throw new Error('请输入公开网页的HTTP或HTTPS链接。');
  if (url.hostname === 'b23.tv') {
    if (!/^\/[\w-]{1,100}\/?$/.test(url.pathname)) throw new Error('短链接格式不正确。');
    return { url: `https://b23.tv${url.pathname}`, short: true, kind: 'site' };
  }
  if (['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(url.hostname)) {
    if (url.port) throw new Error('X 链接不能使用自定义端口。');
    const status = url.pathname.match(/\/(?:status|statuses)\/(\d{10,22})(?:\/video\/(\d+))?(?:\/|$)/i);
    if (!status) throw new Error('请输入含有视频的X帖子链接。');
    return { url: `https://x.com/i/status/${status[1]}${status[2] ? `/video/${status[2]}` : ''}`, kind: 'x', short: false, statusId: status[1] };
  }
  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
    const id = url.pathname.match(/^\/video\/(BV[a-z0-9]{10}|av[1-9]\d*)(?:\/|$)/i)?.[1];
    if (id) {
      const pageText = url.searchParams.get('p') || '1';
      const page = Number(pageText);
      if (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error('链接里的分段编号无效。');
      const videoId = id.slice(0, 2).toUpperCase() === 'BV' ? `BV${id.slice(2)}` : `av${id.slice(2)}`;
      return { url: `https://www.bilibili.com/video/${videoId}/?p=${page}`, short: false, page, videoId, kind: 'site' };
    }
  }
  url.hash = '';
  return { url: url.href, short: false, kind: /\.(?:mp4|webm|m3u8)(?:$)/i.test(url.pathname) ? 'direct' : 'generic' };
}
