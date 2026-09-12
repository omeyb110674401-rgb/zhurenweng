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
 * - govcn（中国政府网「意见征集」栏目）：列表带发布机关列、详情含
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

const MOJ = {
  card: {
    title: '司法部关于《中华人民共和国人民调解法（修订草案）》征求意见的通知',
    detailPath: '/moj/pub/sfbgw/zqyj/t20260908_523110.html',
    agency: '司法部立法一局',
    publishedAt: '2026-09-08',
    bodyMarker: 'rmtjf@moj.gov.cn',
    attachments: [
      '中华人民共和国人民调解法（修订草案）.docx',
      '关于《中华人民共和国人民调解法（修订草案）》的说明.pdf',
    ],
  },
  gongzheng: {
    title: '司法部关于《中华人民共和国公证法（修订草案）》公开征求意见的通知',
    detailPath: '/moj/pub/sfbgw/zqyj/t20260903_523105.html',
    agency: '司法部立法三局',
    publishedAt: '2026-09-03',
    bodyMarker: 'gzf@moj.gov.cn',
  },
  noAttachment: {
    title: '司法部关于《中华人民共和国历史文化遗产保护法（草案征求意见稿）》公开征求意见的通知',
    detailPath: '/moj/pub/sfbgw/zqyj/t20260901_523101.html',
    agency: '司法部',
    publishedAt: '2026-09-01',
    bodyMarker: 'lswhyc@moj.gov.cn',
  },
};

const NPC = {
  first: { title: '中华人民共和国医疗保障法（草案征求意见稿）征求意见' },
  park: { title: '中华人民共和国国家公园法（草案二次审议稿）征求意见' },
  fishery: { title: '中华人民共和国渔业法（修订草案）征求意见' },
};

const GOVCN = {
  shared: {
    title: '司法部关于《中华人民共和国仲裁法（修订草案）》公开征求意见的通知',
    detailPath: '/govcn/zhengce/yjzj/202609/content_6923101.html',
    agency: '司法部',
    publishedAt: '2026-09-02',
    bodyMarker: 'zcf@moj.gov.cn',
    attachments: [
      '中华人民共和国仲裁法（修订草案）.docx',
      '关于《中华人民共和国仲裁法（修订草案）》的起草说明.pdf',
    ],
  },
  multiDept: {
    title: '国家发展改革委关于《中华人民共和国社会信用体系建设法（草案征求意见稿）》公开征求意见的通知',
    detailPath: '/govcn/zhengce/yjzj/202609/content_6923112.html',
    agency: '国家发展改革委',
    bodyMarker: 'xyjstx@ndrc.gov.cn',
    attachments: ['中华人民共和国社会信用体系建设法（草案征求意见稿）.pdf'],
  },
  native: {
    title: '国家铁路局关于《铁路交通事故应急救援和调查处理条例（修订草案征求意见稿）》公开征求意见的通知',
    detailPath: '/govcn/zhengce/yjzj/202609/content_6923118.html',
    agency: '国家铁路局',
    publishedAt: '2026-09-10',
    bodyMarker: 'tljfgc@nra.gov.cn',
    attachments: ['铁路交通事故应急救援和调查处理条例（修订草案征求意见稿）.pdf'],
  },
};

const SOURCE_NAME = {
  npc: '全国人大网·法律草案征求意见',
  moj: '司法部·立法意见征集',
  govcn: '中国政府网·意见征集',
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
 * 截止日期的 ISO 文本与距今天的日历天数。
 */
async function fixtureMojDeadline(detailPath) {
  const html = await (await fetch(`${fixtureUrl}${detailPath}`)).text();
  const match = /征求意见截止时间：<b>(\d{4}-\d{2}-\d{2})<\/b>/.exec(html);
  assert.ok(match, 'fixture moj 详情页应含已替换的 ISO 截止日期');
  return deadlineFromIso(match[1]);
}

/**
 * 从 fixture 源站取已替换日期令牌的 govcn 详情页，返回 { iso, days }：
 * 截止日期框的中文日期距今天的日历天数与对应 ISO 文本。
 */
async function fixtureGovcnDeadline(detailPath) {
  const html = await (await fetch(`${fixtureUrl}${detailPath}`)).text();
  const match =
    /<div class="deadline-value">(\d{4})年(\d{1,2})月(\d{1,2})日<\/div>/.exec(html);
  assert.ok(match, 'fixture govcn 详情页应含已替换的截止日期框日期');
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
  it('worker 单轮抓取：三源逐源入库，跨源重复 URL 命中更新而非重复插入', async () => {
    const first = await runWorkerOnce();
    assert.equal(first.code, 0, `worker 应正常退出，输出：${first.output}`);
    assert.match(first.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    // moj 列表含 4 条（其中《仲裁法》转发条目的原文 URL 指向 govcn 发布页，
    // 本轮首次入库，全部新增）
    assert.match(first.output, /源 moj 抓取完成：列表 4 条，新增 4，更新 0/);
    // govcn 后抓：同一《仲裁法》原文 URL 命中已入库条目 → 更新（去重证明）
    assert.match(first.output, /源 govcn 抓取完成：列表 3 条，新增 2，更新 1/);
  });

  it('三源条目并存于列表页：各自机关、来源独立，互不串扰', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const items = extractListItems(html);
    assert.equal(items.length, 9, '三源共 9 条条目');

    // 每源条目恰好出现一次（含跨源转发的《仲裁法》：两源列表各出现一次，
    // 入库去重后聚合页只展示一条）
    const titlesOnce = [
      MOJ.card.title,
      MOJ.gongzheng.title,
      MOJ.noAttachment.title,
      GOVCN.shared.title,
      GOVCN.native.title,
      NPC.first.title,
    ];
    for (const title of titlesOnce) {
      assert.equal(
        items.filter((item) => item.title === title).length,
        1,
        `条目「${title}」应恰好出现一次`,
      );
    }

    // 各源机关文本并存且不串扰
    assert.match(html, /司法部立法一局 · 发布：2026-09-08 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /司法部立法三局 · 发布：2026-09-03 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /司法部 · 发布：2026-09-01 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /国家发展改革委 · 发布：2026-09-05 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /国家铁路局 · 发布：2026-09-10 · 截止：\d{4}-\d{2}-\d{2}/);
    assert.match(html, /全国人民代表大会常务委员会法制工作委员会/);
  });

  it('三源条目全局排序：征求意见中按截止日期升序，跨源不串扰排序', async () => {
    const html = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const items = extractListItems(html);
    // 全局按截止日期升序（即将截止在前），已截止条目沉底；
    // 三个源的条目按各自截止日期交错排布，证明排序只看数据不看来源
    assert.deepEqual(
      items.map((item) => item.title),
      [
        GOVCN.native.title, // {{CN_DATE+12}}
        GOVCN.shared.title, // {{CN_DATE+18}}（跨源去重条目）
        NPC.first.title, // {{CN_DATE+21}}
        MOJ.gongzheng.title, // {{CN_DATE+22}}
        GOVCN.multiDept.title, // {{CN_DATE+26}}
        MOJ.card.title, // {{DATE+30}}
        MOJ.noAttachment.title, // {{DATE+44}}
        NPC.park.title, // {{CN_DATE+45}}
        NPC.fishery.title, // {{CN_DATE-10}} 已截止，沉底
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
    const noticeId = await fetchDetailIdByTitle(GOVCN.shared.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(GOVCN.shared.title));
    // 条目由 moj 列表首次入库（sourceId 保留 moj），字段随后被 govcn 详情解析覆盖补全
    assert.match(html, /发布机关[\s\S]{0,40}司法部/, '机关来自 govcn 关联部门框');
    assert.match(html, new RegExp(SOURCE_NAME.moj), '来源 = 首个收录渠道 moj');
    assert.match(html, /2026-09-02/, '发布日期');

    const { iso, days } = await fixtureGovcnDeadline(GOVCN.shared.detailPath);
    assert.match(
      html,
      new RegExp(`截止日期[\\s\\S]{0,40}${iso}`),
      '截止日期来自 govcn 截止日期框（moj 列表转发行无截止日期）',
    );
    assert.match(html, new RegExp(`剩 ${days} 天`));

    assert.match(html, new RegExp(GOVCN.shared.bodyMarker), '正文来自 govcn 详情页');
    for (const name of GOVCN.shared.attachments) {
      assert.match(html, new RegExp(name.replace(/[().]/g, '\\$&')), `附件：${name}`);
    }

    // 官方原文 = govcn 发布页快照地址（即两个源列表里共同的原文 URL）
    const officialUrl = `${fixtureUrl}${GOVCN.shared.detailPath}`;
    assert.ok(html.includes(`href="${officialUrl}"`), '官方原文链接 = govcn 发布页地址');
    const go = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), officialUrl);
  });

  it('moj 卡片置顶条目详情页：面包屑机关、截止提示条日期、正文与文末附件区', async () => {
    const noticeId = await fetchDetailIdByTitle(MOJ.card.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MOJ.card.title));
    assert.match(html, /发布机关[\s\S]{0,40}司法部立法一局/, '机关 = 面包屑最后一级');
    assert.match(html, new RegExp(SOURCE_NAME.moj), '应展示来源（源适配器名称）');
    assert.match(html, /2026-09-08/, '发布日期');

    const { iso, days } = await fixtureMojDeadline(MOJ.card.detailPath);
    assert.match(html, new RegExp(`截止日期[\\s\\S]{0,40}${iso}`), `截止日期应为 fixture 令牌值 ${iso}`);
    assert.match(html, new RegExp(`剩 ${days} 天`), '倒计时按日历日一致');

    assert.match(html, new RegExp(MOJ.card.bodyMarker), '正文纯文本');
    for (const name of MOJ.card.attachments) {
      assert.match(html, new RegExp(name.replace(/[().]/g, '\\$&')), `附件：${name}`);
    }

    const officialUrl = `${fixtureUrl}${MOJ.card.detailPath}`;
    assert.ok(html.includes(`href="${officialUrl}"`), '官方原文链接 = fixture 快照地址');

    // /go/<id> 302 到官方原文
    const go = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), officialUrl);
  });

  it('moj 无附件条目详情页：附件区不渲染，其余字段完整', async () => {
    const noticeId = await fetchDetailIdByTitle(MOJ.noAttachment.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(MOJ.noAttachment.title));
    assert.match(html, /发布机关[\s\S]{0,40}司法部/);
    assert.match(html, new RegExp(MOJ.noAttachment.bodyMarker), '正文纯文本');
    assert.ok(!html.includes('附件清单'), '无附件条目不应渲染附件清单区');

    const { iso } = await fixtureMojDeadline(MOJ.noAttachment.detailPath);
    assert.ok(html.includes(iso), `截止日期应为 fixture 令牌值 ${iso}`);
  });

  it('govcn 详情页：关联部门框、截止日期框、列表机关列与附件清单', async () => {
    const noticeId = await fetchDetailIdByTitle(GOVCN.native.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, new RegExp(GOVCN.native.title));
    assert.match(html, /发布机关[\s\S]{0,40}国家铁路局/, '机关 = 关联部门框牵头部门');
    assert.match(html, new RegExp(SOURCE_NAME.govcn), '应展示来源（源适配器名称）');
    assert.match(html, /2026-09-10/, '发布日期');

    const { iso, days } = await fixtureGovcnDeadline(GOVCN.native.detailPath);
    assert.match(html, new RegExp(`截止日期[\\s\\S]{0,40}${iso}`), `截止日期应为 fixture 令牌值 ${iso}`);
    assert.match(html, new RegExp(`剩 ${days} 天`), '倒计时按日历日一致');

    assert.match(html, new RegExp(GOVCN.native.bodyMarker), '正文纯文本');
    for (const name of GOVCN.native.attachments) {
      assert.match(html, new RegExp(name.replace(/[().]/g, '\\$&')), `附件：${name}`);
    }

    const officialUrl = `${fixtureUrl}${GOVCN.native.detailPath}`;
    assert.ok(html.includes(`href="${officialUrl}"`), '官方原文链接 = fixture 快照地址');
    const go = await fetch(`${app.url}/go/${noticeId}`, { redirect: 'manual' });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get('location'), officialUrl);
  });

  it('govcn 多部门联合征求意见：关联部门框首个为牵头部门', async () => {
    const noticeId = await fetchDetailIdByTitle(GOVCN.multiDept.title);
    const html = await (await fetch(`${app.url}/notices/${noticeId}`)).text();

    assert.match(html, /发布机关[\s\S]{0,40}国家发展改革委/, '牵头部门为国家发展改革委');
    assert.match(html, new RegExp(GOVCN.multiDept.bodyMarker), '正文纯文本');
    const { iso } = await fixtureGovcnDeadline(GOVCN.multiDept.detailPath);
    assert.match(html, new RegExp(`截止日期[\\s\\S]{0,40}${iso}`));
  });

  it('重复抓取幂等：三源条目数不变，跨源去重条目不重复', async () => {
    const second = await runWorkerOnce();
    assert.equal(second.code, 0, `worker 应正常退出，输出：${second.output}`);
    assert.match(second.output, /源 npc 抓取完成：列表 3 条，新增 0，更新 3/);
    assert.match(second.output, /源 moj 抓取完成：列表 4 条，新增 0，更新 4/);
    assert.match(second.output, /源 govcn 抓取完成：列表 3 条，新增 0，更新 3/);

    const html = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const items = extractListItems(html);
    assert.equal(items.length, 9, '重复抓取不应产生重复条目');
    assert.equal(
      items.filter((item) => item.title === GOVCN.shared.title).length,
      1,
      '跨源去重条目仍只展示一条',
    );
  });
});
