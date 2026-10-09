// Serialized into the submitted source page. No page scripts are executed.
export function readImagesPage() {
  const images = new Map();
  const add = (value, extra = {}) => {
    if (!value || images.size >= 1200) return;
    try {
      const url = new URL(value, document.baseURI);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      const prior = images.get(url.href) || {};
      images.set(url.href, { ...prior, url: url.href, width: Math.max(prior.width || 0, extra.width || 0),
        height: Math.max(prior.height || 0, extra.height || 0), alt: extra.alt || prior.alt || '' });
    } catch { /* Ignore malformed and non-network image values. */ }
  };
  const srcset = value => {
    const text = String(value || '');
    let position = 0;
    while (position < text.length) {
      while (position < text.length && /[\s,]/.test(text[position])) position++;
      const start = position;
      while (position < text.length && !/\s/.test(text[position])) position++;
      const token = text.slice(start, position);
      if (!token) break;
      add(token.replace(/,+$/, ''));
      // Commas inside a CDN URL belong to that URL; descriptors end at comma.
      if (!token.endsWith(',')) {
        while (position < text.length && text[position] !== ',') position++;
      }
    }
  };
  const visit = root => {
    for (const image of root.querySelectorAll('img')) {
      const extra = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height, alt: image.alt };
      add(image.currentSrc || image.src, extra);
      srcset(image.srcset);
      for (const name of ['data-src', 'data-original', 'data-lazy-src', 'data-url']) add(image.getAttribute(name), { alt: extra.alt });
      srcset(image.getAttribute('data-srcset'));
    }
    for (const source of root.querySelectorAll('picture source')) srcset(source.srcset);
    for (const video of root.querySelectorAll('video[poster]')) add(video.poster, { alt: '视频封面' });
    for (const element of root.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      for (const match of style.backgroundImage.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/g)) add(match[1] || match[2] || match[3]);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  for (const meta of document.querySelectorAll('meta[property="og:image"],meta[property="og:image:secure_url"]')) add(meta.content);
  return { page: { title: document.title || '当前页面', url: location.href }, images: [...images.values()] };
}

export function imageFilename(title, proposed, extension) {
  const clean = value => {
    let text = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').trim().slice(0, 100).replace(/[. ]+$/g, '') || '图片';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(text)) text = `_${text}`;
    return text;
  };
  const base = String(proposed || '图片').replace(/\.[a-z\d]{1,6}$/i, '');
  return `Nori Save-images/${clean(title)}/${clean(base)}.${extension}`;
}
