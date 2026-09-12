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
 *   worker 单轮抓取三源（npc / moj / govcn，跨源去重后 9 条）
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
  yibao: '中华人民共和国医疗保障法（草案征求意见稿）征求意见',
  park: '中华人民共和国国家公园法（草案二次审议稿）征求意见',
  fishery: '中华人民共和国渔业法（修订草案）征求意见',
  tiaojie: '司法部关于《中华人民共和国人民调解法（修订草案）》征求意见的通知',
  gongzheng: '司法部关于《中华人民共和国公证法（修订草案）》公开征求意见的通知',
  wenhua: '司法部关于《中华人民共和国历史文化遗产保护法（草案征求意见稿）》公开征求意见的通知',
  zhongcai: '司法部关于《中华人民共和国仲裁法（修订草案）》公开征求意见的通知',
  xinyong:
    '国家发展改革委关于《中华人民共和国社会信用体系建设法（草案征求意见稿）》公开征求意见的通知',
  tielu:
    '国家铁路局关于《铁路交通事故应急救援和调查处理条例（修订草案征求意见稿）》公开征求意见的通知',
};

/**
 * 每条 fixture 条目的期望领域标签（src/lib/categories.ts 关键词规则的预期结果）。
 * yibao / zhongcai / tielu / gongzheng / tiaojie / xinyong = 标题（及正文）命中；
 * park = 仅正文命中（标题无任何领域词，正文「生态」「自然保护地」命中生态环境）；
 * fishery / wenhua = 标题与正文均无关键词命中 → 不打标签。
 */
const EXPECTED_TAGS = {
  [TITLES.yibao]: ['医疗卫生'],
  [TITLES.park]: ['生态环境'],
  [TITLES.fishery]: [],
  [TITLES.tiaojie]: ['立法与司法'],
  [TITLES.gongzheng]: ['立法与司法'],
  [TITLES.wenhua]: [],
  [TITLES.zhongcai]: ['立法与司法'],
  [TITLES.xinyong]: ['市场监管'],
  [TITLES.tielu]: ['交通运输'],
};

/** 库内去重后的全部发布机关（= 机关下拉选项，按名称排序前的全集） */
const AGENCIES = [
  '全国人民代表大会常务委员会法制工作委员会',
  '司法部',
  '司法部立法一局',
  '司法部立法三局',
  '国家发展改革委',
  '国家铁路局',
];

/** 未筛选列表的期望倒计时顺序：征求意见中按截止日期升序，已截止沉底。 */
const EXPECTED_FULL_ORDER = [
  TITLES.tielu, // +12
  TITLES.zhongcai, // +18
  TITLES.yibao, // +21
  TITLES.gongzheng, // +22
  TITLES.xinyong, // +26
  TITLES.tiaojie, // +30
  TITLES.wenhua, // +44
  TITLES.park, // +45
  TITLES.fishery, // 已截止（{{CN_DATE-10}}），沉底
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
    assert.match(run.output, /源 govcn 抓取完成/);

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

  it('按领域过滤：标题命中打标的「医疗卫生」只含医疗保障法，激活态正确', async () => {
    const html = await fetchHome(`/?category=${encodeURIComponent('医疗卫生')}`);
    assert.deepEqual(listOrder(html), [TITLES.yibao]);
    assert.match(html, /data-testid="filter-result-count"[^>]*>筛选后共 1 条/);
    assert.match(
      html,
      /data-testid="category-filter-link" aria-current="true"[^>]*>医疗卫生/,
      '激活态应落在医疗卫生标签上',
    );
    // 切换领域保留机关 / 关键词的入口仍在；标签云其余链接保持未激活
    assert.ok(!/aria-current="true"[^>]*>生态环境/.test(html));
  });

  it('按领域过滤：正文命中打标的「生态环境」含国家公园法；「立法与司法」含 3 条且保持倒计时顺序', async () => {
    const park = await fetchHome(`/?category=${encodeURIComponent('生态环境')}`);
    assert.deepEqual(listOrder(park), [TITLES.park], '国家公园法应由正文关键词命中打标为生态环境');

    const lijisifa = await fetchHome(`/?category=${encodeURIComponent('立法与司法')}`);
    assert.deepEqual(listOrder(lijisifa), [TITLES.zhongcai, TITLES.gongzheng, TITLES.tiaojie]);
    assert.match(lijisifa, /data-testid="filter-result-count"[^>]*>筛选后共 3 条/);
  });

  it('按发布机关过滤：精确匹配（司法部 ≠ 司法部立法一局/三局），顺序保持', async () => {
    const html = await fetchHome(`/?agency=${encodeURIComponent('司法部')}`);
    assert.deepEqual(listOrder(html), [TITLES.zhongcai, TITLES.wenhua]);
    assert.match(html, /data-testid="filter-result-count"[^>]*>筛选后共 2 条/);

    const yijv = await fetchHome(`/?agency=${encodeURIComponent('司法部立法一局')}`);
    assert.deepEqual(listOrder(yijv), [TITLES.tiaojie], '机关精确匹配不误伤「司法部」前缀机关');
  });

  it('按关键词过滤：标题命中（国家公园法）与正文命中（监督检查 / 失信惩戒）', async () => {
    const titleHit = await fetchHome(`/?q=${encodeURIComponent('国家公园法')}`);
    assert.deepEqual(listOrder(titleHit), [TITLES.park], '标题包含匹配应命中国家公园法');

    const bodyHit1 = await fetchHome(`/?q=${encodeURIComponent('监督检查')}`);
    assert.deepEqual(listOrder(bodyHit1), [TITLES.yibao], '「监督检查」只出现在医疗保障法正文');

    const bodyHit2 = await fetchHome(`/?q=${encodeURIComponent('失信惩戒')}`);
    assert.deepEqual(listOrder(bodyHit2), [TITLES.xinyong], '「失信惩戒」只出现在社会信用体系建设法正文');
  });

  it('组合过滤：领域 + 机关、领域 + 关键词叠加生效', async () => {
    const categoryAgency = await fetchHome(
      `/?category=${encodeURIComponent('立法与司法')}&agency=${encodeURIComponent('司法部')}`,
    );
    assert.deepEqual(
      listOrder(categoryAgency),
      [TITLES.zhongcai],
      '立法与司法 × 司法部应只含仲裁法（公证/调解机关为司局级）',
    );

    const categoryKeyword = await fetchHome(
      `/?category=${encodeURIComponent('医疗卫生')}&q=${encodeURIComponent('医疗保障')}`,
    );
    assert.deepEqual(listOrder(categoryKeyword), [TITLES.yibao]);
    // 领域经隐藏字段保留在表单内
    assert.match(categoryKeyword, /<input type="hidden" name="category" value="医疗卫生"/);

    const combinedNone = await fetchHome(
      `/?category=${encodeURIComponent('医疗卫生')}&q=${encodeURIComponent('仲裁')}`,
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
