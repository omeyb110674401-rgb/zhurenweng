/**
 * 一次性脚本：抓取住房城乡建设部「征求意见」栏目的真实数据并裁剪成 fixture 快照
 * （issue #28，第 9 个源）。
 *
 * ## 本源的接入形态（与 samr / miit 同属 TRS jpaas 家族）
 *
 * 栏目页 `/gongkai/fdzdgknr/zqyj/index.html` 是 **JS 空壳**（gzip 后 1.8KB），
 * 条目由站内接口渲染：`/api-gateway/jpaas-publish-server/front/page/build/unit`
 * （参数从栏目页 `unitbuild.js` 脚本标签的 queryData 原样搬来）。接口响应是
 * `{data:{html:"…"}}`，列表行 `<li class="long-deta">` 里**直接带截止日期**
 * （`<span class="date-info">截止日期 2026-10-18</span>`），是本源截止日期的唯一来源。
 *
 * ## 踩坑记录（值得写下来，因为它浪费过一次排查）
 *
 * 该接口一度返回 `{"success":false,"data":{}}`，看起来像站点加了「授权读取」校验
 * （脚本来自 `/cms_files/default/script/AuthorizedRead/unitbuild.js`）。实际根因是
 * **本机 shell 把中文编成了 GBK**：`curl --data-urlencode "tagId=内容1"` 发出的是
 * `tagId=%c4%da%c8%dd1`（GBK 百分号编码），而接口要 UTF-8 的 `%E5%86%85%E5%AE%B91`
 * —— 服务端匹配不到 tag 就返回 success:false。用 Node 的 `URLSearchParams` 构造请求
 * （生产爬虫正是如此）一切正常。**结论：站点从未拦我们，中文查询参数一律用 UTF-8 百分号编码。**
 *
 * ## 裁剪口径（与既有 fixture 一致）
 *
 * 只保留结构与关键文本、去掉脚本 / 样式 / 行内样式；影响状态与倒计时的日期换成令牌
 * （`{{DATE±N}}` / `{{CN_DATE±N}}`）；列表 href 改成**相对路径**（fixture 源站按路径映射，
 * 生产环境用绝对路径）。
 *
 * 用法（需要联网访问真实政府站点，只在更新快照时手动跑）：
 *   node scripts/capture-mohurd-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(repoRoot, 'fixtures', 'e2e-mohurd', 'mohurd');
const UA = 'zhurenweng-crawler/0.1 (+https://cn101.top; gov-notice aggregator)';

/** 列表接口（参数从栏目页 unitbuild.js 的 queryData 原样搬来，见适配器注释）。 */
const UNIT_API = 'https://www.mohurd.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
const UNIT_QUERY = {
  parseType: 'bulidstatic',
  webId: '86ca573ec4df405db627fdc2493677f3',
  tplSetId: 'fc259c381af3496d85e61997ea7771cb',
  pageType: 'column',
  tagId: '内容1',
  editType: 'null',
  pageId: 'Pgf4Z2WE0oiRbuRzvrIVA',
};

/** 保留的列表行序号（1 起）：三条进行中（部本级 + 办公厅）+ 一条已截止，覆盖两种状态。 */
const KEEP_ROWS = [1, 2, 20];

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
    if (attempt >= 3) throw new Error(`${error.message} ${url}`);
    console.log(`  重试 ${attempt}（${error.message}）`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    return get(url, attempt + 1);
  }
}

/** 今天（本地日历日）的 UTC 零点毫秒数，用于算令牌偏移。 */
const TODAY_UTC = Date.UTC(
  new Date().getFullYear(),
  new Date().getMonth(),
  new Date().getDate(),
);

/** ISO 日期 → `{{DATE±N}}`（今天为 `{{DATE}}`）。 */
function tokenizeIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const diff = Math.round((Date.UTC(y, m - 1, d) - TODAY_UTC) / 86400000);
  if (diff === 0) return '{{DATE}}';
  return diff > 0 ? `{{DATE+${diff}}}` : `{{DATE${diff}}}`;
}

/** 中文日期 → `{{CN_DATE±N}}`。 */
function tokenizeCn(text) {
  return text.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, (_, y, m, d) => {
    const diff = Math.round(
      (Date.UTC(Number(y), Number(m) - 1, Number(d)) - TODAY_UTC) / 86400000,
    );
    if (diff === 0) return '{{CN_DATE}}';
    return diff > 0 ? `{{CN_DATE+${diff}}}` : `{{CN_DATE${diff}}}`;
  });
}

/** 全文日期令牌化：ISO 与中文两种写法都要换（列表用 ISO、正文用中文）。 */
function tokenizeDates(text) {
  return tokenizeCn(
    text.replace(/(\d{4})-(\d{2})-(\d{2})/g, (whole, y, m, d) => {
      // 只换合法日期，避免把「2026-00891」这类索引号切坏
      const month = Number(m);
      const day = Number(d);
      if (month < 1 || month > 12 || day < 1 || day > 31) return whole;
      return tokenizeIso(`${y}-${m}-${d}`);
    }),
  );
}

/** 去掉脚本 / 样式 / 注释 / 行内样式，只留结构。 */
function stripNoise(html) {
  const $ = cheerio.load(html);
  $('script, style, link, noscript, iframe').remove();
  $('*').each((_, element) => {
    const node = $(element);
    node.removeAttr('style');
    node.removeAttr('onclick');
  });
  return $.html();
}

/** 详情快照：只保留 title + 指定 meta + 指定正文容器。 */
function trimDetail(html, { metas, containers, title }) {
  const $ = cheerio.load(html);
  const head = ['<meta charset="utf-8" />', `<title>${title ?? $('title').first().text()}</title>`];
  for (const name of metas) {
    const value = $(`meta[name="${name}"]`).attr('content');
    if (value !== undefined) head.push(`<meta name="${name}" content="${value}" />`);
  }
  const parts = [];
  for (const selector of containers) {
    const node = $(selector).first();
    if (node.length === 0) throw new Error(`详情容器未命中：${selector}`);
    parts.push($.html(node));
  }
  return `${head.join('\n')}\n<body>\n${parts.join('\n')}\n</body>\n`;
}

fs.mkdirSync(OUT_ROOT, { recursive: true });

console.log('抓取列表接口…');
const listUrl = `${UNIT_API}?${new URLSearchParams(UNIT_QUERY).toString()}`;
const listPayload = JSON.parse(await get(listUrl));
if (listPayload.success !== true || typeof listPayload.data?.html !== 'string') {
  throw new Error(`列表接口返回异常：${JSON.stringify(listPayload).slice(0, 200)}`);
}

const listFragment = cheerio.load(listPayload.data.html);
const rows = listFragment('li.long-deta').toArray();
console.log(`  列表行 ${rows.length} 条，保留第 ${KEEP_ROWS.join(' / ')} 条`);

/** 只保留选中的行，并把 href 改成相对路径（fixture 源站按路径映射）。 */
const kept = [];
for (const index of KEEP_ROWS) {
  const row = rows[index - 1];
  if (row === undefined) throw new Error(`列表行 ${index} 不存在（共 ${rows.length} 行）`);
  const anchor = listFragment(row).find('a').first();
  const href = anchor.attr('href') ?? '';
  const title = (anchor.attr('title') ?? '').trim();
  const deadlineText = listFragment(row).find('.date-info').first().text().trim();
  const deadline = /(\d{4}-\d{2}-\d{2})/.exec(deadlineText)?.[1];
  if (href.length === 0 || title.length === 0 || deadline === undefined) {
    throw new Error(`列表行 ${index} 缺 href / title / 截止日期`);
  }
  kept.push({ index, href, title, deadline, relative: href.replace(/^\//, '') });
}

// 列表片段：保留 tab 导航（真实结构，适配器不依赖它）+ 选中的行
const tabNav = listFragment('.mohurdTab-nav').first();
const listHtml = [
  '<div class="mohurdTab-wrapper">',
  tabNav.length > 0 ? listFragment.html(tabNav) : '',
  '<div class="mohurdTab-content solicit-list mt10">',
  '<ul class="solicit-list-ul">',
  ...kept.map((row) => {
    const rowNode = listFragment(rows[row.index - 1]);
    rowNode.find('a').first().attr('href', row.relative);
    return listFragment.html(rowNode);
  }),
  '</ul>',
  '</div>',
  '</div>',
].join('\n');

const listOut = {
  _snapshot: {
    source: listUrl,
    capturedAt: new Date().toISOString().slice(0, 10),
    note: `真实接口响应裁剪：保留 ${kept.length} 条列表行（原 ${rows.length} 条，栏目共 585 条），去掉检索表单与内联样式；截止日期换成日期令牌；href 改为相对路径`,
  },
  code: listPayload.code,
  success: listPayload.success,
  data: { html: tokenizeDates(listHtml) },
};
fs.writeFileSync(
  path.join(OUT_ROOT, 'list.json'),
  `${JSON.stringify(listOut, null, 2)}\n`,
);
console.log(`  写入 list.json（${kept.length} 条）`);

console.log('抓取详情页…');
for (const row of kept) {
  const html = await get(`https://www.mohurd.gov.cn${row.href}`);
  const trimmed = trimDetail(html, {
    metas: ['ArticleTitle', 'PubDate', 'ContentSource', 'ColumnName', 'SiteName', 'ColumnType'],
    containers: ['.editor-content', '.editorContent-download'],
    title: row.title,
  });
  const target = path.join(OUT_ROOT, row.relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, tokenizeDates(stripNoise(trimmed)));
  console.log(`  写入 ${row.relative}（截止 ${row.deadline}）`);
}

console.log('完成。');
