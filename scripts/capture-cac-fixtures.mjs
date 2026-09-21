/**
 * 一次性脚本：抓取国家网信办「网信@你」栏目的真实页面并裁剪成 fixture 快照
 * （issue #29，第 10 个源）。
 *
 * ## 本源的接入形态
 *
 * 征求意见条目不在首页导航里，而在「互动服务 → 网信@你」
 * （`/hdfw/wxan/A093802index_1.htm`）。栏目是**服务端渲染的静态 HTML**（TRS 系 CMS）：
 * `<div id="loadingInfoPage"><li><h5><a href=… title="…">…</a></h5>`
 * `<div class="times">2026-09-18</div></li>…`，单页 20 条、没有第二页
 * （`…index_2.htm` 实测 404），覆盖最近约 9 个月。
 *
 * ## 裁剪口径（与既有 fixture 一致）
 *
 * - 列表只保留 4 行：3 条征求意见（1 进行中 + 2 已截止）+ 1 条**非**征求意见
 *   （换届征集委员通知，用来验证适配器的标题过滤；它不该产生详情请求，
 *   故 fixture 里**没有**它的详情页 —— 过滤一旦失效，E2E 会立刻暴露）；
 * - 日期换成令牌：列表 `.times` 用 `{{DATE±N}}`、详情正文/发布时刻用 `{{CN_DATE±N}}`，
 *   偏移**按场景固定写死**（不是「抓取当天减真实日期」）—— 这样快照的
 *   「进行中 / 已截止」与倒计时断言在任何一天重跑都成立；
 * - 详情只保留 `.main-title`（h1 + #pubtime）与 `.main-content`（正文 `#BodyLabel`），
 *   去掉脚本 / 样式 / 行内样式；
 * - 链接改成**相对路径**（列表 href 去掉 `//www.cac.gov.cn/` 前缀、正文附件去掉 `/cms/`
 *   前导斜杠），fixture 源站按路径映射，生产环境用真实绝对地址（ADR-0001）。
 *
 * 用法（需要联网访问真实政府站点，只在更新快照时手动跑）：
 *   node scripts/capture-cac-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(repoRoot, 'fixtures', 'e2e-cac', 'cac');
const UA = 'zhurenweng-crawler/0.1 (+https://cn101.top; gov-notice aggregator)';
const SITE = 'https://www.cac.gov.cn';
const LIST_URL = `${SITE}/hdfw/wxan/A093802index_1.htm`;

/**
 * 保留的条目（按原文 URL 精确匹配）与场景日期。
 *
 * `detail` 是「真实日期串 → 令牌」的替换表：日期串取自当前快照的原文，
 * 令牌偏移是**场景设定**（见文件头），因此重抓时若源站改了日期，断言口径不变。
 */
const KEEP = [
  {
    url: `${SITE}/2026-09/18/c_1791482017777471.htm`,
    listDate: '2026-09-18',
    listToken: '{{DATE-3}}',
    detail: [
      ['2026年09月18日', '{{CN_DATE-3}}'],
      ['2026年10月17日', '{{CN_DATE+26}}'],
    ],
  },
  {
    // 截止句是「请于…前将意见反馈给组织起草部门」（extractDeadline 规则 3），
    // 附件是三个无扩展名的下载接口链接；标题不含机关前缀（兜底值场景）
    url: `${SITE}/2026-06/26/c_1784217637474922.htm`,
    listDate: '2026-06-26',
    listToken: '{{DATE-87}}',
    detail: [
      // #pubtime 是补零写法、正文落款是不补零写法，两种都要换（见文件头）
      ['2026年06月26日', '{{CN_DATE-87}}'],
      ['2026年6月26日', '{{CN_DATE-87}}'],
      ['2026年8月25日', '{{CN_DATE-27}}'],
    ],
  },
  {
    url: `${SITE}/2026-07/29/c_1787072711938509.htm`,
    listDate: '2026-07-29',
    listToken: '{{DATE-54}}',
    detail: [
      ['2026年07月29日', '{{CN_DATE-54}}'],
      ['2026年8月28日', '{{CN_DATE-24}}'],
    ],
  },
  {
    // 非征求意见条目：适配器按标题过滤掉，快照里刻意不给它详情页
    url: `${SITE}/2026-09/03/c_1790185079976128.htm`,
    listDate: '2026-09-03',
    listToken: '{{DATE-18}}',
    detail: null,
  },
];

/** 抓取一次，失败重试两次（政府站点偶发连接超时，重跑整脚本代价大）。 */
async function get(url, attempt = 1) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    return get(url, attempt + 1);
  }
}

/** 详情页 → 只留标题 / 发布时刻 / 正文的最小文档。 */
function trimDetail(html, replacements) {
  const $ = cheerio.load(html);
  const title = $('.main-title h1.title').first().html() ?? '';
  const pubtime = $('#pubtime').first().html() ?? '';
  const body = $('.main-content').first().html() ?? '';
  if (title.length === 0 || body.length === 0) {
    throw new Error('详情页缺少 h1.title 或 .main-content（站点模板可能改版）');
  }

  let doc = [
    '<div class="main-title">',
    `<h1 class="title">${title}</h1>`,
    `<div class="info clearfix"><span id="pubtime">${pubtime}</span></div>`,
    '</div>',
    `<div class="main-content">${body}</div>`,
  ].join('\n');

  doc = doc
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\sstyle="[^"]*"/gi, '')
    // 附件下载接口是站内绝对路径 → 源目录内相对路径（见文件头）
    .replace(/href="\/cms\//g, 'href="cms/');

  for (const [from, to] of replacements) {
    if (!doc.includes(from)) {
      throw new Error(`详情页里找不到待替换的日期串「${from}」（站点可能改版）`);
    }
    doc = doc.replaceAll(from, to);
  }
  return doc;
}

/** 包成最小 HTML 文档（带 _snapshot 说明，与既有 fixture 一致）。 */
function wrap({ title, snapshot, content }) {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"><title>' + title + '</title></head>',
    '<body>',
    '<!--',
    `  _snapshot: ${JSON.stringify(snapshot, null, 2).replaceAll('\n', '\n  ')}`,
    '-->',
    content,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

const capturedAt = new Date().toISOString().slice(0, 10);

const listHtml = await get(LIST_URL);
const $list = cheerio.load(listHtml);
/** 原文 URL → 列表行内部 HTML（`<h5>…</h5><div class="times">…</div>`）。 */
const rowByUrl = new Map();
$list('#loadingInfoPage li').each((_, element) => {
  const row = $list(element);
  const href = row.find('a[href]').first().attr('href') ?? '';
  if (href.length === 0) return;
  const url = href.startsWith('//') ? `https:${href}` : new URL(href, LIST_URL).toString();
  rowByUrl.set(url, row.html() ?? '');
});
console.log(`列表行 ${rowByUrl.size} 条（原文 20 条）`);

const rows = [];
const details = [];
for (const entry of KEEP) {
  const inner = rowByUrl.get(entry.url);
  if (inner === undefined) {
    throw new Error(`列表里已找不到条目 ${entry.url}（栏目只保留最近约 9 个月，需换新条目）`);
  }
  let row = inner.replace(/\/\/www\.cac\.gov\.cn\//g, '');
  if (!row.includes(entry.listDate)) {
    throw new Error(`列表行里找不到日期 ${entry.listDate}：${row.slice(0, 200)}`);
  }
  row = row.replaceAll(entry.listDate, entry.listToken);
  rows.push(`<li>${row}</li>`);

  if (entry.detail === null) continue;
  const relativePath = new URL(entry.url).pathname.replace(/^\//, '');
  const detailHtml = await get(entry.url);
  details.push({ relativePath, content: trimDetail(detailHtml, entry.detail) });
  console.log(`详情快照 ${relativePath}`);
}

const listDoc = wrap({
  title: '网信@你_中央网络安全和信息化委员会办公室',
  snapshot: {
    source: LIST_URL,
    capturedAt,
    note: '真实栏目页裁剪：保留 4 条列表行（原文 20 条），去掉页面导航与页脚；href 改为源目录内相对路径；日期换成固定场景偏移的令牌',
  },
  content: [
    '<div class="main">',
    '<div class="news-normal-title"><div class="normal-title">网信@你</div></div>',
    `<div id="loadingInfoPage" class="default">${rows.join('')}</div>`,
    '</div>',
  ].join('\n'),
});

fs.mkdirSync(OUT_ROOT, { recursive: true });
fs.writeFileSync(path.join(OUT_ROOT, 'list.html'), listDoc, 'utf8');
for (const detail of details) {
  const filePath = path.join(OUT_ROOT, detail.relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const title = /<h1 class="title">([\s\S]*?)<\/h1>/.exec(detail.content)?.[1] ?? '网信@你';
  fs.writeFileSync(
    filePath,
    wrap({
      title: title.trim(),
      snapshot: {
        source: `${SITE}/${detail.relativePath}`,
        capturedAt,
        note: '真实详情页裁剪：保留 h1.title / #pubtime / .main-content（正文 #BodyLabel），去掉脚本、样式与页面框架；日期换成令牌；附件链接改为源目录内相对路径',
      },
      content: detail.content,
    }),
    'utf8',
  );
}
console.log(`已写入 ${OUT_ROOT}`);
