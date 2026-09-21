import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildFts5MatchQuery,
  hasSearchableQuery,
  toCjkSpacedText,
} from '../../src/lib/search/search-text.ts';
import { MeilisearchSearch } from '../../src/lib/search/meilisearch-search.ts';

/**
 * 单元：检索查询的归一化与两条路径的同口径（issue #32）。
 *
 * ## 线上现场
 *
 * 搜「《》」「---」「。。。」这类**纯标点**查询时，结果页写「共 178 条，按相关度排序」——
 * 整库都被当成命中。原因在 Meilisearch 侧：查询里没有任何可检索词元时它按空查询处理，
 * 于是返回全部文档。而本地 FTS5 路径对同样输入返回 0 条（`buildFts5MatchQuery` → null），
 * **两条路径给出相反答案**，e2e 又只跑本地路径，于是这个缺陷在测试里看不见。
 *
 * 这里钉死三件事：
 * 1. `hasSearchableQuery` 的判据（汉字 / 字母 / 数字才算词元；标点、空白、全角标点都不算）；
 * 2. 适配器对无词元查询**在发请求之前就短路**（假 fetch 记录调用次数，断言为 0）——
 *    这是本缺陷的红色断言：旧代码会照发请求并把整库结果带回来；
 * 3. 有词元查询的请求形状与响应映射（page/hitsPerPage + totalHits → total），
 *    顺带把 issue #31 的契约钉在单测层。
 *
 * 全程零网络：假 fetch 断言请求，固定响应断言解析（与 LLM 适配器单测同一套路数）。
 */

/** 最小 Response 替身（适配器只用到 ok / status / json() / text()）。 */
function fakeResponse({ ok = true, status = 200, payload = {} } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/** 记录请求的假 fetch。 */
function recordingFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  impl.calls = calls;
  return impl;
}

const CONFIG = {
  host: 'http://meili.invalid:7700',
  indexUid: 'notices',
  taskTimeoutMs: 1000,
};

describe('issue #32：无词元查询（纯标点）', () => {
  const UNUSABLE = ['《》', '（）', '。。。', '---', '、，。', '＊', '...', '——', '·', '   ', ''];

  it('hasSearchableQuery：标点 / 空白不算词元，汉字、字母、数字算', () => {
    for (const query of UNUSABLE) {
      assert.equal(hasSearchableQuery(query), false, `「${query}」不该被当成可检索查询`);
    }
    for (const query of ['未成年', 'app', '2026', '30日', 'App', '医疗保障 监督检查', 'a《b》']) {
      assert.equal(hasSearchableQuery(query), true, `「${query}」应被当成可检索查询`);
    }
    // 判据要能被反复调用（/g 正则的 lastIndex 陷阱回归锚点）
    for (let i = 0; i < 3; i += 1) {
      assert.equal(hasSearchableQuery('未成年'), true, `第 ${i + 1} 次调用仍应为 true`);
      assert.equal(hasSearchableQuery('《》'), false, `第 ${i + 1} 次调用仍应为 false`);
    }
  });

  it('本地 FTS5 表达式：纯标点不产生 MATCH 表达式（与适配器同口径）', () => {
    for (const query of UNUSABLE) {
      assert.equal(buildFts5MatchQuery(query), null, `「${query}」不应产生 MATCH 表达式`);
    }
    // 多段查询：隐式 AND，汉字按字拆短语、英文走前缀
    assert.equal(buildFts5MatchQuery('医疗保障 监督检查'), '"医 疗 保 障" "监 督 检 查"');
    assert.equal(buildFts5MatchQuery('health'), '"health" *');
    assert.equal(buildFts5MatchQuery('未成年人 pdf'), '"未 成 年 人" "pdf" *');
    // 索引侧变换：汉字与字母数字交界处插空格，含数字的中文短语才能子串命中
    assert.equal(toCjkSpacedText('前门西大街1号'), '前 门 西 大 街 1 号');
  });

  it('Meilisearch 适配器：无词元查询不联网，直接返回零命中', async () => {
    const fetchImpl = recordingFetch(fakeResponse({ payload: { hits: [], totalHits: 178 } }));
    const port = new MeilisearchSearch({ ...CONFIG, fetchImpl });

    for (const query of ['《》', '---', '。。。']) {
      const result = await port.search(query, { page: 1, perPage: 50 });
      assert.deepEqual(result, { total: 0, hits: [] }, `「${query}」应零命中`);
    }
    assert.equal(
      fetchImpl.calls.length,
      0,
      '无词元查询不应发出任何请求（旧实现会把整库结果带回来）',
    );
  });

  it('有词元查询：请求形状与响应映射（page/hitsPerPage + 精确 totalHits）', async () => {
    const fetchImpl = recordingFetch(
      fakeResponse({
        payload: {
          hits: [
            { id: 'a'.repeat(16), title: '标题一' },
            { id: 'b'.repeat(16), title: '标题二' },
            { id: 42, title: 'id 不是字符串' },
            null,
          ],
          totalHits: 176,
          totalPages: 4,
        },
      }),
    );
    const port = new MeilisearchSearch({ ...CONFIG, fetchImpl });
    const result = await port.search('征求意见', { page: 2, perPage: 50 });

    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0];
    assert.equal(url, 'http://meili.invalid:7700/indexes/notices/search');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.equal(body.q, '征求意见');
    assert.equal(body.page, 2);
    assert.equal(body.hitsPerPage, 50);
    // total 取精确 totalHits，而不是本页条数（issue #31）
    assert.equal(result.total, 176);
    assert.deepEqual(
      result.hits.map((hit) => hit.id),
      ['a'.repeat(16), 'b'.repeat(16)],
      '形状异常的命中应被丢掉而不是让整页崩掉',
    );
  });
});
