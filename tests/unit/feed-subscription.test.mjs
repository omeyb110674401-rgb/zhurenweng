import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FEED_DESCRIPTION,
  FEED_TITLE,
  buildFeedXml,
  escapeXml,
  feedChannelDescription,
  feedChannelTitle,
} from '../../src/lib/feed.ts';

/**
 * 单元（issue #63）：子 feed 的频道说明与转义。
 *
 * 为什么单挑这几件出来：feed 没有页面上下文，读者在阅读器里能看到的**只有频道标题与描述**。
 * 一份「只看未截止的生态环境」的订阅，如果频道名仍写着站点全名，两周后没人记得它装的是什么、
 * 更不知道它漏了什么 —— 这是"界面对自己说了什么"负责的那一类问题，而不是 XML 合法性问题。
 * 另一件是转义：条件文本来自 querystring（用户可控），它会出现在 `<title>` 与属性值里。
 */

/** 条目的最小形状（feed 只读这些字段；本文件是 .mjs，不引 TS 类型）。 */
function notice(over) {
  return {
    id: 'f'.repeat(32),
    sourceId: 'unit',
    title: '一条公示',
    agency: '测试机关',
    url: 'https://source.test/x.html',
    publishedAt: '2026-09-01',
    deadlineAt: '2026-10-01',
    status: 'open',
    categoryTags: [],
    bodyText: '',
    attachments: [],
    aiSummary: null,
    summaryModel: null,
    fetchedAt: '2026-09-01T00:00:00.000Z',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    outboundClicks: 0,
    versionOf: null,
    versionSeq: null,
    ...over,
  };
}

const NOW = new Date('2026-09-24T00:00:00.000Z');

describe('issue #63：频道标题与描述', () => {
  it('无条件的全量 feed 沿用原有文案（既有订阅地址上的说明不该变）', () => {
    assert.equal(feedChannelTitle(), FEED_TITLE);
    assert.equal(feedChannelDescription(), FEED_DESCRIPTION);
    assert.equal(feedChannelTitle(undefined), FEED_TITLE);
  });

  it('带条件时标题给出条件，描述说明这是子 feed 并指回全量地址', () => {
    const label = '生态环境 · 只看未截止';
    assert.equal(feedChannelTitle(label), `${FEED_TITLE} —— ${label}`);
    const description = feedChannelDescription(label);
    assert.match(description, new RegExp(label));
    assert.match(description, /子 feed/);
    assert.match(description, /\/feed\.xml/, '要给出全量订阅的地址');
  });
});

describe('issue #63：buildFeedXml 的 channel 与转义', () => {
  it('条件写进频道标题：feed 里读者能看到的说明只有这一处', () => {
    const xml = buildFeedXml({
      siteUrl: 'https://zw.test',
      notices: [],
      now: NOW,
      filterLabel: '只看未截止',
    });
    assert.equal(/<channel>\s*<title>([^<]*)<\/title>/.exec(xml)?.[1], `${FEED_TITLE} —— 只看未截止`);
    assert.match(/<description>([^<]*)<\/description>/.exec(xml)?.[1] ?? '', /子 feed/);
  });

  it('self 用调用方给的地址（含条件），缺省指回 /feed.xml', () => {
    const xml = buildFeedXml({
      siteUrl: 'https://zw.test',
      notices: [],
      now: NOW,
      selfUrl: 'https://zw.test/feed.xml?open=1',
    });
    assert.match(xml, /<atom:link href="https:\/\/zw\.test\/feed\.xml\?open=1" rel="self"/);
    const plain = buildFeedXml({ siteUrl: 'https://zw.test', notices: [], now: NOW });
    assert.match(plain, /href="https:\/\/zw\.test\/feed\.xml"/);
  });

  it('条件文本按 XML 实体转义（它来自 querystring，是用户可控输入）', () => {
    const label = '关键词：《x&y<z»';
    const xml = buildFeedXml({
      siteUrl: 'https://zw.test',
      notices: [],
      now: NOW,
      filterLabel: label,
    });
    assert.ok(xml.includes(`<title>${escapeXml(`${FEED_TITLE} —— ${label}`)}</title>`));
    const withoutEntities = xml.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
    assert.ok(!withoutEntities.includes('&'), '剥离合法实体后不应残留裸 &');
  });

  it('筛选后 0 条也生成结构合法的 feed（空集合不是错误）', () => {
    const xml = buildFeedXml({
      siteUrl: 'https://zw.test',
      notices: [],
      now: NOW,
      filterLabel: '关键词：不存在的词',
    });
    assert.match(xml, /<rss version="2\.0"/);
    assert.match(xml, /<\/channel>\s*<\/rss>/);
    assert.ok(!xml.includes('<item>'), '无条目时不该出现 item');
  });

  it('有条目时 guid / link / pubDate 照常，条件不改条目内容', () => {
    const xml = buildFeedXml({
      siteUrl: 'https://zw.test/',
      notices: [notice({})],
      now: NOW,
      filterLabel: '只看未截止',
    });
    assert.ok(xml.includes(`<guid isPermaLink="false">${'f'.repeat(32)}</guid>`));
    assert.ok(xml.includes('<link>https://zw.test/notices/' + 'f'.repeat(32) + '</link>'));
    assert.match(xml, /<pubDate>Tue, 01 Sep 2026 00:00:00 GMT<\/pubDate>/);
  });
});
