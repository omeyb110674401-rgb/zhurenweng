/**
 * 探针（issue #23 后续）：民航局 / 国家铁路局详情页模板结构。
 * 目的：找出正文容器、发布日期、截止日期句、附件链接的可复用选择器。
 * 用法：node scripts/probe-cross-domain.mjs <url> [url...]
 */
import * as cheerio from 'cheerio';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEADLINE = /(?:截止|反馈截止|征求意见截止)[^。；;\n]{0,40}?(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日)/g;

const urls = process.argv.slice(2);
for (const url of urls) {
  console.log('='.repeat(100));
  console.log('URL:', url);
  let html;
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    });
    console.log('HTTP:', response.status, response.headers.get('content-type'));
    html = await response.text();
  } catch (error) {
    console.log('抓取失败:', error.message);
    continue;
  }
  console.log('字节数:', Buffer.byteLength(html, 'utf8'));

  const $ = cheerio.load(html);
  console.log('title:', $('title').text().trim().slice(0, 80));
  console.log('h1:', $('h1').first().text().trim().slice(0, 80));
  console.log('meta 日期候选:');
  $('meta').each((_, el) => {
    const name = ($(el).attr('name') ?? $(el).attr('property') ?? '').toLowerCase();
    if (/date|time|pub/.test(name)) console.log('   ', name, '=', $(el).attr('content'));
  });

  // 候选正文容器：按文本长度排序，找出真正的正文块
  console.log('候选容器（按文本长度，前 12）:');
  const candidates = [];
  $('div, article, section').each((_, el) => {
    const $el = $(el);
    const id = $el.attr('id');
    const cls = $el.attr('class');
    if (!id && !cls) return;
    const text = $el.text().replace(/\s+/g, '');
    if (text.length < 120) return;
    // 只保留「没有更长的同类后代」的容器：粗略用类名去重
    candidates.push({
      sel: `${el.tagName}${id ? `#${id}` : ''}${cls ? `.${cls.split(/\s+/).join('.')}` : ''}`,
      len: text.length,
    });
  });
  candidates.sort((a, b) => b.len - a.len);
  const seen = new Set();
  for (const item of candidates) {
    if (seen.has(item.sel)) continue;
    seen.add(item.sel);
    console.log(`    ${String(item.len).padStart(6)}  ${item.sel.slice(0, 110)}`);
    if (seen.size >= 12) break;
  }

  // 截止日期句
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const hits = [...bodyText.matchAll(DEADLINE)].map((m) => m[0].slice(0, 60));
  console.log('截止日期句:', hits.length ? hits.slice(0, 4) : '（未匹配）');

  // 附件
  const files = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/\.(docx?|wps|pdf|xlsx?|zip|rar)(\?|$)/i.test(href)) {
      files.push({ text: $(el).text().trim().slice(0, 30), href: href.slice(0, 90) });
    }
  });
  console.log('附件链接:', files.length ? files.slice(0, 5) : '（无）');
}
