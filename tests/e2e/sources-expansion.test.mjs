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
 * E2E（issue #18 / #20）：M2 扩源 —— 交通运输部 / 市场监管总局 / 工业和信息化部 /
 * 教育部 / 国家发展改革委（源 3 → 8）。
 *
 * 五个源各代表一类真实的接入形态，本场景逐类锁定行为：
 * - **市场监管总局**：列表是站内 TRS jpaas 接口（JSON 片段），列表自带「征集期」
 *   （起 至 止）与状态列 —— 截止日期取自列表，详情正文多数没有截止句；
 * - **工业和信息化部**：同为接口列表，截止日期藏在隐藏字段 `span.endtime`
 *   （毫秒时间戳），详情正文的「请于…前反馈意见」与它互为印证；
 * - **交通运输部**：静态 HTML 列表，状态标注 `[进行中]/[已结束]` 是真实列表判据，
 *   条目链接跨域混排（民航局站点）；
 * - **教育部**：静态 HTML 列表，标题必须取 `title` 属性（链接文本被截断），
 *   栏目自 2024-02 起是历史归档（全部已截止）；
 * - **国家发展改革委**（issue #20）：**链式跳转源** —— 正文要经 access-url 接口 →
 *   正文接口两跳才拿得到，是 `SourceAdapter.resolveDetailUrl` 契约的唯一使用者。
 *
 * 本场景另锁定两条**状态推导次序**（issue #18 引入 NormalizedNotice.status）：
 * ① 截止日期优先于源标注 —— 合成条目标注 [进行中] 但详情截止日期已过 → 已截止；
 * ② 截止日期解析不到时用源标注 —— 详情页模板不认识（未知站点）时解析不到正文与
 *    截止日期，状态退回 [进行中]（否则会被误判成「已截止」或「无截止日期即进行中」）；
 * ③ 跨域条目若模板**已适配**（民航局 div.content / 铁路局 #Zoom），正文、截止日期与
 *    附件都要取到（issue #24：曾 7 条全空，占全站 5%）。
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
  motNra: '国家铁路局关于《铁路交通事故调查处理规则（修订草案征求意见稿）》公开征求意见的通知',
  motUnknownTemplate: '国家能源局关于《电力辅助服务市场基本规则（征求意见稿）》公开征求意见的通知',
  motConflict: '关于《公路水运工程安全生产监督管理办法（修订征求意见稿）》公开征求意见的通知',
  moeClosed: '教育部关于《校外培训管理条例（征求意见稿）》公开征求意见的公告',
  moeJoint: '人力资源社会保障部办公厅 教育部办公厅关于《关于深化高等学校教师职称制度改革的指导意见（征求意见稿）》公开征求意见的通知',
  moeClosed2: '教育部关于《中华人民共和国教师法（修订草案）（征求意见稿）》公开征求意见的公告',
  // 国家发展改革委（issue #20）：链式跳转源。标题入库前剥掉【进行中】/ [已结束]
  // 标注与接口返回的 <BR> 换行标签。
  ndrcOpen: '国家发展改革委关于向社会公开征求《售电公司管理办法（公开征求意见稿）》意见的公告',
  ndrcOpen2: '关于向社会公开征求对《人民防空工程建设管理规定（征求意见稿）》意见的公告',
  ndrcOpen3: '国家发展改革委关于向社会公开征求《能源行业行政处罚案件违法所得认定办法（公开征求意见稿）》意见的公告',
  ndrcClosed: '国家发展改革委关于向社会公开征求《电网公平开放监管办法》（公开征求意见稿）意见的公告',
  ndrcBrokenChain: '关于向社会公开征求《链式跳转断裂降级验证办法（征求意见稿）》意见的公告',
};

/** 全部入库条目（24 条：samr 5 + miit 4 + mot 7 + moe 3 + ndrc 5）。 */
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
    // mot 列表 8 行 → 过滤掉 1 条非征求意见条目（答记者问 / 反馈情况）后入库 7 条
    assert.match(run.output, /源 mot 抓取完成：列表 7 条，新增 7，更新 0/);
    assert.match(run.output, /源 moe 抓取完成：列表 3 条，新增 3，更新 0/);
    assert.match(run.output, /源 ndrc 抓取完成：列表 5 条，新增 5，更新 0/);
    // 链式跳转断裂的那条：记日志降级、不中断整源（条目仍以列表层数据入库）
    assert.match(run.output, /详情页抓取失败（保留列表层数据）[^\n]*access-url 响应缺少 articleId/);
  });

  it('首页：24 条新源条目全部呈现，非征求意见条目被过滤', async () => {
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

  it('状态推导②：未知模板详情不可解析时保留源标注（降级不丢条目）', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const block = blockOf(extractItemBlocks(html), TITLES.motUnknownTemplate);
    assert.equal(block.badge, '征求意见中', '详情解析不到截止日期时应退回列表的 [进行中] 标注');
    assert.equal(block.countdown, null, '没有截止日期就不展示倒计时');
    // 条目本身仍以列表层数据入库（标题 / 机关 / 发布日期 / 官方链接），不整条丢弃
    assert.equal(block.title, TITLES.motUnknownTemplate);
    assert.equal(
      stripSsrComments(await fetch(`${app.url}${block.href}`).then((response) => response.text()))
        .includes('国家能源局'),
      true,
      '机关取自标题前缀，未知模板不影响列表层字段',
    );
  });

  it('跨域详情模板：民航局（div.content）与铁路局（#Zoom）都能取到正文、截止日期与附件', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const blocks = extractItemBlocks(html);

    // 民航局：正文与附件同在一个 div.content 容器里；截止句是「意见反馈截止日期为：X」
    // （「为」与「：」同时出现 —— 旧版 extractDeadline 只允许一个引导字符，整条抽不到）
    const caacBlock = blockOf(blocks, TITLES.motCrossDomain);
    assert.equal(caacBlock.badge, '征求意见中');
    assert.equal(caacBlock.countdown, '剩 17 天', '截止日期取到了才会出现倒计时');
    const caacText = stripSsrComments(
      await fetch(`${app.url}${caacBlock.href}`).then((response) => response.text()),
    );
    assert.match(caacText, /为进一步规范运输机场运营许可管理/, '正文取自 div.content');
    assert.match(caacText, /jcsaqc@caac\.gov\.cn/, '正文含反馈渠道（「如何提意见」的信息源）');
    assert.match(caacText, /运输机场运营许可规定（征求意见稿）\.pdf/, '附件 1');
    assert.match(caacText, /意见反馈表\.docx/, '附件 2');
    // 机关名经归一（issue #21）：标题里的「中国民航局」入库为规范名「中国民用航空局」
    assert.match(
      caacText,
      /发布机关<\/dt><dd>中国民用航空局</,
      '简称「中国民航局」归一为规范名「中国民用航空局」',
    );

    // 国家铁路局：正文容器 #Zoom，页面正文里有一段内联脚本（document.write 相关链接），
    // 脚本源码不得混进正文
    const nraBlock = blockOf(blocks, TITLES.motNra);
    assert.equal(nraBlock.badge, '征求意见中');
    assert.equal(nraBlock.countdown, '剩 12 天');
    const nraText = stripSsrComments(
      await fetch(`${app.url}${nraBlock.href}`).then((response) => response.text()),
    );
    assert.match(nraText, /国家铁路局组织修订形成《铁路交通事故调查处理规则/, '正文取自 #Zoom');
    assert.match(nraText, /ajsgw@nra\.gov\.cn/);
    assert.ok(
      !/document\.write|str_appendix|file_appendix/.test(nraText),
      '正文里不得出现内联脚本源码（blockText 先剔除 script/style/noscript）',
    );
    assert.match(nraText, /铁路交通事故调查处理规则（修订草案征求意见稿）修订说明/, '附件');
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

  it('国家发展改革委：链式跳转取正文与截止日期，标注与 <BR> 剥离', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const blocks = extractItemBlocks(html);

    // 截止日期只存在于正文接口返回的内容里（「此次公开征求意见的时间为 X 至 Y」）
    // → 能展示倒计时就证明整条链（access-url → 正文接口）跑通了
    const open = blockOf(blocks, TITLES.ndrcOpen);
    assert.equal(open.badge, '征求意见中');
    assert.match(open.countdown, /^剩 \d+ 天$/, '截止日期来自链式跳转后的正文内容');

    // 已结束条目：标注与正文里的截止日期一致（都是过去）
    assert.equal(blockOf(blocks, TITLES.ndrcClosed).badge, '已截止');

    // 详情页：正文、附件与官方原文链接（官方原文 = 人工可读的 sa.html#/<key> 页面，
    // 不是链路中间的接口地址）
    const detail = await fetch(`${app.url}${open.href}`).then((response) => response.text());
    const text = stripSsrComments(detail);
    assert.match(text, /为加快推进全国统一电力市场建设/, '正文来自 getArticleDetail 接口');
    // 附件名取链接文本（不带扩展名），链接地址才是官方文件地址
    assert.match(text, /附件清单[\s\S]{0,200}售电公司管理办法（公开征求意见稿）/);
    assert.match(text, /yyglxxbs\.ndrc\.gov\.cn\/file-submission\/\d+\.docx/, '附件链接指向官方文件地址');
    // 官方原文 = 人工可读的 sa.html#/<key> 页面（生产是数据服务域名下的地址，
    // E2E 里被重写为 fixture 地址），而不是链路中间的接口地址
    assert.match(text, /sa\.html#\//, '官方原文指向人工可读页面');
    assert.ok(!/getArticleDetail|access-url/.test(text), '链路中间的接口地址不应出现在页面上');
  });

  it('链式跳转断裂时降级：条目保留列表层数据、状态退回源标注、不中断整源', async () => {
    const html = await fetch(`${app.url}/`).then((response) => response.text());
    const block = blockOf(extractItemBlocks(html), TITLES.ndrcBrokenChain);
    assert.equal(block.badge, '征求意见中', '正文取不到时状态退回列表的【进行中】标注');
    assert.equal(block.countdown, null, '没有截止日期就不展示倒计时');

    const detail = await fetch(`${app.url}${block.href}`).then((response) => response.text());
    const text = stripSsrComments(detail);
    assert.match(text, /链式跳转断裂降级验证办法/, '条目照常入库并渲染');
    assert.match(text, /2026-09-10/, '发布日期取自列表层');
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
