import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEED_MAX_ITEMS, buildFeedXml } from '../../src/lib/feed.ts';
import {
  FEED_NEWHOOD_SAMPLE,
  auditRssFeed,
  feedExpectedIds,
  parseFeedSample,
  rssFeedHealth,
} from '../../src/lib/pipeline-health.ts';

/**
 * 单元（issue #75）：RSS 这条读者入口的判据。
 *
 * RSS 与检索同族 —— 端点 200、XML 也打得开，只是里面少了一批条目或链接指向了别的域名：
 * 页面全绿，读者少东西。要钉住的是"探针没取到就不算通过""feed 落后于库要翻红"这两件事。
 * 样本刻意用**真正的生成器** `buildFeedXml` 产出来再解析回去（生成与解析必须对得上，
 * 否则线上一次格式调整会让探针自己先红），只有坏样本才手写。
 */

const SITE = 'https://cn101.top';

function record(id, publishedAt = '2026-09-01') {
  return {
    id,
    title: `公示 ${id}`,
    agency: '某部',
    url: `https://gov.example/n/${id}`,
    publishedAt,
    deadlineAt: null,
    aiSummary: null,
  };
}

function feedOf(records, siteUrl = SITE) {
  return buildFeedXml({ siteUrl, notices: records, now: new Date('2026-09-25T00:00:00Z') });
}

async function probeWith(xml, records, options = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(xml, {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    });
  try {
    return await auditRssFeed({
      url: options.url ?? `${SITE}/feed.xml`,
      siteBase: options.siteBase ?? SITE,
      records,
      maxItems: FEED_MAX_ITEMS,
    });
  } finally {
    globalThis.fetch = original;
  }
}

describe('issue #75：feed 解析与比对口径', () => {
  it('真生成器产出的 feed 能被探针读回同一批 guid、链接与 pubDate', () => {
    const sample = parseFeedSample(feedOf([record('a'), record('b'), record('c')]));
    assert.equal(sample.malformed, null);
    assert.deepEqual(
      sample.items.map((item) => item.guid),
      ['a', 'b', 'c'],
    );
    assert.equal(sample.items[0].link, `${SITE}/notices/a`);
    assert.equal(sample.items[0].pubDate, new Date('2026-09-01T00:00:00Z').toUTCString());
  });

  it('未配对的 item、裸 &、控制字符各判结构不对', () => {
    assert.match(
      parseFeedSample('<rss><channel><item></channel></rss>').malformed,
      /开合不配对/,
    );
    assert.match(
      parseFeedSample('<rss><channel>Tom & Jerry</channel></rss>').malformed,
      /没转义的/,
    );
    // 这条不是假想：生成器只转义 &<>"'，标题里混进控制字符就会原样写进 XML
    const withControl = feedOf([record('a')]).replace('公示 a', `公示\u0007a`);
    assert.match(parseFeedSample(withControl).malformed, /控制字符/);
    assert.equal(parseFeedSample('<rss><channel>&amp; &#8212; &apos;</channel></rss>').malformed, null);
  });

  it('库内条目未超上限 ⇒ 全量都该在 feed 里；超了 ⇒ 只比对最新那 30 条', () => {
    const three = [record('a'), record('b'), record('c')];
    assert.deepEqual(feedExpectedIds(three, FEED_MAX_ITEMS), ['a', 'b', 'c']);

    const many = Array.from({ length: FEED_MAX_ITEMS + 50 }, (unused, index) =>
      record(
        `n${index}`,
        new Date(Date.UTC(2024, 0, 1) + index * 86_400_000).toISOString().slice(0, 10),
      ),
    );
    const expected = feedExpectedIds(many, FEED_MAX_ITEMS);
    assert.deepEqual(
      expected,
      Array.from({ length: FEED_NEWHOOD_SAMPLE }, (unused, index) => `n${many.length - 1 - index}`),
      '基数必须是发布日期最新的那一截（越新的条目越该在 feed 里）',
    );
    assert.ok(!expected.includes('n0'), '最旧的那条不该进比对基数');
  });
});

describe('issue #75：RSS 判据', () => {
  const base = {
    feed: { ok: true, sample: parseFeedSample(feedOf([record('a'), record('b')])) },
    missingIds: [],
    ghostIds: [],
    badLinks: [],
    dbCount: 2,
  };

  it('探针没取到 ⇒ unknown，detail 里带着没取到的原因', () => {
    const check = rssFeedHealth({ ...base, feed: { ok: false, error: '返回 502' } });
    assert.equal(check.verdict, 'unknown');
    assert.match(check.detail, /返回 502/);
    assert.match(check.detail, /不判健康/);
  });

  it('结构不对 / 空 feed / 缺条目 / ghost guid / 链接外站 ⇒ 各自翻红', () => {
    const broken = parseFeedSample('<rss><channel><item></channel></rss>');
    assert.equal(rssFeedHealth({ ...base, feed: { ok: true, sample: broken } }).verdict, 'fail');
    assert.equal(
      rssFeedHealth({ ...base, feed: { ok: true, sample: parseFeedSample(feedOf([])) } }).verdict,
      'fail',
    );
    assert.match(
      rssFeedHealth({ ...base, missingIds: ['zz'] }).detail,
      /库里有、feed 里没有 1 条/,
    );
    assert.equal(rssFeedHealth({ ...base, missingIds: ['zz'] }).verdict, 'fail');
    assert.equal(rssFeedHealth({ ...base, ghostIds: ['ghost'] }).verdict, 'fail');
    assert.equal(rssFeedHealth({ ...base, badLinks: ['http://evil.example/x'] }).verdict, 'fail');
  });

  it('全对得上 ⇒ ok，并且不假装做过 XML 校验', () => {
    const check = rssFeedHealth(base);
    assert.equal(check.verdict, 'ok');
    assert.match(check.detail, /启发式/);
  });
});

describe('issue #75：RSS 探针（取一次 + 比对）', () => {
  it('库与 feed 一致 ⇒ ok', async () => {
    const records = [record('a'), record('b'), record('c')];
    const { check, feedCount } = await probeWith(feedOf(records), records);
    assert.equal(check.verdict, 'ok');
    assert.equal(feedCount, 3);
  });

  it('feed 少了一条（库里在、feed 里没有）⇒ fail 且指名是哪条', async () => {
    const records = [record('a'), record('b'), record('c')];
    const { check, missingIds } = await probeWith(feedOf([record('a'), record('b')]), records);
    assert.equal(check.verdict, 'fail');
    assert.deepEqual(missingIds, ['c']);
  });

  it('SITE_URL 漂移成别的宿主 ⇒ fail（读者点进去就是死链）', async () => {
    const records = [record('a')];
    const { check, badLinks } = await probeWith(feedOf(records, 'http://localhost:3000'), records);
    assert.equal(check.verdict, 'fail');
    assert.deepEqual(badLinks, ['http://localhost:3000/notices/a']);
  });

  it('端点报错 ⇒ unknown；没有可取地址也 ⇒ unknown', async () => {
    const records = [record('a')];
    const failing = await probeWith(feedOf(records), records, { status: 500 });
    assert.equal(failing.check.verdict, 'unknown');
    assert.match(failing.check.detail, /返回 500/);

    const noUrl = await probeWith(feedOf(records), records, { url: '' });
    assert.equal(noUrl.check.verdict, 'unknown');
    assert.match(noUrl.check.detail, /没有可取的地址/);
  });
});
