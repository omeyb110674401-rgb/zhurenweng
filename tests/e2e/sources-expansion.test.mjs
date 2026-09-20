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
 * E2E（issue #18）：M2 扩源 —— 交通运输部 / 市场监管总局 / 工业和信息化部 / 教育部。
 *
 * 四个源各代表一类真实的接入形态，本场景逐类锁定行为：
 * - **市场监管总局**：列表是站内 TRS jpaas 接口（JSON 片段），列表自带「征集期」
 *   （起 至 止）与状态列 —— 截止日期取自列表，详情正文多数没有截止句；
 * - **工业和信息化部**：同为接口列表，截止日期藏在隐藏字段 `span.endtime`
 *   （毫秒时间戳），详情正文的「请于…前反馈意见」与它互为印证；
 * - **交通运输部**：静态 HTML 列表，状态标注 `[进行中]/[已结束]` 是真实列表判据，
 *   条目链接跨域混排（民航局站点）；
 * - **教育部**：静态 HTML 列表，标题必须取 `title` 属性（链接文本被截断），
 *   栏目自 2024-02 起是历史归档（全部已截止）。
 *
 * 本场景另锁定两条**状态推导次序**（issue #18 引入 NormalizedNotice.status）：
 * ① 截止日期优先于源标注 —— 合成条目标注 [进行中] 但详情截止日期已过 → 已截止；
 * ② 截止日期解析不到时用源标注 —— 跨域条目详情页是别的站点模板，解析不到正文与
 *    截止日期，状态退回 [进行中]（否则会被误判成「已截止」或「无截止日期即进行中」）。
 *
 * fixture 根目录是 fixtures/e2e-sources/（只含这四个源；M1 三源在 fixture 源站上
 * 404，属预期 —— 本场景只断言这四个源）。
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue18-'));
const dbFile = path.join(workDir, 'app.db');

/** 条目标题（真实站点标题，快照未改写）。 */
const TITLES = {
  samrOpen: '市场监管总局关于公开征求《关于出口转内销产品强制性产品认证便利化试点的通知（征求意见稿）》意见的通知',
  samrOpen2: '市场监管总局关于公开征求《国家标准外文版管理办法（征求意见稿）》意见的通知',
  samrOpen3: '市场监管总局特种设备局关于《电梯安全技术规程（征求意见稿）》再次公开征求意见的公告',
  samrClosed: '市场监管总局关于公开征求《网络交易小程序平台合规指引（征求意见稿）》意见的公告',
  samrClosed2: '市场监管总局关于公开征求《国际单位制及其应用（征求意见稿）》意见的公告',
  miitOpen: '公开征求《氢能装备（碱性水电解制氢装备）制造行业规范条件（2026年本）（征求意见稿）》的意见',
  miitOpen2: '公开征求对《中华人民共和国无线电频率划分规定（征求意见稿）》的意见',
  miitOpen3: '关于公开征求《面向车联网应用的算力网络安全指南》等89项通信行业标准报批意见的公示',
  miitClosed: '关于公开征求《饲料加工机械卫生规范》等14项强制性国家标准制修订计划项目意见的公示',
  motOpen: '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知',
  motClosed: '交通运输部关于《公路建设项目可行性研究报告编制办法（征求意见稿）》公开征求意见的通知',
  motClosed2:
    '交通运输部关于公开征求《关于修改〈中华人民共和国船舶油污损害民事责任保险实施办法〉的决定（征求意见稿）》 意见的通知',
  motCrossDomain: '中国民航局关于《运输机场运营许可规定（征求意见稿）》公开征求意见的通知',
  motConflict: '关于《公路水运工程安全生产监督管理办法（修订征求意见稿）》公开征求意见的通知',
  moeClosed: '教育部关于《校外培训管理条例（征求意见稿）》公开征求意见的公告',
  moeJoint: '人力资源社会保障部办公厅 教育部办公厅关于《关于深化高等学校教师职称制度改革的指导意见（征求意见稿）》公开征求意见的通知',
  moeClosed2: '教育部关于《中华人民共和国教师法（修订草案）（征求意见稿）》公开征求意见的公告',
};

/** 全部入库条目（17 条：samr 5 + miit 4 + mot 5 + moe 3）。 */
const ALL_TITLES = Object.values(TITLES);

/** 未入库条目：交通运输部栏目里混入的非征求意见条目（状态位为空，适配器据此过滤）。 */
const FILTERED_TITLES = [
  '交通运输部相关司局负责人就公路法修正草案征求意见稿答记者问',
  '关于《交通运输重大项目后评价管理办法（征求意见稿）》公开征求意见反馈情况',
];

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程（继承 process.env，含 startAppServer 注入的 fixture 源站）。 */
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

/** React SSR 在「文本 + 表达式」混排处插入 <!-- --> 注释，文本断言前剥掉。 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 按 <li class="notice-item"> 分块提取列表条目（标题 / 状态徽标 / 倒计时）。 */
function extractItemBlocks(html) {
  return html
    .split(/<li class="notice-item"/)
    .slice(1)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .map((block) => ({
      title: (/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/.exec(block) ?? [])[1] ?? '',
      href: (/href="(\/notices\/[0-9a-f]+)"/.exec(block) ?? [])[1] ?? '',
      badge: (/<span[^>]*notice-status-badge[^>]*>([^<]+)<\/span>/.exec(block) ?? [])[1] ?? null,
      countdown: (/<span[^>]*notice-countdown[^>]*>([^<]+)<\/span>/.exec(block) ?? [])[1] ?? null,
    }));
}

/** 取指定标题的列表块。 */
function blockOf(blocks, title) {
  const block = blocks.find((candidate) => candidate.title === title);
  assert.ok(block, `列表页应含条目「${title}」`);
  return block;
}

/** 距今天数（本地日历日），与 countdownText 的口径一致。 */
function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const now = new Date();
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - todayUtc) / (24 * 60 * 60 * 1000));
}

/** 从 fixture 源站取已替换令牌的列表快照。 */
async function fetchFixture(relativePath) {
  const response = await fetch(`${fixtureUrl}/${relativePath}`);
  assert.equal(response.status, 200, `fixture 应提供 ${relativePath}`);
  return response.text();
}

/**
 * 取快照里**指定条目所在行**的日期（不能用第一个匹配 —— 一行一个日期，
 * 取错行会把上一条的日期当成断言基准）。定位方式：先找到标题，再在其后找日期。
 */
function deadlineAfter(listText, title, pattern) {
  const at = listText.indexOf(title);
  assert.ok(at >= 0, `快照应含条目「${title}」`);
  const match = pattern.exec(listText.slice(at));
  assert.ok(match, `「${title}」所在行应含日期`);
  return match;
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
      SOURCES_FIXTURE_BASE: fixtureUrl,
      SITE_URL: 'https://zw.test',
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #18：M2 扩源（交通运输部 / 市场监管总局 / 工业和信息化部 / 教育部）', () => {
  it('worker 单轮抓取：四个新源各自按自己的列表形态入库', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 samr 抓取完成：列表 5 条，新增 5，更新 0/);
    assert.match(run.output, /源 miit 抓取完成：列表 4 条，新增 4，更新 0/);
    // mot 列表 6 行 → 过滤掉 1 条非征求意见条目（答记者问 / 反馈情况）后入库 5 条
    assert.match(run.output, /源 mot 抓取完成：列表 5 条，新增 5，更新 0/);
    assert.match(run.output, /源 moe 抓取完成：列表 3 条，新增 3，更新 0/);
  });

  it('首页：17 条新源条目全部呈现，非征求意见条目被过滤', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const blocks = extractItemBlocks(html);
    assert.equal(blocks.length, ALL_TITLES.length, `首页应恰好 ${ALL_TITLES.length} 条`);
    for (const title of ALL_TITLES) {
      const hits = blocks.filter((block) => block.title === title);
      assert.equal(hits.length, 1, `「${title}」应恰好出现一次`);
    }
    const visible = stripSsrComments(html);
    for (const title of FILTERED_TITLES) {
      assert.ok(!visible.includes(title), `「${title}」不是征求意见条目，不应入库`);
    }
  });

  it('截止日期来源：samr 取列表「征集期」结束日，miit 取隐藏字段 endtime 时间戳', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const blocks = extractItemBlocks(html);

    // samr：征集期「{{DATE-3}}至{{DATE+27}}」的结束日
    // （快照是 JSON，HTML 里的引号在 JSON 字符串中被转义，故正则不写引号）
    const samrList = await fetchFixture('samr/list.json');
    const samrPeriod = deadlineAfter(
      samrList,
      TITLES.samrOpen,
      /doctime[^>]*>(\d{4}-\d{2}-\d{2})至(\d{4}-\d{2}-\d{2})/,
    );
    assert.equal(
      blockOf(blocks, TITLES.samrOpen).countdown,
      `剩 ${daysUntil(samrPeriod[2])} 天`,
      'samr 截止日期取列表征集期的结束日',
    );

    // miit：endtime 毫秒时间戳 → 日期
    const miitList = await fetchFixture('miit/list.json');
    const miitEpoch = Number(deadlineAfter(miitList, TITLES.miitOpen2, /endtime[^>]*>(\d+)</)[1]);
    assert.ok(Number.isFinite(miitEpoch), 'miit 快照应含 endtime 时间戳');
    const miitEnd = new Date(miitEpoch).toISOString().slice(0, 10);
    assert.equal(
      blockOf(blocks, TITLES.miitOpen2).countdown,
      `剩 ${daysUntil(miitEnd)} 天`,
      'miit 截止日期取隐藏字段 endtime 时间戳',
    );

    // 徽标：进行中 / 已截止（samr 两条已结束、miit 一条已过期）
    assert.equal(blockOf(blocks, TITLES.samrOpen).badge, '征求意见中');
    assert.equal(blockOf(blocks, TITLES.samrClosed).badge, '已截止');
    assert.equal(blockOf(blocks, TITLES.samrClosed2).badge, '已截止');
    assert.equal(blockOf(blocks, TITLES.miitClosed).badge, '已截止');
    assert.equal(blockOf(blocks, TITLES.miitOpen3).badge, '征求意见中');
  });

  it('状态推导①：截止日期优先于源标注（标注进行中但详情截止日期已过 → 已截止）', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const block = blockOf(extractItemBlocks(html), TITLES.motConflict);
    // 列表标注 [进行中]，详情正文「意见反馈截止日期为{{CN_DATE-3}}」已过 → 以日期为准
    assert.equal(block.badge, '已截止', '截止日期早于今天时，即使源标注进行中也判已截止');
    assert.equal(block.countdown, null);
  });

  it('状态推导②：跨域条目详情不可解析时保留源标注（中国民航局条目）', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const block = blockOf(extractItemBlocks(html), TITLES.motCrossDomain);
    assert.equal(block.badge, '征求意见中', '跨域详情解析不到截止日期时应退回列表的 [进行中] 标注');
    assert.equal(block.countdown, null, '没有截止日期就不展示倒计时');
    // 机关取自标题前缀（跨域条目的主办机关是民航局，不是交通运输部）
    assert.match(stripSsrComments(html), /中国民航局/);
  });

  it('教育部源：历史归档条目全部已截止，联合发布机关取完整标题前缀', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const blocks = extractItemBlocks(html);
    for (const title of [TITLES.moeClosed, TITLES.moeJoint, TITLES.moeClosed2]) {
      assert.equal(blockOf(blocks, title).badge, '已截止');
    }
    // 联合发布：链接文本被截断，机关取 title 属性的完整前缀
    const detail = await fetch(`${app.url}${blockOf(blocks, TITLES.moeJoint).href}`).then((response) =>
      response.text(),
    );
    assert.match(stripSsrComments(detail), /人力资源社会保障部办公厅 教育部办公厅/);
  });

  it('详情页：正文、附件与官方原文链接（三源各自形态）', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const blocks = extractItemBlocks(html);

    // samr：正文取自 .Three_xilan_07，附件在正文之外的「附件下载」清单
    const samrDetail = await fetch(`${app.url}${blockOf(blocks, TITLES.samrOpen).href}`).then(
      (response) => response.text(),
    );
    const samrText = stripSsrComments(samrDetail);
    assert.match(samrText, /公众可通过以下途径和方式提出反馈意见/);
    assert.match(samrText, /附件1：关于出口转内销产品强制性产品认证便利化试点的通知/);
    assert.match(samrText, /href="[^"]+\.pdf\?fileName=/, '附件链接保留 fileName 查询参数');
    assert.match(samrText, /官方原文/);

    // miit：正文取自 #con_con，附件是正文内的 pdf 链接
    const miitDetail = await fetch(`${app.url}${blockOf(blocks, TITLES.miitOpen2).href}`).then(
      (response) => response.text(),
    );
    const miitText = stripSsrComments(miitDetail);
    assert.match(miitText, /我局修订了《中华人民共和国无线电频率划分规定》/);
    assert.match(miitText, /《中华人民共和国无线电频率划分规定（征求意见稿）》修订部分\.pdf/);

    // mot：正文取自 #article-content，附件含 .docx / .wps
    const motDetail = await fetch(`${app.url}${blockOf(blocks, TITLES.motOpen).href}`).then(
      (response) => response.text(),
    );
    const motText = stripSsrComments(motDetail);
    assert.match(motText, /登录交通运输部政府网站/);
    assert.match(motText, /中华人民共和国公路法（修正草案征求意见稿）\.docx/);
    assert.match(motText, /起草说明\.wps/);

    // moe：正文取自 .moe-detail-box .TRS_Editor
    const moeDetail = await fetch(`${app.url}${blockOf(blocks, TITLES.moeClosed).href}`).then(
      (response) => response.text(),
    );
    assert.match(stripSsrComments(moeDetail), /本次征求意见截止日期为2024年3月8日/);
  });

  it('检索：新源条目可按正文关键词命中（入库时已同步索引）', async () => {
    const response = await fetch(
      `${app.url}/search?q=${encodeURIComponent('无线电频率划分规定')}`,
    );
    assert.equal(response.status, 200);
    const html = stripSsrComments(await response.text());
    assert.match(html, /公开征求对《中华人民共和国无线电频率划分规定（征求意见稿）》的意见/);

    // 仅出现在 samr 正文里的词（其余源不含）
    const samrOnly = await fetch(`${app.url}/search?q=${encodeURIComponent('出口转内销产品')}`);
    assert.match(stripSsrComments(await samrOnly.text()), /关于出口转内销产品强制性产品认证便利化试点的通知/);
  });
});
