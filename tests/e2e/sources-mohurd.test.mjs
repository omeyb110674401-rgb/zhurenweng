import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { startAppServer } from './helpers/app-server.mjs';
import { createFixtureServer } from './helpers/fixture-server.mjs';
import { noticeItems } from './helpers/html.mjs';

/**
 * E2E（issue #28）：住房城乡建设部「征求意见」——第 9 个源。
 *
 * 本场景锁定的性质，按「列表 → 详情 → 状态推导 → 页面」四层：
 *
 * 1. **列表是接口响应**（TRS jpaas，同 samr / miit 族）：适配器直接消费
 *    `{data:{html}}` 片段里的 `li.long-deta` 行；
 * 2. **截止日期只在列表**（`<span class="date-info">截止日期 X</span>`），本源没有
 *    状态列、也没有发布日期列 —— 发布日期必须由详情页 `meta[PubDate]` 补上；
 * 3. **机关名要保住「办公厅」**：本源大量标题写作「…办公厅关于**国家标准**《…》」，
 *    「关于」后跟的是标准类型词而非书名号，共享的 `agencyFromTitle` 会退到默认值。
 *    本场景断言部本级与办公厅两种署名都被如实保留；
 * 4. **附件链接没有扩展名**（下载接口 `/document/download?fileUrl=…`），共享的按扩展名
 *    收集会全部漏掉 —— 断言附件确实被收上来了；
 * 5. **状态推导**：列表含一条已截止条目（截止日期为负偏移令牌），必须推导为已截止，
 *    进行中的两条必须为进行中。
 *
 * fixture 根目录 `fixtures/e2e-mohurd/`（独立于 M2 的 e2e-sources，避免动那套精确计数）。
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-mohurd');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-mohurd-'));
const dbFile = path.join(workDir, 'app.db');

/** 三条真实条目标题（快照未改写，仅截止日期换成令牌）。 */
const TITLES = {
  /** 部本级署名 + 法规司发文 */
  headquarter: '住房城乡建设部关于《住房城乡建设部行政复议办法（征求意见稿）》公开征求意见的通知',
  /** 办公厅署名 + 国家标准（「关于」后跟标准类型词） */
  officeStandard:
    '住房城乡建设部办公厅关于国家标准《便携式管线探测设备技术要求（征求意见稿）》公开征求意见的通知',
  /** 已截止（截止日期为负偏移令牌） */
  expired:
    '住房城乡建设部办公厅关于国家标准《工业企业总平面设计标准（局部修订征求意见稿）》公开征求意见的通知',
};

let app;
let fixtures;

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

/** 列表条目 → 标题 / 状态徽标 / 倒计时。 */
function extractItemBlocks(html) {
  return noticeItems(html)
    .map((block) => block.slice(0, block.indexOf('</li>')))
    .map((block) => ({
      title: (/<a[^>]*notice-title-link[^>]*>([^<]+)<\/a>/.exec(block) ?? [])[1] ?? '',
      href: (/href="(\/notices\/[0-9a-f]+)"/.exec(block) ?? [])[1] ?? '',
      agency: (/<span[^>]*notice-agency[^>]*>([^<]*)<\/span>/.exec(block) ?? [])[1] ?? '',
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
async function fetchFixtureList() {
  const response = await fetch(`${fixtureUrl}/mohurd/list.json`);
  assert.equal(response.status, 200, 'fixture 应提供 mohurd 列表快照');
  return response.json();
}

let fixtureUrl;

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

describe('issue #28：住建部源的抓取与入库', () => {
  it('一轮抓取：3 条入库，无失败', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(
      run.output,
      /源 mohurd 抓取完成：列表 3 条，新增 3，更新 0/,
      `应抓到 3 条：${run.output}`,
    );
    assert.ok(!/源 mohurd .*失败/.test(run.output), '本源不应报错');
  });

  it('列表快照自带截止日期，令牌已按运行时替换（相对今天）', async () => {
    const payload = await fetchFixtureList();
    const html = payload.data.html;
    const deadlines = [...html.matchAll(/截止日期\s*(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    assert.equal(deadlines.length, 3, '三条列表行都应带截止日期');
    // 三条分别是 +27 / +17 / -21 天：正偏移在前、负偏移（已截止）在后
    assert.deepEqual(
      deadlines.map((iso) => daysUntil(iso)),
      [27, 17, -21],
    );
  });

  it('机关名如实保留源站署名：部本级与办公厅两种都不被折叠', async () => {
    // 列表项不含发布机关（notice-item.tsx 只有标题 / 标签 / 状态 / 倒计时），
    // 机关名在详情页的字段区断言
    const detailOf = async (title) => {
      const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
      const href = blockOf(extractItemBlocks(list), title).href;
      return stripSsrComments(await (await fetch(`${app.url}${href}`)).text());
    };
    assert.match(
      await detailOf(TITLES.headquarter),
      /<dt>发布机关<\/dt><dd>住房城乡建设部<\/dd>/,
    );
    assert.match(
      await detailOf(TITLES.officeStandard),
      /<dt>发布机关<\/dt><dd>住房城乡建设部办公厅<\/dd>/,
      '「办公厅关于国家标准《…》」这种写法也要保住源站署名，不能退到默认值',
    );
  });

  it('状态按截止日期推导：正偏移为进行中、负偏移为已截止', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const blocks = extractItemBlocks(list);
    assert.match(blockOf(blocks, TITLES.headquarter).badge, /征求意见中/);
    assert.match(blockOf(blocks, TITLES.officeStandard).badge, /征求意见中/);
    assert.match(blockOf(blocks, TITLES.expired).badge, /已截止/);
  });

  it('倒计时与列表截止日期一致（列表层解析正确）', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const blocks = extractItemBlocks(list);
    assert.match(blockOf(blocks, TITLES.headquarter).countdown, /剩 27 天/);
    assert.match(blockOf(blocks, TITLES.officeStandard).countdown, /剩 17 天/);
  });
});

describe('issue #28：详情页解析（发布日期 / 正文 / 附件）', () => {
  it('发布日期由详情页 meta PubDate 补上（列表层没有这一列）', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const href = blockOf(extractItemBlocks(list), TITLES.headquarter).href;

    // 期望值取自 fixture 源站**替换令牌后**的实际快照：不在测试里重算日期，
    // 否则 UTC 与本地日历两种口径会差一天（第一次就是栽在这里）
    const fixtureDetail = await (
      await fetch(
        `${fixtureUrl}/mohurd/gongkai/zc/wjk/art/2026/art_0d144cfa624e415b932c0f5950c2105a.html`,
      )
    ).text();
    const expected = /<meta name="PubDate" content="(\d{4}-\d{2}-\d{2})/.exec(fixtureDetail)?.[1];
    assert.ok(expected, 'fixture 详情页应含替换后的 PubDate');

    const detail = stripSsrComments(await (await fetch(`${app.url}${href}`)).text());
    assert.match(detail, /<dt>发布日期<\/dt><dd>\d{4}-\d{2}-\d{2}<\/dd>/, '应显示发布日期');
    assert.ok(
      detail.includes(expected),
      `详情页应显示列表层缺失的发布日期 ${expected}（本源列表无发布日期列）`,
    );
  });

  it('正文取自 .editor-content（含原文的联系方式与截止句）', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const detail = stripSsrComments(
      await (await fetch(`${app.url}${blockOf(extractItemBlocks(list), TITLES.headquarter).href}`)).text(),
    );
    assert.match(detail, /data-testid="notice-body"/);
    assert.match(detail, /我部起草了《住房城乡建设部行政复议办法（征求意见稿）》/);
    assert.match(detail, /意见反馈截止时间为/);
  });

  it('附件被收上来：下载接口链接没有扩展名，按容器 + 路径收集', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const detail = stripSsrComments(
      await (await fetch(`${app.url}${blockOf(extractItemBlocks(list), TITLES.headquarter).href}`)).text(),
    );
    assert.match(detail, /data-testid="notice-attachments"/);
    assert.match(detail, /住房城乡建设部行政复议办法（征求意见稿）<\/a>/);
    assert.match(detail, /\/api-gateway\/jpaas-web-server\/front\/document\/download\?fileUrl=/);
  });

  it('附件块给出「打不开就回官方原文页」的出路（issue #35）', async () => {
    // 生产实测 340 个附件引用里 31 个（全为工信部）在两类网络下都 403：
    // 文件挂在一个对非白名单客户端一律拦的政府主机上，而官方页面链接的是同一批 URL。
    // 我们不隐藏这些链接（用户浏览器未必同样被拦），但要在附件块里给出官方原文这条退路。
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const block = blockOf(extractItemBlocks(list), TITLES.headquarter);
    const detail = stripSsrComments(await (await fetch(`${app.url}${block.href}`)).text());

    const fallback = /data-testid="attachment-fallback"[\s\S]{0,400}?<\/p>/.exec(detail)?.[0] ?? '';
    assert.ok(fallback.length > 0, '附件块应有出路提示');
    assert.match(fallback, /附件打不开/);
    // 出路要指向**该条目的官方原文页**：与页面上的 official-url 同址
    // （不写死生产域名 —— fixture 场景下详情 URL 落在本地 fixture 源站上）
    const officialUrl = /data-testid="official-url"[^>]*href="([^"]+)"/.exec(detail)?.[1]
      ?? /<a href="([^"]+)"[^>]*data-testid="official-url"/.exec(detail)?.[1];
    assert.ok(officialUrl, '详情页应有官方原文链接');
    assert.ok(
      fallback.includes(`href="${officialUrl}"`),
      `出路提示应链到官方原文页 ${officialUrl}，实际：${fallback.slice(0, 200)}`,
    );
  });

  it('结构化速读同样适用本源：原文的联系方式被抽成提交渠道（issue #26/#27 复用）', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const detail = stripSsrComments(
      await (await fetch(`${app.url}${blockOf(extractItemBlocks(list), TITLES.headquarter).href}`)).text(),
    );
    assert.match(detail, /data-testid="submission-channels"/, '应渲染提交方式块');
    assert.match(detail, /href="mailto:zqyjcin@126\.com"/, '正文里的邮箱应可点击');
    assert.match(detail, /北京市海淀区三里河路九号住房城乡建设部法规司/, '通信地址应抽出');
  });

  it('详情页不覆盖列表标题（meta ArticleTitle 带换行会引入空格）', async () => {
    const list = stripSsrComments(await (await fetch(`${app.url}/`)).text());
    const detail = stripSsrComments(
      await (await fetch(`${app.url}${blockOf(extractItemBlocks(list), TITLES.headquarter).href}`)).text(),
    );
    const heading = (/<h1 class="detail-title">([^<]*)<\/h1>/.exec(detail) ?? [])[1] ?? '';
    assert.equal(heading, TITLES.headquarter, '标题应保持列表层的无换行版本');
    assert.ok(!heading.includes('行政复议 办法'), '不应出现源站换行造成的空格');
  });
});
