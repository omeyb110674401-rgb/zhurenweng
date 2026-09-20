/**
 * 一次性脚本：抓取 M2 扩源（samr / miit / mot / moe）的真实页面并裁剪成 fixture 快照。
 *
 * 产出 fixtures/e2e-sources/<source>/ 下的列表与详情快照。裁剪口径与既有 fixture 一致：
 * 只保留结构与关键文本（正文截断）、去掉脚本 / 样式 / 行内样式、发布日期等历史事实写死、
 * 影响状态与倒计时的日期换成令牌（{{DATE±N}} / {{CN_DATE±N}} / {{EPOCH±N}}）。
 *
 * 用法（需要联网访问真实政府站点，只在更新快照时手动跑）：
 *   node scripts/capture-m2-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_ROOT = path.join(repoRoot, 'fixtures', 'e2e-sources');
const UA = 'zhurenweng-crawler/0.1 (+https://cn101.top; gov-notice aggregator)';

/** 抓取一次，失败重试两次（政府站点偶发连接超时，重跑整脚本代价大）。 */
async function get(url, attempt = 1) {
  try {
    const response = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    if (attempt >= 3) throw new Error(`${error.message} ${url}`);
    console.log(`  重试 ${attempt}（${error.message}）`);
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    return get(url, attempt + 1);
  }
}

/** 去掉脚本 / 样式 / 注释 / 行内样式，只留结构（保留 html/head/body 骨架）。 */
function stripNoise(html) {
  const $ = cheerio.load(html);
  $('script, style, link, noscript, iframe, meta[http-equiv]').remove();
  $('*').each((_, element) => {
    const node = $(element);
    node.removeAttr('style');
    node.removeAttr('onclick');
    node.removeAttr('oldsrc');
  });
  return $.html();
}

/**
 * 保留 head 里的 title + 指定 meta，正文取指定容器（可多个）。
 * prune：从克隆里删掉的容器（页面上与正文同级的分享 / 音频播放器等装饰块）。
 */
function trimDetail(html, { metas, containers, prune = [], maxBlocks = 10, title }) {
  const $ = cheerio.load(html);
  const head = [`<meta charset="utf-8" />`, `<title>${title ?? $('title').first().text()}</title>`];
  for (const name of metas) {
    const value = $(`meta[name="${name}"]`).attr('content');
    if (value !== undefined) head.push(`<meta name="${name}" content="${value}" />`);
  }
  const body = [];
  for (const selector of containers) {
    const nodes = $(selector);
    if (nodes.length === 0) continue;
    // 命中多个容器时逐个保留（如市场监管总局的附件清单容器出现两次，见适配器注释）
    nodes.each((_, element) => {
      const clone = $(element).clone();
      for (const selectorToPrune of prune) clone.find(selectorToPrune).remove();
      // 正文截断：块级子元素过多的只保留前 maxBlocks 个（快照只承载结构与关键文本）
      const blocks = clone.children('p, div, li, td');
      if (blocks.length > maxBlocks) {
        blocks.slice(maxBlocks).remove();
        clone.append('<p>（正文其余段落已裁剪）</p>');
      }
      body.push($.html(clone));
    });
  }
  return `<!doctype html>\n<html lang="zh-CN">\n  <head>\n    ${head.join('\n    ')}\n  </head>\n  <body>\n${body.join('\n')}\n  </body>\n</html>\n`;
}

/** 替换：按顺序把字面量换成令牌（用于把真实日期锚定到相对日期）。 */
function tokenize(text, replacements) {
  let out = text;
  for (const [from, to] of replacements) {
    out = out.split(from).join(to);
  }
  return out;
}

function write(relativePath, content) {
  const file = path.join(OUT_ROOT, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`  写入 ${relativePath} (${content.length} 字节)`);
}

// ─────────────────────────────── samr ───────────────────────────────

const SAMR_API = 'https://www.samr.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
const SAMR_QUERY = {
  parseType: 'bulidstatic',
  webId: '29e9522dc89d4e088a953d8cede72f4c',
  tplSetId: '5c30fb89ae5e48b9aefe3cdf49853830',
  pageType: 'column',
  tagId: '内容区域',
  editType: 'null',
  pageId: 'b00644872e354a96b66e3cd954e9996f',
};

async function captureSamr() {
  console.log('samr：抓列表接口');
  const payload = await get(`${SAMR_API}?${new URLSearchParams(SAMR_QUERY)}`);
  const parsed = JSON.parse(payload);
  const rows = [...parsed.data.html.matchAll(/<li class="zjnav04Left02_content">[\s\S]*?<\/li>/g)].map(
    (match) => match[0],
  );
  const pick = (fragment) => rows.find((row) => row.includes(fragment));

  // 保留 5 条（3 进行中 / 2 已结束），征集期换成令牌 —— 起作发布日期、止作截止日期
  const plan = [
    ['art_7690dba6fb90477cae8299c67f7966d9', '{{DATE-3}}至{{DATE+27}}'],
    ['art_52ab04656e214654b6255ef099d6bc01', '{{DATE-11}}至{{DATE+20}}'],
    ['art_fa9c0ba512ff4d8790aff5abd4c3ef65', '{{DATE-23}}至{{DATE+7}}'],
    ['art_68686f054fe043b6b62c21f50e230b79', '{{DATE-19}}至{{DATE-12}}'],
    ['art_9229ca8fad4f4df5b65af58ff2bdb025', '{{DATE-39}}至{{DATE-7}}'],
  ];
  const kept = plan.map(([fragment, period]) => {
    const row = pick(fragment);
    if (!row) throw new Error(`samr 列表里找不到 ${fragment}`);
    return row
      .replace(/<div class="doctime[^"]*">[^<]*<\/div>/, `<div class="doctime tim">${period}</div>`)
      // 真实 href 是站内绝对路径（/hd/zjdc/…）：快照改为从源根起的相对路径，
      // 使「相对列表地址解析」在 fixture 源站内落位（见 fixtures/README.md）
      .replace(/href="\//, 'href="');
  });

  const envelope = {
    _snapshot: {
      source: `${SAMR_API}?${new URLSearchParams(SAMR_QUERY)}`,
      capturedAt: '2026-09-20',
      note: '真实接口响应裁剪：只保留 5 条列表行（原 21 条），去掉检索表单与内联样式；征集期换成日期令牌',
    },
    code: '200',
    success: true,
    data: { html: `<div class="page-content"><ul class="Three_zhnlist_02">${kept.join('\n')}</ul></div>` },
  };
  write('samr/list.json', `${JSON.stringify(envelope, null, 2)}\n`);

  const details = [
    ['hd/zjdc/art/2026/art_7690dba6fb90477cae8299c67f7966d9.html', '{{CN_DATE+27}}'],
    ['hd/zjdc/art/2026/art_68686f054fe043b6b62c21f50e230b79.html', '{{CN_DATE-12}}'],
    ['hd/zjdc/art/2026/art_645badc2faaa4f7fa52f9ba11ba7a0bd.html', null],
  ];
  for (const [urlPath, deadline] of details) {
    console.log(`samr：抓详情 ${urlPath}`);
    let html = trimDetail(await get(`https://www.samr.gov.cn/${urlPath}`), {
      metas: ['ArticleTitle', 'ColumnName', 'PubDate', 'ContentSource'],
      containers: ['.Three_xilan_07', 'ul.contentLeft0102box'],
    });
    // 详情里的截止句与列表征集期同日：换成同一令牌，保证两条路径解析出同一日期
    if (deadline) {
      html = html.replace(/意见反馈截止时间为[^。]{0,20}/, `意见反馈截止时间为${deadline}`);
    }
    write(`samr/${urlPath}`, stripNoise(html));
  }
}

// ─────────────────────────────── miit ───────────────────────────────

const MIIT_API = 'https://www.miit.gov.cn/api-gateway/jpaas-publish-server/front/page/build/unit';
const MIIT_QUERY = {
  parseType: 'buildstatic',
  webId: '8d828e408d90447786ddbe128d495e9e',
  tplSetId: '209741b2109044b5b7695700b2bec37e',
  pageType: 'column',
  tagId: '右侧内容',
  editType: 'null',
  pageId: 'ff3aac0962cb45e48e8e4da69450e847',
};

async function captureMiit() {
  console.log('miit：抓列表接口');
  const payload = await get(`${MIIT_API}?${new URLSearchParams(MIIT_QUERY)}`);
  const parsed = JSON.parse(payload);
  const rows = [...parsed.data.html.matchAll(/<li[^>]*>[\s\S]*?<\/li>/g)]
    .map((match) => match[0])
    .filter((row) => row.includes('span class="fr"'));
  const pick = (fragment) => rows.find((row) => row.includes(fragment));

  // 保留 4 条（3 进行中 / 1 已过期），endtime 换成 EPOCH 令牌
  const plan = [
    ['art_03d6631242cd45c5bef6e8d62571beff', '{{EPOCH+27}}'],
    ['art_ebc8c235df1b4582bcbdb5b54a1d0125', '{{EPOCH+24}}'],
    ['art_8f612a418b71457e9cc49b424cc01937', '{{EPOCH+21}}'],
    ['art_3c2e4c31f3174237ba8575b3d8a8745d', '{{EPOCH-10}}'],
  ];
  const kept = plan.map(([fragment, epoch]) => {
    const row = pick(fragment);
    if (!row) throw new Error(`miit 列表里找不到 ${fragment}`);
    return row
      .replace(/<span class="endtime"[^>]*>[^<]*<\/span>/, `<span class="endtime" style="display:none !important;">${epoch}</span>`)
      // 真实 href 是站内绝对路径（/gzcy/yjzj/art/…）：快照改为相对路径（同上）
      .replace(/href="\//, 'href="');
  });

  const envelope = {
    _snapshot: {
      source: `${MIIT_API}?${new URLSearchParams(MIIT_QUERY)}`,
      capturedAt: '2026-09-20',
      note: '真实接口响应裁剪：只保留 4 条列表行（原 24 条），去掉检索表单与内联样式；endtime 时间戳换成 {{EPOCH±N}} 令牌',
    },
    code: '200',
    success: true,
    data: { html: `<div class="clist_con"><ul>${kept.join('\n')}</ul></div>` },
  };
  write('miit/list.json', `${JSON.stringify(envelope, null, 2)}\n`);

  const details = [
    ['gzcy/yjzj/art/2026/art_ebc8c235df1b4582bcbdb5b54a1d0125.html', ['2026年10月14日', '{{CN_DATE+24}}']],
    ['gzcy/yjzj/art/2026/art_3c2e4c31f3174237ba8575b3d8a8745d.html', ['2026年9月10日', '{{CN_DATE-10}}']],
  ];
  for (const [urlPath, replacement] of details) {
    console.log(`miit：抓详情 ${urlPath}`);
    let html = trimDetail(await get(`https://www.miit.gov.cn/${urlPath}`), {
      metas: ['ArticleTitle', 'ColumnName', 'PubDate', 'ContentSource'],
      containers: ['#con_con'],
    });
    if (replacement) html = tokenize(html, [replacement]);
    write(`miit/${urlPath}`, stripNoise(html));
  }
}

// ─────────────────────────────── mot ───────────────────────────────

async function captureMot() {
  console.log('mot：抓列表');
  const listHtml = await get('https://www.mot.gov.cn/hudong/yijianzhengji/index.html');
  const $ = cheerio.load(listHtml);
  const items = [];
  $('ul.news-list li.news-item').each((_, element) => {
    const row = $(element);
    const href = row.find('a.news-link').attr('href') ?? '';
    if (!href.startsWith('./')) return; // 本部条目（跨域条目在 fixture 里单独合成）
    items.push({
      href: href.replace(/^\.\//, 'hudong/yijianzhengji/'),
      status: row.find('.statusX').text().trim(),
      title: row.find('.news-title').text().replace(/\s+/g, ' ').trim(),
      date: row.find('.news-date').text().trim(),
    });
  });
  console.log(`  本部条目 ${items.length} 条`);
  for (const item of items) console.log(`   ${item.status} ${item.date} ${item.title.slice(0, 40)}`);

  const open = items.find((item) => item.status.includes('进行中'));
  const closed = items.filter((item) => item.status.includes('已结束')).slice(0, 2);
  const results = items.find((item) => item.status === ''); // 「公开征求意见反馈情况」：结果反馈，非待参与条目
  const chosen = [open, ...closed, results].filter(Boolean);

  /** 真实条目行：.news-title 文本已含内层 .statusX 标注，不能再套一层（否则出现两个标注）。 */
  const realRow = (item) => `
      <li class="news-item">
        <a href="${item.href}" target="_blank" class="news-link">
          <span class="news-title"><span class="statusX">${item.status}</span> - ${item.title.replace(/^\s*(\[[^\]]*\]|-)\s*-?\s*/, '')}</span>
          <span class="news-date">${item.date}</span>
        </a>
      </li>`;

  // 合成条目（fixture 允许场景合成，见 fixtures/README.md「快照来源与裁剪标注」）：
  // ① 跨域条目：真实站点里是 https://www.caac.gov.cn/… 的绝对地址，快照改写成
  //    fixture 源站内的相对路径，指向一份「其它站点模板」的详情页 —— 用于验证
  //    「跨域详情解析不到正文 / 截止日期时，状态退回源标注」；
  // ② 标注与截止日期冲突的条目：标注 [进行中] 但详情截止日期已过 ——
  //    用于锁定「截止日期优先于源标注」的推导次序。
  const rows = chosen.map(realRow);
  rows.push(`
      <li class="news-item">
        <a href="foreign/caac-t20260908.html" target="_blank" class="news-link">
          <span class="news-title"><span class="statusX">[进行中]</span> - 中国民航局关于《运输机场运营许可规定（征求意见稿）》公开征求意见的通知</span>
          <span class="news-date">2026-09-09</span>
        </a>
      </li>`);
  rows.push(`
      <li class="news-item">
        <a href="hudong/yijianzhengji/202609/t20260910_4299999.html" target="_blank" class="news-link">
          <span class="news-title"><span class="statusX">[进行中]</span> - 关于《公路水运工程安全生产监督管理办法（修订征求意见稿）》公开征求意见的通知</span>
          <span class="news-date">2026-09-10</span>
        </a>
      </li>`);

  write(
    'mot/list.html',
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>意见征集-互动-中华人民共和国交通运输部</title>
  </head>
  <body>
    <!--
      fixture 快照：交通运输部「意见征集」列表页（真实结构，2026-09-20 实抓后裁剪）。
      真实来源：https://www.mot.gov.cn/hudong/yijianzhengji/index.html
      结构要点：<ul class="news-list"><li class="news-item"><a class="news-link"> 内含
      <span class="news-title"><span class="statusX">[进行中]</span> - 标题</span> 与
      <span class="news-date">2026-09-07</span>。**状态标注是本源的真实列表判据**：
      状态位为空的两类内容（答记者问、公开征求意见反馈情况）不是征求意见条目，被适配器过滤。
      真实列表里条目链接跨域混排（民航局 / 铁路局站点用绝对地址）；快照里改为
      fixture 源站内的相对路径（E2E 不访问真实站点，ADR-0001），并保留「模板不同」
      这一关键事实（见 foreign/caac-t20260908.html）。列表快照位于 <源根>/list.html
      （真实页面在 /hudong/yijianzhengji/ 下），故 href 从源根起用相对路径书写。
      本文件含两条**场景合成**条目（真实列表里没有对应条目，见下），其余为真实条目：
      ① foreign/caac-…：跨域条目，详情页是别的站点模板 → 状态退回源标注；
      ② t20260910_4299999：标注 [进行中] 但详情截止日期已过 → 锁定「截止日期优先于源标注」。
      截止日期在详情页正文（「意见反馈截止日期为…」），用 {{CN_DATE±N}} 令牌。
    -->
    <section class="news-list-section">
      <div class="news-list-block">
        <ul class="news-list">${rows.join('')}
        </ul>
      </div>
    </section>
  </body>
</html>
`,
  );

  // 详情：真实本部条目（进行中 / 已结束各若干）+ 一条合成冲突条目
  // 每条声明一组按序替换：真实日期 → 令牌（截止日期）与合成条目的文本改写
  const detailPlan = [
    [open.href, 'https://www.mot.gov.cn/' + open.href, [['2026年10月7日', '{{CN_DATE+17}}']]],
    ...closed.map((item) => [item.href, 'https://www.mot.gov.cn/' + item.href, []]),
    [
      'hudong/yijianzhengji/202609/t20260910_4299999.html',
      // 合成条目复用真实页面骨架（真实列表里没有「标注进行中但已过期」的条目）
      'https://www.mot.gov.cn/hudong/yijianzhengji/202609/t20260903_4223746.html',
      [
        [
          '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知',
          '关于《公路水运工程安全生产监督管理办法（修订征求意见稿）》公开征求意见的通知',
        ],
        [
          '《中华人民共和国公路法（修正草案征求意见稿）》',
          '《公路水运工程安全生产监督管理办法（修订征求意见稿）》',
        ],
        ['意见反馈截止日期为2026年10月7日', '意见反馈截止日期为{{CN_DATE-3}}'],
      ],
    ],
  ];
  for (const [href, url, replacements] of detailPlan) {
    console.log(`mot：抓详情 ${url}${url.includes('t20260903') ? '（合成条目复用真实页面骨架）' : ''}`);
    let html = trimDetail(await get(url), {
      metas: [],
      containers: ['h1.article-title', '.article-meta', '#article-content'],
      prune: ['.meta-right'],
    });
    html = tokenize(html, replacements);
    write(`mot/${href}`, stripNoise(html));
  }

  // 跨域站点的「其它模板」详情页：结构与 mot 本部模板不同，适配器解析不到正文与截止日期
  write(
    'mot/foreign/caac-t20260908.html',
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>中国民航局关于《运输机场运营许可规定（征求意见稿）》公开征求意见的通知</title>
  </head>
  <body>
    <!--
      fixture 快照：**其它站点模板**（民航局站点）的占位详情页。
      真实列表里这条是跨域绝对地址 https://www.caac.gov.cn/HDJL/YJZJ/202609/t20260908_231688.html；
      快照把 href 改写为 fixture 源站内的相对路径（E2E 不访问真实站点，ADR-0001），
      并保留「模板与本部不同」这一关键事实：页面里没有 h1.article-title / #article-content，
      适配器解析不到标题、正文与截止日期，条目状态应退回列表层的 [进行中] 标注。
    -->
    <div class="caac-article">
      <h2>中国民航局关于《运输机场运营许可规定（征求意见稿）》公开征求意见的通知</h2>
      <div class="caac-body"><p>（其它站点模板，结构与本产品适配的交通运输部本部模板不同。）</p></div>
    </div>
  </body>
</html>
`,
  );
}

// ─────────────────────────────── moe ───────────────────────────────

async function captureMoe() {
  console.log('moe：抓列表');
  const listHtml = await get('http://www.moe.gov.cn/jyb_xwfb/s248/');
  const $ = cheerio.load(listHtml);
  const rows = [];
  $('#list li').each((_, element) => {
    const anchor = $(element).find('a[href]').first();
    if (anchor.length === 0) return;
    rows.push({
      href: (anchor.attr('href') ?? '').replace(/^\.\//, 'jyb_xwfb/s248/'),
      title: anchor.attr('title') ?? '',
      text: anchor.text().replace(/\s+/g, ' ').trim(),
      date: $(element).find('span').first().text().trim(),
    });
  });
  console.log(`  条目 ${rows.length} 条，最新 ${rows[0]?.date}`);

  const chosen = [
    rows[0], // 校外培训管理条例
    rows.find((row) => row.text.includes('...')), // 联合发布 + 链接文本被截断（title 属性完整）
    rows.find((row) => row.title.includes('教师法')),
  ].filter(Boolean);

  // href 从源根起写（真实页面是 ./202402/…）：相对列表地址解析后落在 fixture 目录内
  const listRows = chosen.map((row) => `
      <li${row === rows[1] ? ' class="moe_list_group_line"' : ''}><a href="${row.href}" target="_blank" title="${row.title}">${row.text}</a><span>${row.date}</span></li>`);

  write(
    'moe/list.html',
    `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>征求意见 - 中华人民共和国教育部政府门户网站</title>
  </head>
  <body>
    <!--
      fixture 快照：教育部「征求意见」列表页（真实结构，2026-09-20 实抓后裁剪）。
      真实来源：http://www.moe.gov.cn/jyb_xwfb/s248/
      结构要点：<div id="list"><li><a href title>标题</a><span>2024-02-08</span></li>；
      标题必须取 title 属性 —— 第 2 条（联合发布）链接文本被截断成「…」而属性完整；
      状态标注 [已结束] 在标题前缀里。列表快照位于 <源根>/list.html（真实页面在
      /jyb_xwfb/s248/ 下），故 href 从源根起用相对路径书写。
      本栏目自 2024-02 起未再更新（历史归档），发布日期与截止日期都是历史事实，不用令牌。
    -->
    <div id="list">${listRows.join('')}
    </div>
  </body>
</html>
`,
  );

  for (const row of chosen) {
    console.log(`moe：抓详情 ${row.href}`);
    write(
      `moe/${row.href}`,
      stripNoise(
        // 保留 .moe-detail-box 容器本体（而不是它的后代）：适配器用
        // `.moe-detail-box h1` / `.moe-detail-box .TRS_Editor` 这类后代选择器定位，
        // 只留后代会把祖先 class 丢掉，快照就测不到真实选择器了
        trimDetail(await get(`http://www.moe.gov.cn/${row.href}`), {
          metas: [],
          containers: ['.moe-detail-box'],
          prune: ['#moeCode', '#moe-detail-page-set', '.shoucang'],
          maxBlocks: 20,
        }),
      ),
    );
  }
}

// 可用参数只重抓某个源：node scripts/capture-m2-fixtures.mjs moe
const requested = process.argv.slice(2);
const captures = { samr: captureSamr, miit: captureMiit, mot: captureMot, moe: captureMoe };
const selected = requested.length > 0 ? requested : Object.keys(captures);
let failed = 0;
for (const name of selected) {
  try {
    await captures[name]();
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name} 抓取失败：${error.message}`);
  }
}
console.log(failed === 0 ? '完成。' : `完成，${failed} 个源失败。`);
process.exitCode = failed === 0 ? 0 : 1;
