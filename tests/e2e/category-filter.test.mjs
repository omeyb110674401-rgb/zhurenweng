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
 * E2E（issue #9）：领域标签自动打标 + 列表页分类/机关/关键词筛选。
 *
 * 场景（三源 fixture 入库 → 打标 → 浏览筛选）：
 *   worker 单轮抓取三源（npc / moj / mee，跨源去重后 9 条）
 *   → 每条目的领域标签由关键词规则自动推导且与期望一致
 *     （关键词命中标题：医疗保障法「医疗」、铁路条例「铁路」、仲裁法「仲裁」等；
 *       关键词命中正文：国家公园法标题无领域词、正文「生态」命中生态环境；
 *       无关键词命中：渔业法 / 历史文化遗产保护法不打标签）
 *   → 按领域过滤列表只含对应条目，且激活态落在对应标签云链接上
 *   → 按发布机关过滤（下拉选项 = 库内去重机关，精确匹配）
 *   → 关键词过滤（标题 / 正文包含匹配）
 *   → 组合过滤（领域 + 机关、领域 + 关键词）与组合无结果空态
 *   → 无结果空态（关键词不命中任何条目）
 *   → 筛选不影响倒计时排序（过滤结果是未筛选倒计时顺序的子序列）
 *
 * 全程零外部依赖（ADR-0001）：SQLite 临时文件库 + 本地 fixture 源站 + stub LLM。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-issue9-'));
const dbFile = path.join(workDir, 'app.db');

const TITLES = {
  npc1: '企业破产法（修订草案二次审议稿）征求意见',
  npc2: '道路交通安全法（修订草案）征求意见',
  npc3: '检察公益诉讼法（草案二次审议稿）征求意见',
  jingrong:
    '司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局关于《中华人民共和国金融法（草案）》公开征求意见的通知',
  xingzheng: '司法部关于《中华人民共和国行政复议法实施条例（修订征求意见稿）》公开征求意见的通知',
  chengxu: '司法部关于《行政法规制定程序条例（修订征求意见稿）》公开征求意见的通知',
  shuiyuan:
    '关于公开征求《饮用水水源地基础信息数据元技术规范（征求意见稿）》等2项国家生态环境标准意见的通知',
  haiyu: '关于公开征求《沿海省（区、市）近岸海域重要物种名录》意见的函',
  hedian:
    '关于公开征求国家生态环境标准《生态环境影响评价技术导则 核动力厂（征求意见稿）》（修订HJ808-2016）意见的通知',
};

/**
 * 每条 fixture 条目的期望领域标签（src/lib/categories.ts 关键词规则的预期结果）。
 * 标题命中：xingzheng（行政复议）、shuiyuan（生态环境标准）、hedian（生态环境）、
 * npc2（交通 / 道路）；
 * 仅正文命中：npc1 / npc3（人大真实正文含「国家法律法规数据库」→「数据」）、
 * chengxu（moj 正文「落实立法法要求」→「立法」）、
 * haiyu（正文「海洋生态环境保护」→「生态环境」）、
 * shuiyuan（正文「数据元」→「数据与网络安全」）；
 * jingrong = 标题与正文均无关键词命中 → 不打标签。
 */
const EXPECTED_TAGS = {
  [TITLES.npc1]: ['数据与网络安全'], // 标题无领域词，正文「国家法律法规数据库」命中「数据」
  [TITLES.npc2]: ['交通运输', '数据与网络安全'], // 标题命中「交通/道路」，正文命中「数据」
  [TITLES.npc3]: ['数据与网络安全'], // 标题无领域词，正文命中「数据」
  [TITLES.jingrong]: [], // 标题与正文（已裁剪）均无关键词命中 → 不打兜底标签
  [TITLES.shuiyuan]: ['生态环境', '数据与网络安全'], // 标题「生态环境标准」+ 正文「数据元」
  [TITLES.haiyu]: ['生态环境'], // 标题无领域词，正文「海洋生态环境保护」命中
  [TITLES.hedian]: ['生态环境'], // 标题命中「生态环境」
  [TITLES.xingzheng]: ['立法与司法'], // 标题命中「行政复议」
  [TITLES.chengxu]: ['立法与司法'], // 标题无词，正文「落实立法法要求」命中「立法」
};

/** 库内去重后的全部发布机关（= 机关下拉选项，按名称排序前的全集） */
const AGENCIES = [
  '全国人大常委会法制工作委员会',
  '司法部',
  '司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局',
  '生态环境部',
  '生态环境部办公厅',
];

/** 未筛选列表的期望倒计时顺序：征求意见中按截止日期升序，已截止沉底。 */
const EXPECTED_FULL_ORDER = [
  TITLES.shuiyuan, // +12（跨源去重条目）
  TITLES.haiyu, // +18
  TITLES.npc1, // +21（企业破产法）
  TITLES.xingzheng, // +22（行政复议法实施条例）
  TITLES.hedian, // +26
  TITLES.jingrong, // +30（金融法）
  TITLES.chengxu, // +44（行政法规制定程序条例）
  TITLES.npc2, // +45（道路交通安全法）
  TITLES.npc3, // 已截止（真实历史截止日 2026-07-25），沉底
];

let app;
let fixtures;
let fixtureUrl;

/** 单轮运行真实 worker 子进程（抓取 → 摘要 → 提醒 → 检索索引重建）。 */
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

/** React SSR 会在文本 + 表达式混排处插入 <!-- --> 注释，文本断言前剥掉。 */
function stripSsrComments(html) {
  return html.replaceAll('<!-- -->', '');
}

/** 从结果页 HTML 提取条目块（<li data-testid="notice-item">…</li>）。 */
function extractNoticeItems(html) {
  const items = [];
  const pattern = /<li[^>]*data-testid="notice-item"[^>]*>[\s\S]*?<\/li>/g;
  for (const match of html.matchAll(pattern)) {
    items.push(match[0]);
  }
  return items;
}

/** 条目块 → 标题文本（notice-title-link 的子文本）。 */
function itemTitle(item) {
  const match = /data-testid="notice-title-link"[^>]*>([^<]*)<\/a>/.exec(item);
  return match ? match[1] : '';
}

/** 条目块 → 领域标签列表（notice-category-tag 的子文本，按渲染顺序）。 */
function itemTags(item) {
  return [...item.matchAll(/data-testid="notice-category-tag"[^>]*>([^<]*)</g)].map(
    (match) => match[1],
  );
}

/** 结果页 HTML → 条目标题序列（保持渲染顺序 = 倒计时排序）。 */
function listOrder(html) {
  return extractNoticeItems(html).map(itemTitle);
}

/** GET 首页（可带 querystring，值自行 encodeURIComponent）并返回剥注释后的 HTML。 */
async function fetchHome(query = '') {
  const response = await fetch(`${app.url}/${query}`);
  assert.equal(response.status, 200, `首页应 200，实际 ${response.status}（query=${query}）`);
  return stripSsrComments(await response.text());
}

/** 断言 sub 是 full 的子序列（同相对顺序），证明筛选不改变倒计时排序。 */
function assertSubsequence(sub, full, message) {
  let cursor = 0;
  for (const title of full) {
    if (cursor < sub.length && title === sub[cursor]) cursor += 1;
  }
  assert.equal(cursor, sub.length, `${message}：${JSON.stringify(sub)} 应为 ${JSON.stringify(full)} 的子序列`);
}

before(async () => {
  fixtures = createFixtureServer({ fixturesDir });
  fixtureUrl = (await fixtures.start()).url;

  app = await startAppServer({
    env: {
      DATABASE_URL: dbFile,
      LLM_PROVIDER: 'stub',
      MAILER_PROVIDER: 'stub',
      SOURCES_FIXTURE_BASE: fixtureUrl,
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #9：领域标签自动打标与分类浏览筛选', () => {
  it('worker 单轮入库三源 9 条，各条目领域标签符合关键词规则（标题命中与正文命中）', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出，输出：${run.output}`);
    assert.match(run.output, /源 npc 抓取完成：列表 3 条，新增 3，更新 0/);
    assert.match(run.output, /源 moj 抓取完成/);
    assert.match(run.output, /源 mee 抓取完成/);

    const html = await fetchHome();
    assert.match(html, /data-testid="filter-result-count"[^>]*>共 9 条/, '跨源去重后应恰为 9 条');

    const tagsByTitle = new Map(extractNoticeItems(html).map((item) => [itemTitle(item), itemTags(item)]));
    for (const [title, expected] of Object.entries(EXPECTED_TAGS)) {
      assert.deepEqual(
        tagsByTitle.get(title),
        expected,
        `条目「${title}」的领域标签应为 ${JSON.stringify(expected)}`,
      );
    }
  });

  it('筛选条渲染：领域标签云（全部领域 + 10 领域）、机关下拉（库内去重）、关键词框', async () => {
    const html = await fetchHome();

    const chips = [...html.matchAll(/data-testid="category-filter-link"[^>]*>([^<]*)</g)].map(
      (match) => match[1],
    );
    assert.deepEqual(
      chips,
      ['立法与司法', '经济与产业', '科技与互联网', '教育与科研', '医疗卫生', '生态环境', '交通运输', '市场监管', '社会保障', '数据与网络安全'],
      '标签云应含全部领域且顺序与词表一致',
    );
    assert.match(html, /data-testid="category-filter-all"[^>]*>全部领域/);

    const options = [...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((match) => match[1]);
    assert.equal(options[0], '全部机关', '机关下拉首项应为「全部机关」占位');
    const agencyOptions = options.slice(1);
    assert.equal(new Set(agencyOptions).size, agencyOptions.length, '机关选项应去重');
    assert.equal(agencyOptions.length, AGENCIES.length, '机关选项应覆盖库内全部机关');
    for (const agency of AGENCIES) {
      assert.ok(agencyOptions.includes(agency), `机关下拉应含「${agency}」`);
    }

    assert.match(html, /data-testid="filter-keyword-input"/);
    assert.match(html, /data-testid="filter-form"[^>]*action="\/"/);
    assert.match(html, /data-testid="filter-form"[^>]*method="get"/, '筛选表单应为 GET（URL 驱动）');
  });

  it('按领域过滤：标题命中打标的「生态环境」含 3 条 mee 条目，激活态正确', async () => {
    const html = await fetchHome(`/?category=${encodeURIComponent('生态环境')}`);
    assert.deepEqual(listOrder(html), [TITLES.shuiyuan, TITLES.haiyu, TITLES.hedian]);
    assert.match(html, /data-testid="filter-result-count"[^>]*>筛选后共 3 条/);
    assert.match(
      html,
      /data-testid="category-filter-link" aria-current="true"[^>]*>生态环境/,
      '激活态应落在生态环境标签上',
    );
    // 切换领域保留机关 / 关键词的入口仍在；标签云其余链接保持未激活
    assert.ok(!/aria-current="true"[^>]*>交通运输/.test(html));
  });

  it('按领域过滤：正文命中打标的「数据与网络安全」含 4 条；「立法与司法」含 2 条且保持倒计时顺序', async () => {
    const dataDomain = await fetchHome(`/?category=${encodeURIComponent('数据与网络安全')}`);
    assert.deepEqual(
      listOrder(dataDomain),
      [TITLES.shuiyuan, TITLES.npc1, TITLES.npc2, TITLES.npc3],
      'npc 三条由正文「国家法律法规数据库」命中；mee 的饮用水条目正文含「数据元」',
    );

    const lijisifa = await fetchHome(`/?category=${encodeURIComponent('立法与司法')}`);
    assert.deepEqual(listOrder(lijisifa), [TITLES.xingzheng, TITLES.chengxu]);
    assert.match(lijisifa, /data-testid="filter-result-count"[^>]*>筛选后共 2 条/);
  });

  it('按发布机关过滤：精确匹配（司法部 ≠ 联合发布前缀；生态环境部 ≠ 办公厅）', async () => {
    const html = await fetchHome(`/?agency=${encodeURIComponent('司法部')}`);
    assert.deepEqual(
      listOrder(html),
      [TITLES.xingzheng, TITLES.chengxu],
      '机关精确匹配只含「司法部」（不含联合发布的长前缀）',
    );
    assert.match(html, /data-testid="filter-result-count"[^>]*>筛选后共 2 条/);

    const joint = await fetchHome(
      `/?agency=${encodeURIComponent('司法部、中国人民银行、金融监管总局、中国证监会、国家外汇局')}`,
    );
    assert.deepEqual(listOrder(joint), [TITLES.jingrong], '联合发布机关为完整前缀');

    const minban = await fetchHome(`/?agency=${encodeURIComponent('生态环境部办公厅')}`);
    assert.deepEqual(listOrder(minban), [TITLES.shuiyuan, TITLES.haiyu], 'xxgk 模板机关取「发布机关」字段');

    const bu = await fetchHome(`/?agency=${encodeURIComponent('生态环境部')}`);
    assert.deepEqual(listOrder(bu), [TITLES.hedian], 'hdjl 模板机关取列表层常量，与办公厅精确区分');
  });

  it('按关键词过滤：标题命中（道路交通安全法）与正文命中（人大正文特征串 / 海洋生态环境）', async () => {
    const titleHit = await fetchHome(`/?q=${encodeURIComponent('道路交通安全法')}`);
    assert.deepEqual(listOrder(titleHit), [TITLES.npc2], '标题包含匹配应命道路交通安全法');

    const bodyHit1 = await fetchHome(`/?q=${encodeURIComponent('社会公众可以直接登录中国人大网')}`);
    assert.deepEqual(
      listOrder(bodyHit1),
      [TITLES.npc1, TITLES.npc2, TITLES.npc3],
      '该特征串只出现在 npc 正文（标题不含）',
    );

    const bodyHit2 = await fetchHome(`/?q=${encodeURIComponent('海洋生态环境保护')}`);
    assert.deepEqual(listOrder(bodyHit2), [TITLES.haiyu], '该串只出现在 mee 近岸海域条目正文');
  });

  it('组合过滤：领域 + 机关、领域 + 关键词叠加生效', async () => {
    const categoryAgency = await fetchHome(
      `/?category=${encodeURIComponent('生态环境')}&agency=${encodeURIComponent('生态环境部办公厅')}`,
    );
    assert.deepEqual(
      listOrder(categoryAgency),
      [TITLES.shuiyuan, TITLES.haiyu],
      '生态环境 × 生态环境部办公厅应只含两条 xxgk 条目（核动力厂机关的机关是部本级）',
    );

    const categoryKeyword = await fetchHome(
      `/?category=${encodeURIComponent('生态环境')}&q=${encodeURIComponent('核动力厂')}`,
    );
    assert.deepEqual(listOrder(categoryKeyword), [TITLES.hedian]);
    // 领域经隐藏字段保留在表单内
    assert.match(categoryKeyword, /<input type="hidden" name="category" value="生态环境"/);

    const combinedNone = await fetchHome(
      `/?category=${encodeURIComponent('生态环境')}&q=${encodeURIComponent('金融法')}`,
    );
    assert.match(combinedNone, /data-testid="notice-empty-state"/, '组合无结果应展示空态');
    assert.match(combinedNone, /没有符合筛选条件的公示/);
    assert.match(combinedNone, /data-testid="filter-clear-empty"/, '空态应提供清除全部筛选入口');
  });

  it('关键词无结果：空态 + 计数为 0 + 清除筛选入口', async () => {
    const html = await fetchHome(`/?q=${encodeURIComponent('区块链')}`);
    assert.match(html, /data-testid="notice-empty-state"/);
    assert.match(html, /data-testid="filter-result-count"[^>]*>筛选后共 0 条/);
    assert.equal(extractNoticeItems(html).length, 0);
    assert.match(html, /data-testid="filter-clear"/);
  });

  it('筛选不影响倒计时排序：过滤结果始终是未筛选倒计时顺序的子序列', async () => {
    const full = listOrder(await fetchHome('/'));
    assert.deepEqual(full, EXPECTED_FULL_ORDER, '未筛选列表应为倒计时顺序');

    for (const query of [
      `/?category=${encodeURIComponent('立法与司法')}`,
      `/?agency=${encodeURIComponent('司法部')}`,
      `/?q=${encodeURIComponent('征求意见')}`,
      `/?category=${encodeURIComponent('立法与司法')}&agency=${encodeURIComponent('司法部')}`,
    ]) {
      assertSubsequence(listOrder(await fetchHome(query)), EXPECTED_FULL_ORDER, `筛选 ${query} 后`);
    }
  });
});
