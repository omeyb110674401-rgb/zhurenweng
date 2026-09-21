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
 * E2E（issue #29）：国家网信办「网信@你」——第 10 个源。
 *
 * 本场景锁定的性质，按「列表过滤 → 详情 → 状态推导 → 页面」四层：
 *
 * 1. **栏目是混排的通知公告**（20 条里只有 8 条是征求意见）：fixture 刻意放了
 *    4 条列表行、其中 1 条是「换届及征集委员」非征求意见条目，且**没有它的详情快照**
 *    —— 适配器标题过滤一旦失效，抓取条数会变成 4、并出现详情抓取失败，两条断言都会红；
 * 2. **列表没有截止日期、也没有状态标注**：发布日期来自详情 `#pubtime`（带时分的写法），
 *    截止日期与状态全部由详情正文推导；
 * 3. **截止句写法不止一种**：进行中那条是「意见反馈截止日期为…」（规则 1），
 *    已截止那条是「请于…前将意见反馈给组织起草部门」（规则 3），两条都要抽到；
 * 4. **附件是无扩展名的下载接口**（`downloadfile.jsp?filepath=…&fText=…`），共享的
 *    按扩展名收集会全部漏掉 —— 断言三个附件都被收上来且名字取自 `fText`；
 * 5. **标题取不到机关前缀时兜底国家网信办**（实测那条强制性国家标准的标题里没有机关名）。
 *
 * fixture 根目录 `fixtures/e2e-cac/`（独立成目录，不动 e2e-sources 那套精确计数断言）。
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub 端口。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-cac');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-cac-'));
const dbFile = path.join(workDir, 'app.db');

/** 四条真实条目标题（快照未改写，仅日期换成令牌）。 */
const TITLES = {
  /** 进行中：截止日期 {{CN_DATE+26}}，正文含邮箱 + 信函地址（邮编写法） */
  open: '国家互联网信息办公室关于《国务院关于保障未成年人健康安全使用网络的规定（征求意见稿）》公开征求意见的通知',
  /** 已截止：标题不含机关前缀（兜底值场景），附件是三个无扩展名下载链接 */
  standard: '关于征求《政务移动互联网应用程序管理要求》强制性国家标准（征求意见稿）意见的通知',
  /** 已截止：截止句写作「意见反馈截止日期为…」 */
  closed: '国家互联网信息办公室关于《中华人民共和国反网络暴力法（征求意见稿）》公开征求意见的通知',
  /** 非征求意见条目：必须被适配器过滤掉（快照里没有它的详情页） */
  filtered: '关于全国网络安全标准化技术委员会换届及征集委员的通知',
};

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

/** 按 <li class="notice-item"> 分块提取列表条目。 */
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

/** 首页 HTML（剥掉 SSR 注释）。 */
async function homeHtml() {
  return stripSsrComments(await (await fetch(`${app.url}/`)).text());
}

/** 指定标题的详情页 HTML（剥掉 SSR 注释）。 */
async function detailOf(title) {
  const href = blockOf(extractItemBlocks(await homeHtml()), title).href;
  return stripSsrComments(await (await fetch(`${app.url}${href}`)).text());
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

describe('issue #29：网信办源的抓取与入库', () => {
  it('一轮抓取：列表 4 行只入 3 条（非征求意见条目被过滤），无失败', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(
      run.output,
      /源 cac 抓取完成：列表 3 条，新增 3，更新 0/,
      `应只抓到 3 条征求意见条目（第 4 行是非征求意见的换届征集委员通知）：${run.output}`,
    );
    assert.ok(!/源 cac .*失败/.test(run.output), '本源不应报错');
    // 过滤失效时那条会去抓详情，而快照里没有它的详情页 → 这里会留下失败日志
    assert.ok(!/详情页抓取失败/.test(run.output), `不应有详情抓取失败：${run.output}`);
  });

  it('非征求意见条目没有进库（也不在首页出现）', async () => {
    const home = await homeHtml();
    assert.ok(!home.includes(TITLES.filtered), '「换届及征集委员」不是征求意见，不应入库');
    assert.match(home, /共 3 条。/, '本 fixture 目录只有 cac 一个源，应恰好 3 条');
  });

  it('状态按详情正文的截止日期推导：进行中一条、已截止两条', async () => {
    const blocks = extractItemBlocks(await homeHtml());
    assert.match(blockOf(blocks, TITLES.open).badge, /征求意见中/);
    assert.match(blockOf(blocks, TITLES.standard).badge, /已截止/);
    assert.match(blockOf(blocks, TITLES.closed).badge, /已截止/);
  });

  it('倒计时与截止日期一致（列表层无日期，靠详情正文抽）', async () => {
    const blocks = extractItemBlocks(await homeHtml());
    assert.match(blockOf(blocks, TITLES.open).countdown, /剩 26 天/);
  });
});

describe('issue #29：详情页解析（发布日期 / 正文 / 附件 / 机关）', () => {
  it('发布日期由详情页 #pubtime 补上（带时分的写法也能归一）', async () => {
    // 期望值取自 fixture 源站**替换令牌后**的实际快照：不在测试里重算日期，
    // 否则 UTC 与本地日历两种口径会差一天（mohurd 场景踩过）
    const fixtureDetail = await (
      await fetch(`${fixtureUrl}/cac/2026-09/18/c_1791482017777471.htm`)
    ).text();
    const parts = /id="pubtime">\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(fixtureDetail);
    assert.ok(parts, 'fixture 详情页应含替换后的发布时刻');
    const expected = `${parts[1]}-${parts[2].padStart(2, '0')}-${parts[3].padStart(2, '0')}`;

    const detail = await detailOf(TITLES.open);
    assert.match(detail, /<dt>发布日期<\/dt><dd>\d{4}-\d{2}-\d{2}<\/dd>/, '应显示发布日期');
    assert.ok(detail.includes(expected), `详情页应显示 #pubtime 里的发布日期 ${expected}`);
  });

  it('正文取自 #BodyLabel（正文尾部的 pagestat 脚本不进正文）', async () => {
    const detail = await detailOf(TITLES.open);
    assert.match(detail, /data-testid="notice-body"/);
    assert.match(detail, /为了加强未成年人网络保护/);
    assert.ok(!detail.includes('newCrToken'), '正文里不应混进源站的上报脚本');
  });

  it('附件被收上来：下载接口链接没有扩展名，名字取自 fText', async () => {
    const detail = await detailOf(TITLES.standard);
    assert.match(detail, /data-testid="notice-attachments"/);
    assert.match(detail, /政务移动互联网应用程序管理要求（征求意见稿）<\/a>/);
    assert.match(detail, /编制说明<\/a>/);
    assert.match(detail, /强制性国家标准反馈意见表<\/a>/);
    assert.match(detail, /downloadfile\.jsp\?filepath=/);
  });

  it('机关名兜底：标题里没有机关前缀的条目记为栏目主办方', async () => {
    assert.match(
      await detailOf(TITLES.open),
      /<dt>发布机关<\/dt><dd>国家互联网信息办公室<\/dd>/,
    );
    // 该条标题是「关于征求《…》强制性国家标准（征求意见稿）意见的通知」，没有机关前缀
    assert.match(
      await detailOf(TITLES.standard),
      /<dt>发布机关<\/dt><dd>国家互联网信息办公室<\/dd>/,
      '取不到前缀时兜底国家网信办（正文落款是「中央网信办」，与国家网信办是一个机构两块牌子）',
    );
  });

  it('标题保持列表层原文（不含源站换行造成的多余空格）', async () => {
    const heading =
      (/<h1 class="detail-title">([^<]*)<\/h1>/.exec(await detailOf(TITLES.open)) ?? [])[1] ?? '';
    assert.equal(heading, TITLES.open);
  });

  it('结构化速读复用本源正文：邮箱可点击、信函地址含邮编（issue #26/#27）', async () => {
    const detail = await detailOf(TITLES.open);
    assert.match(detail, /data-testid="submission-channels"/, '应渲染提交方式块');
    assert.match(detail, /href="mailto:weibao@cac\.gov\.cn"/, '正文里的邮箱应可点击');
    assert.match(
      detail,
      /北京市西城区车公庄大街11号国家互联网信息办公室网络法治局，邮编：100044/,
      '信函地址应抽出且带上邮编（「，邮编：」写法，见 issue #28 的地址尾修复）',
    );
  });
});
