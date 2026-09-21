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
 * E2E（issue #31）：搜索结果的分页与「共 N 条」必须如实。
 *
 * ## 线上现场
 *
 * 搜「征求意见」时结果页写「共 50 条」并渲染 50 条 —— 而索引里真实命中 **176** 条
 * （Meilisearch `totalHits`）。结果页把「本页条数」当成了总数，且硬编码单页 50 条，
 * 于是第 50 条之后的 126 条**从搜索完全不可达**。首页 issue #19 修过同一类缺陷
 * （把截断结果当全量），搜索页当时漏了。
 *
 * ## 本场景锁定的性质
 *
 * 用 `SEARCH_PAGE_SIZE=3`（每页 3 条，可运维调参）让分页在小 fixture 上也真的翻起来：
 *
 * 1. 「共 N 条」是**命中总数**而不是本页条数（N 大于每页条数）；
 * 2. 翻遍所有页取并集：条目数恰好等于 N、**无重复、无遗漏**（自校验，不依赖写死数字）；
 * 3. 每页条数与范围文案一致（第 1–3 条 / 第 4–6 条…），末页是余数；
 * 4. 越界页（`?page=999`）回落到末页而不是空页；
 * 5. 翻页链接保留关键词（不带 q 的翻页会掉到「未带关键词」的重定向）；
 * 6. 命中不足一页时不渲染翻页条。
 *
 * fixture 用 `fixtures/e2e-sources`（M2 四源 + 工信部，共 24 条），检索走 local
 * SearchPort（SQLite FTS5，ADR-0001 第 2 条）。全程零外部依赖。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhurenweng-e2e-searchpage-'));
const dbFile = path.join(workDir, 'app.db');
const fixturesDir = path.join(repoRoot, 'fixtures', 'e2e-sources');

/** 每页条数（测试注入 SEARCH_PAGE_SIZE，让小 fixture 也能翻好几页） */
const PER_PAGE = 3;
/** 覆盖绝大多数条目标题的宽泛关键词 */
const QUERY = '征求意见';

let app;
let fixtures;
let fixtureUrl;

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

/** 结果页 HTML → 条目块列表。 */
function extractNoticeItems(html) {
  return [...html.matchAll(/<li[^>]*data-testid="notice-item"[^>]*>[\s\S]*?<\/li>/g)].map(
    (match) => match[0],
  );
}

/** 结果页 HTML → 条目详情链接（去重前，用于查重）。 */
function itemHrefs(html) {
  return extractNoticeItems(html).map(
    (item) => (/href="(\/notices\/[0-9a-f]+)"/.exec(item) ?? [])[1] ?? '',
  );
}

/** 「共 N 条」里的 N。 */
function totalFrom(html) {
  const text = (/data-testid="search-result-count"[^>]*>([^<]*)/.exec(html) ?? [])[1] ?? '';
  const total = /共 (\d+) 条/.exec(text)?.[1];
  assert.ok(total !== undefined, `结果页应给出总数，实际文案：${text}`);
  return Number(total);
}

/** 「第 X / Y 页」里的 [X, Y]；无翻页条时返回 null。 */
function pageStatus(html) {
  const text = (/data-testid="search-pagination-status"[^>]*>([^<]*)/.exec(html) ?? [])[1];
  if (text === undefined) return null;
  const match = /第 (\d+) \/ (\d+) 页/.exec(text);
  assert.ok(match, `翻页状态文案异常：${text}`);
  return [Number(match[1]), Number(match[2])];
}

/** 「（第 a–b 条）」里的 [a, b]；单页时页面不渲染该行，返回 null。 */
function rangeText(html) {
  return (/data-testid="search-range"[^>]*>([^<]*)/.exec(html) ?? [])[1] ?? null;
}

/** 下一页链接（相对地址）；末页返回 null。 */
function nextHref(html) {
  // 属性顺序不固定（href 在 data-testid 之前），先取整个 <a> 标签再抠 href；
  // 属性值里的 `&` 会被 React 转义成 `&amp;`（不还原就会把 page 参数发成 amp;page，
  // 翻页原地不动 —— 第一次跑本测试就是这么挂的）
  const tag = /<a[^>]*data-testid="search-pagination-next"[^>]*>/.exec(html)?.[0];
  if (tag === undefined) return null;
  const href = /href="([^"]+)"/.exec(tag)?.[1] ?? null;
  return href === null ? null : href.replaceAll('&amp;', '&');
}

async function fetchSearch(search) {
  const response = await fetch(`${app.url}/search?${search}`);
  assert.equal(response.status, 200, `结果页应 200：${search}`);
  return stripSsrComments(await response.text());
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
      SEARCH_PAGE_SIZE: String(PER_PAGE),
    },
  });
});

after(async () => {
  await app?.stop();
  await fixtures?.stop();
});

describe('issue #31：搜索结果总数与分页', () => {
  let firstPage;
  let total;

  it('抓取并建索引（5 个源 24 条）', async () => {
    const run = await runWorkerOnce();
    assert.equal(run.code, 0, `worker 应正常退出：${run.output}`);
    assert.match(run.output, /检索索引重建完成：24 条（provider=local）/);
  });

  it('「共 N 条」是命中总数，不是本页条数（N 大于每页条数）', async () => {
    firstPage = await fetchSearch(new URLSearchParams({ q: QUERY }).toString());
    total = totalFrom(firstPage);

    const items = extractNoticeItems(firstPage);
    assert.equal(items.length, PER_PAGE, `第 1 页应恰好 ${PER_PAGE} 条`);
    assert.ok(
      total > PER_PAGE,
      `总数应大于每页条数（否则分页无从验证），实际：共 ${total} 条 / 每页 ${PER_PAGE} 条`,
    );
    assert.deepEqual(pageStatus(firstPage), [1, Math.ceil(total / PER_PAGE)]);
    assert.match(rangeText(firstPage) ?? '', /第 1–3 条/);
  });

  it('翻遍所有页：条目并集恰好等于总数，无重复、无遗漏', async () => {
    const seen = [];
    let html = firstPage;
    let guard = 0;
    for (;;) {
      seen.push(...itemHrefs(html));
      const next = nextHref(html);
      if (next === null) break;
      // 翻页链接必须保留关键词，否则会掉到「未带关键词」的重定向
      assert.match(next, /^\/search\?/, `翻页链接应是结果页地址：${next}`);
      assert.ok(
        new URLSearchParams(next.split('?')[1]).get('q') === QUERY,
        `翻页链接应保留关键词：${next}`,
      );
      guard += 1;
      assert.ok(guard <= 20, '翻页不应超过 20 页（防死循环）');
      const response = await fetch(`${app.url}${next}`);
      assert.equal(response.status, 200);
      html = stripSsrComments(await response.text());
    }

    assert.equal(seen.length, total, `所有页的条目数应等于总数 ${total}`);
    assert.equal(new Set(seen).size, total, '同一条目不应在分页里重复出现');
    assert.ok(seen.every((href) => href !== ''), '每个条目都应有详情链接');
    // 末页是余数：总数对每页条数取模（整除时末页满页）
    const lastPageCount = total % PER_PAGE === 0 ? PER_PAGE : total % PER_PAGE;
    const lastPageItems = extractNoticeItems(html);
    assert.equal(lastPageItems.length, lastPageCount, '末页条数应为余数');
    assert.deepEqual(pageStatus(html), [Math.ceil(total / PER_PAGE), Math.ceil(total / PER_PAGE)]);
    assert.match(html, /data-testid="search-pagination-next-disabled"/, '末页不应有下一页链接');
  });

  it('每页的条目互不相同且范围文案与页码一致', async () => {
    const page2 = await fetchSearch(new URLSearchParams({ q: QUERY, page: '2' }).toString());
    assert.deepEqual(pageStatus(page2), [2, Math.ceil(total / PER_PAGE)]);
    assert.match(rangeText(page2) ?? '', new RegExp(`第 ${PER_PAGE + 1}–${PER_PAGE * 2} 条`));

    const page1Hrefs = itemHrefs(firstPage);
    const page2Hrefs = itemHrefs(page2);
    assert.equal(page2Hrefs.length, PER_PAGE);
    assert.ok(
      page2Hrefs.every((href) => !page1Hrefs.includes(href)),
      '第 2 页不应重复第 1 页的条目',
    );
    assert.match(page2, /data-testid="search-pagination-prev"/, '第 2 页应有上一页链接');
  });

  it('越界页回落到末页，而不是空页', async () => {
    const outOfRange = await fetchSearch(new URLSearchParams({ q: QUERY, page: '999' }).toString());
    const totalPages = Math.ceil(total / PER_PAGE);
    assert.deepEqual(pageStatus(outOfRange), [totalPages, totalPages], '应回落到末页');
    assert.equal(extractNoticeItems(outOfRange).length > 0, true, '末页应有条目');
    assert.doesNotMatch(outOfRange, /data-testid="search-empty-state"/);
  });

  it('命中不足一页时不渲染翻页条', async () => {
    // 「教师」只命中教育部两条（教师法修订草案 + 高校教师职称制度改革）
    const narrow = await fetchSearch(new URLSearchParams({ q: '教师' }).toString());
    const narrowTotal = totalFrom(narrow);
    assert.ok(narrowTotal > 0 && narrowTotal <= PER_PAGE, `应命中少数条目，实际：${narrowTotal}`);
    assert.equal(pageStatus(narrow), null, '单页结果不应渲染翻页条');
    assert.equal(rangeText(narrow), null, '单页结果不渲染范围行');
  });
});
