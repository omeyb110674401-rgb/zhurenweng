import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';

/**
 * E2E（issue #5）：源注册配置化与多源聚合。
 *
 * 本文件随切片演进（每接入一个源扩展一组断言）：
 * - moj（司法部征求意见系统）：卡片 + 表格混合列表、面包屑机关、
 *   截止提示条、文末附件区（含无附件条目路径）；
 * - mee（生态环境部「意见征集」栏目，issue #14 替代下线的中国政府网栏目）：两套详情模板、
 *   关联部门与截止日期框；
 * - 跨源去重：同一原文 URL 出现在两个源的列表，断言入库只有一条。
 *
 * 新增源只新增适配器文件 + 注册数组条目 + fixture 目录（核心代码零改动，
 * 见该提交的共享文件清单），场景经 SOURCES_FIXTURE_BASE 注入本地 fixture
 * 源站、真实 worker 进程 WORKER_ONCE=1 触发，全程从 HTTP 层断言。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue5-'));
const dbFile = path.join(workDir, 'app.db');

/**
 * moj（司法部·立法意见征集）真实结构下的三条实抓条目 + 一条场景转发条目：
 * - 列表标题在真实页面里被截断，完整标题来自详情页 h1（断言用完整标题）；
 * - 机关来自标题前缀（真实详情页没有「发布机关：」行、面包屑是栏目名）；
 * - 截止日期只在正文句里（「征求意见时间为…至…」），列表层为空；
 * - 三条实抓条目的附件区都是空的（真实页面即如此，草案以正文链接形式给出）。
 */
const MOJ = {
  card: {
    title:
      '司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局关于《中华人民共和国金融法（草案）》公开征求意见的通知',
    detailPath: '/moj/pub/sfbgw/lfyjzj/lflfyjzj/202603/t20260320_532981.html',
    agency: '司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局',
    publishedAt: '2026-03-20',
    bodyMarker: 'jrfzqyj@moj.gov.cn',
  },
  gongzheng: {
    title:
      '司法部关于《中华人民共和国行政复议法实施条例（修订征求意见稿）》公开征求意见的通知',
    detailPath: '/moj/pub/sfbgw/lfyjzj/lflfyjzj/202508/t20250804_523412.html',
    agency: '司法部',
    publishedAt: '2025-08-04',
    bodyMarker: 'fyysjzhc',
  },
  noAttachment: {
    title: '司法部关于《行政法规制定程序条例（修订征求意见稿）》公开征求意见的通知',
    detailPath: '/moj/pub/sfbgw/lfyjzj/lflfyjzj/202506/t20250605_520514.html',
    agency: '司法部',
    publishedAt: '2025-06-05',
    bodyMarker: 'yjzqyj',
  },
};

const NPC = {
  first: { title: '企业破产法（修订草案二次审议稿）征求意见' },
  park: { title: '道路交通安全法（修订草案）征求意见' },
  fishery: { title: '检察公益诉讼法（草案二次审议稿）征求意见' },
};

/**
 * 第三源 = 生态环境部「意见征集」（issue #14 起替代已下线的中国政府网「意见征集」栏目）。
 * 三条实抓条目覆盖两套真实详情模板：
 * - hdjl（栏目内页 /hdjl/yjzj/zjyj/…shtml）：h2.neiright_Title + .xqLyPc + .neiright_JPZ_GK_CP，
 *   页面无「发布机关」字段 → 机关取列表层常量「生态环境部办公厅」（issue #21 起
 *   与该栏目 xxgk 模板的「发布机关」字段值一致，避免同一栏目出现两种机关名）；
 * - xxgk（政府信息公开页 /xxgk2018/…html）：h1 标题 + .content_top_box「发布机关」+
 *   .content_body_box 正文。
 * 两套模板的截止日期都写在正文句里，附件以相对 .pdf 链接出现在正文内。
 * shared = moj 列表转发行指向的同一条目（跨源去重场景）。
 */
const MEE = {
  hdjl: {
    title:
      '关于公开征求国家生态环境标准《生态环境影响评价技术导则 核动力厂（征求意见稿）》（修订HJ808-2016）意见的通知',
    detailPath: '/mee/hdjl/yjzj/zjyj/202609/t20260914_1166201.shtml',
    agency: '生态环境部办公厅',
    publishedAt: '2026-09-14',
    bodyMarker: 'hediansanchu@mee.gov.cn',
    attachments: ['《生态环境影响评价技术导则 核动力厂（征求意见稿）》（修订HJ808-2016)'],
  },
  xxgk: {
    title: '关于公开征求《沿海省（区、市）近岸海域重要物种名录》意见的函',
    detailPath: '/mee/xxgk2018/xxgk/xxgk06/202609/t20260911_1165826.html',
    agency: '生态环境部办公厅',
    publishedAt: '2026-09-11',
    bodyMarker: 'hysstzlc@mee.gov.cn',
    attachments: [
      '征求意见单位名单',
      '沿海省（区、市）近岸海域重要物种名录',
      '《沿海省（区、市）近岸海域重要物种名录》编制说明',
    ],
  },
  shared: {
    title:
      '关于公开征求《饮用水水源地基础信息数据元技术规范（征求意见稿）》等2项国家生态环境标准意见的通知',
    detailPath: '/mee/xxgk2018/xxgk/xxgk06/202609/t20260907_1165270.html',
    agency: '生态环境部办公厅',
    publishedAt: '2026-09-07',
    bodyMarker: 'jdzfyc@mee.gov.cn',
    attachments: [
      '饮用水水源地基础信息数据元技术规范（征求意见稿）',
      '《饮用水水源地基础信息数据元技术规范（征求意见稿）》编制说明',
      '集中式地表水饮用水水源保护区农业种植污染遥感调查技术规范（征求意见稿）',
      '《集中式地表水饮用水水源保护区农业种植污染遥感调查技术规范（征求意见稿）》编制说明',
    ],
  },
};

const SOURCE_NAME = {
  npc: '全国人大网·法律草案征求意见',
  moj: '司法部·立法意见征集',
  mee: '生态环境部·意见征集',
};

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程（与 npc-pipeline 场景同法：继承测试进程环境）。 */
function runWorkerOnce() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['worker/index.ts'], {
      cwd: repoRoot,
      env: { ...process.env, WORKER_ONCE: '1' },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 从列表页 HTML 按展示顺序提取条目（标题 + 详情链接）。 */
function extractListItems(html) {
  const anchors = [...html.matchAll(/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/g)];
  return anchors.map((match) => ({
    title: match[1].trim(),
    href: (match[0].match(/href="([^"]+)"/) ?? [])[1],
  }));
}

/** 从详情页 HTML 解析出条目 ID（/notices/<id> 的 <id>）。 */
function extractNoticeId(href) {
  const match = /\/notices\/([0-9a-f]+)$/.exec(href ?? '');
  assert.ok(match, `详情链接应形如 /notices/<id>，实际：${href}`);
  return match[1];
}

async function fetchDetailIdByTitle(title) {
  const listHtml = await (await fetch(`${app.url}/`)).text();
  const items = extractListItems(listHtml);
  const item = items.find((candidate) => candidate.title === title);
  assert.ok(item, `列表页应含条目「${title}」`);
  return extractNoticeId(item.href);
}

/**
 * 从 fixture 源站取已替换日期令牌的 moj 详情页，返回 { iso, days }：
 * 截止日期在正文句「征求意见时间为…至…」里（区间结束日）。
 */
async function fixtureMojDeadline(detailPath) {
  const html = await (await fetch(`${fixtureUrl}${detailPath}`)).text();
  const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const match = /(?:至|到)\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(bodyText);
  assert.ok(match, 'fixture moj 详情页正文应含已替换的截止日期');
  const [, y, m, d] = match;
  const pad = (value) => String(value).padStart(2, '0');
  return deadlineFromIso(`${y}-${pad(m)}-${pad(d)}`);
}

/**
 * 从 fixture 源站取已替换日期令牌的 mee 详情页，返回 { iso, days }：
 * 截止日期写在正文句里（「截止时间为…」/「请于…前…」），与适配器同口径。
 */
async function fixtureMeeDeadline(detailPath) {
  const html = await (await fetch(`${fixtureUrl}${detailPath}`)).text();
  const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const match =
    /截止(?:日期|时间)?(?:为|：|:)?\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(bodyText) ??
    /于\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*前/.exec(bodyText);
  assert.ok(match, 'fixture mee 详情页正文应含已替换的截止日期');
  const [, y, m, d] = match;
  const pad = (value) => String(value).padStart(2, '0');
  return deadlineFromIso(`${y}-${pad(m)}-${pad(d)}`);
}

function deadlineFromIso(iso) {
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const [y, m, d] = iso.split('-').map(Number);
  const days = Math.round((Date.UTC(y, m - 1, d) - todayUtc) / (24 * 60 * 60 * 1000));
  return { iso, days };
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      MAILER_OUTBOX_FILE: path.join(workDir, 'outbox.jsonl'),
      FIXTURES_DIR: fixturesDir,
      // 关键注入：全部源适配器的列表页指向本地 fixture 源站（SOURCES_FIXTURE_BASE）
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #5：源注册配置化与多源聚合', () => {
  it('moj 列表页的 WAF cookie 挑战：不带 cookie 被 302 挡回，抓取层带 cookie 重放后才拿到列表', async () => {
    // fixture 源站按真实司法部站点的行为，对 moj 列表请求模拟挑战
    // （源目录里的 waf-cookie-challenge 标记文件启用，见 fixture-server）
    const challenge = await fetch(`${fixtureUrl}/moj/list.html`, { redirect: 'manual' });
    assert.equal(challenge.status, 302, '未带 cookie 的列表请求应被挑战挡回');
    assert.ok(challenge.headers.get('set-cookie'), '挑战响应应下发 Set-Cookie');

    // 抓取层声明的 fetch.cookieChallenge 负责带 cookie 重放；
    // 该路径生效的直接证据：下面 worker 单轮里 moj 源成功入库（否则整源抓取失败）
    const withCookie = await fetch(`${fixtureUrl}/moj/list.html`, {
      headers: { cookie: challenge.headers.get('set-cookie').split(';')[0] },
    });
    assert.equal(withCookie.status, 200, '带挑战 cookie 重放应返回列表');
    assert.match(await withCookie.text(), /newsMsgList_zzy/, '返回的应是真实列表结构');
  });

  it('worker 单轮抓取：三源逐源入库，跨源重复 URL 命中更新而非重复插入', async () => {
    const first = await runWorkerOnce();
    assert.equal(first.code, 0, `worker 应正常退出，输出：${first.output}`);
    assert.match(first.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    // moj 列表含 4 条（第 4 条是转发条目，原文 URL 指向 mee 发布页，
    // 本轮首次入库，全部新增）
    assert.match(first.output, /源 moj 抓取完成：列表 4 条，新增 4，更新 0/);
    // mee 后抓：同一原文 URL 命中已入库条目 → 更新（去重证明）
    assert.match(first.output, /源 mee 抓取完成：列表 3 条，新增 2，更新 1/);
  });

  it('三源条目并存于列表页：各自机关、来源独立，互不串扰', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const items = extractListItems(html);
    assert.equal(items.length, 9, '三源共 9 条条目');

    // 每源条目恰好出现一次（含跨源转发条目：两源列表各出现一次，
    // 入库去重后聚合页只展示一条）
    const titlesOnce = [
      MOJ.card.title,
      MOJ.gongzheng.title,
      MOJ.noAttachment.title,
      MEE.shared.title,
      MEE.hdjl.title,
      NPC.first.title,
    ];
    for (const title of titlesOnce) {
      assert.equal(
        items.filter((item) => item.title === title).length,
        1,
        `条目「${title}」应恰好出现一次`,
      );
    }

    // 各源机关文本并存且不串扰（moj 机关来自标题前缀，真实详情页无「发布机关：」行）
    assert.match(
      html,
      /司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局 · 发布：2026-03-20 · 截止：\d{4}-\d{2}-\d{2}/,
    );
    assert.match(html, /司法部 · 发布：2025-08-04 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /司法部 · 发布：2025-06-05 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /生态环境部办公厅 · 发布：2026-09-14 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /生态环境部办公厅 · 发布：2026-09-11 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /全国人大常委会法制工作委员会/);
  });

  it('三源条目全局排序：征求意见中按截止日期升序，跨源不串扰排序', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const items = extractListItems(html);
    // 全局按截止日期升序（即将截止在前），已截止条目沉底；
    // 三个源的条目按各自截止日期交错排布，证明排序只看数据不看来源
    assert.deepEqual(
      items.map((item) => item.title),
      [
        MEE.shared.title, // {{CN_DATE+12}}（跨源去重条目：moj 转发行 / mee 列表同一 URL）
        MEE.xxgk.title, // {{CN_DATE+18}}（近岸海域重要物种名录）
        NPC.first.title, // {{DATE+21}}（企业破产法）
        MOJ.gongzheng.title, // {{CN_DATE+22}}（行政复议法实施条例）
        MEE.hdjl.title, // {{CN_DATE+26}}（核动力厂导则）
        MOJ.card.title, // {{DATE+30}}（金融法）
        MOJ.noAttachment.title, // {{DATE+44}}（行政法规制定程序条例）
        NPC.park.title, // {{DATE+45}}（道路交通安全法）
        NPC.fishery.title, // 已截止（真实历史截止日 2026-07-25），沉底
      ],
    );

    const badges = [...html.matchAll(/<span[^>]*notice-status-badge[^>]*>([^<]+)<\/span>/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(badges, [
      '征求意见中',
      '征求意见中',
      '征求意见中',
      '征求意见中',
      '征求意见中',
      '征求意见中',
      '征求意见中',
      '征求意见中',
      '已截止',
    ]);
  });

  it('跨源去重条目详情页：同一原文 URL 只有一条，字段由后抓取源补全', async () => {
    const noticeId = await fetchDetailIdByTitle(MEE.shared.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MEE.shared.title));
    // 条目由 moj 列表首次入库（sourceId 保留 moj），字段随后被 mee 详情解析覆盖补全
    assert.match(html, /发布机关[\s\S]{0,40}生态环境部办公厅/, '机关来自 mee 详情「发布机关」字段');
    assert.match(html, new RegExp(SOURCE_NAME.moj), '来源 = 首个收录渠道 moj');
    assert.match(html, /2026-09-07/, '发布日期（mee 列表 span.date）');

    const { iso, days } = await fixtureMeeDeadline(MEE.shared.detailPath);
    assert.match(
      html,
      new RegExp(`截止日期[\\s\\S]{0,40}${iso}`),
      '截止日期来自 mee 详情正文句（moj 列表转发行无截止日期）',
    );
    assert.match(html, new RegExp(`剩 ${days} 天`));

    assert.match(html, new RegExp(MEE.shared.bodyMarker), '正文来自 mee 详情页');
    for (const name of MEE.shared.attachments) {
      assert.match(html, new RegExp(name.replace(/[().]/g, '\\$&')), `附件：${name}`);
    }

    // 官方原文 = mee 发布页快照地址（即两个源列表里共同的原文 URL）
    const officialUrl = `${fixtureUrl}${MEE.shared.detailPath}`;
    assert.ok(html.includes(`href="${officialUrl}"`), '官方原文链接 = mee 发布页地址');
    const go = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), officialUrl);
  });

  it('moj 联合发布条目详情页：标题前缀机关、正文句中的截止日期与正文（无附件区）', async () => {
    const noticeId = await fetchDetailIdByTitle(MOJ.card.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MOJ.card.title));
    assert.match(
      html,
      /发布机关[\s\S]{0,60}司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局/,
      '机关 = 标题前缀（真实详情页无「发布机关：」行）',
    );
    assert.match(html, new RegExp(SOURCE_NAME.moj), '应展示来源（源适配器名称）');
    assert.match(html, /2026-03-20/, '发布日期');

    const { iso, days } = await fixtureMojDeadline(MOJ.card.detailPath);
    assert.match(html, new RegExp(`截止日期[\\s\\S]{0,40}${iso}`), `截止日期应为 fixture 令牌值 ${iso}`);
    assert.match(html, new RegExp(`剩 ${days} 天`), '倒计时按日历日一致');

    assert.match(html, new RegExp(MOJ.card.bodyMarker), '正文纯文本');
    // 真实 moj 通知的附件区为空（草案以正文链接形式给出），不渲染附件清单
    assert.ok(!html.includes('附件清单'), '无附件条目不应渲染附件清单区');

    const officialUrl = `${fixtureUrl}${MOJ.card.detailPath}`;
    assert.ok(html.includes(`href="${officialUrl}"`), '官方原文链接 = fixture 快照地址');

    // /go/<id> 302 到官方原文
    const go = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), officialUrl);
  });

  it('moj 单机关条目详情页：机关取标题前缀「司法部」，无附件区，其余字段完整', async () => {
    const noticeId = await fetchDetailIdByTitle(MOJ.noAttachment.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MOJ.noAttachment.title));
    assert.match(html, /发布机关[\s\S]{0,40}司法部/);
    assert.match(html, new RegExp(MOJ.noAttachment.bodyMarker), '正文纯文本');
    assert.ok(!html.includes('附件清单'), '无附件条目不应渲染附件清单区');

    const { iso } = await fixtureMojDeadline(MOJ.noAttachment.detailPath);
    assert.ok(html.includes(iso), `截止日期应为 fixture 令牌值 ${iso}`);
  });

  it('mee 栏目内页（hdjl 模板）：标题取 h2、机关取列表常量、正文句中的截止日期与附件', async () => {
    const noticeId = await fetchDetailIdByTitle(MEE.hdjl.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MEE.hdjl.title));
    assert.match(
      html,
      /发布机关[\s\S]{0,40}生态环境部/,
      'hdjl 模板无「发布机关」字段 → 机关取列表层常量',
    );
    assert.match(html, new RegExp(SOURCE_NAME.mee), '应展示来源（源适配器名称）');
    assert.match(html, /2026-09-14/, '发布日期（列表 span.date）');

    const { iso, days } = await fixtureMeeDeadline(MEE.hdjl.detailPath);
    assert.match(html, new RegExp(`截止日期[\\s\\S]{0,40}${iso}`), `截止日期应为 fixture 令牌值 ${iso}`);
    assert.match(html, new RegExp(`剩 ${days} 天`), '倒计时按日历日一致');

    assert.match(html, new RegExp(MEE.hdjl.bodyMarker), '正文纯文本');
    for (const name of MEE.hdjl.attachments) {
      assert.match(html, new RegExp(name.replace(/[().]/g, '\\$&')), `附件：${name}`);
    }

    const officialUrl = `${fixtureUrl}${MEE.hdjl.detailPath}`;
    assert.ok(html.includes(`href="${officialUrl}"`), '官方原文链接 = fixture 快照地址');
    const go = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), officialUrl);
  });

  it('mee 政府信息公开页（xxgk 模板）：h1 标题、发布机关字段、正文与多附件', async () => {
    const noticeId = await fetchDetailIdByTitle(MEE.xxgk.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MEE.xxgk.title));
    assert.match(html, /发布机关[\s\S]{0,40}生态环境部办公厅/, '机关 = 「发布机关」字段');
    assert.match(html, new RegExp(MEE.xxgk.bodyMarker), '正文纯文本');
    for (const name of MEE.xxgk.attachments) {
      assert.match(html, new RegExp(name.replace(/[().]/g, '\\$&')), `附件：${name}`);
    }
    const { iso } = await fixtureMeeDeadline(MEE.xxgk.detailPath);
    assert.match(html, new RegExp(`截止日期[\\s\\S]{0,40}${iso}`));
  });

  it('重复抓取幂等：三源条目数不变，跨源去重条目不重复', async () => {
    const second = await runWorkerOnce();
    assert.equal(second.code, 0, `worker 应正常退出，输出：${second.output}`);
    assert.match(second.output, /源 npc 抓取完成：列表 3 条，新增 0，更新 3/);
    assert.match(second.output, /源 moj 抓取完成：列表 4 条，新增 0，更新 4/);
    assert.match(second.output, /源 mee 抓取完成：列表 3 条，新增 0，更新 3/);

    const html = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const items = extractListItems(html);
    assert.equal(items.length, 9, '重复抓取不应产生重复条目');
    assert.equal(
      items.filter((item) => item.title === MEE.shared.title).length,
      1,
      '跨源去重条目仍只展示一条',
    );
  });
});
