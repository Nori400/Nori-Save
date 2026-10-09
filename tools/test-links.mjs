import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVideoLink } from '../extension/lib/links.js';

test('分享文本提取链接并只保留视频和分段', () => {
  const parsed = parseVideoLink('【示例视频】 https://www.bilibili.com/video/BV1xx411c7mD/?p=2&share_source=copy_link。');
  assert.equal(parsed.url, 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
  assert.equal(parsed.page, 2);
});
test('移动版、没有协议和av链接规范化为HTTPS普通播放页', () => {
  assert.equal(parseVideoLink('m.bilibili.com/video/BV1xx411c7mD').url, 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1');
  assert.equal(parseVideoLink('http://bilibili.com/video/av170001/').url, 'https://www.bilibili.com/video/av170001/?p=1');
});
test('短链接可以解析，但不会预先声称知道视频和权限', () => {
  assert.deepEqual(parseVideoLink('b23.tv/Abc1234'), { url: 'https://b23.tv/Abc1234', short: true, kind: 'site' });
});
test('凭据、本地地址、不安全协议与无效分段被拒绝', () => {
  for (const url of ['https://user:pass@www.bilibili.com/video/BV1xx411c7mD/',
    'http://localhost/private', 'http://127.0.0.1/private', 'http://192.168.1.1/video', 'http://[::1]/v', 'ftp://example.com/v.mp4',
    'https://www.bilibili.com/video/BV1xx411c7mD/?p=0',
    'https://www.bilibili.com/video/BV1xx411c7mD/?p=1e3', 'javascript:alert(1)']) {
    assert.throws(() => parseVideoLink(url));
  }
});
test('常见网页、媒体直链与X旧域名可提交', () => {
  assert.equal(parseVideoLink('https://example.com/watch/12#comment').kind, 'generic');
  assert.equal(parseVideoLink('https://cdn.example.com/v.webm?token=synthetic').kind, 'direct');
  assert.equal(parseVideoLink('https://twitter.com/name/status/1578353380363501568/video/2?s=20').url, 'https://x.com/i/status/1578353380363501568/video/2');
});
