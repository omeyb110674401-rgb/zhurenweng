import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildNoticeJsonLd, serializeJsonLd } from '../../src/lib/notice-jsonld.ts';

/**
 * 单元：详情页 schema.org JSON-LD（issue #39）。
 *
 * 结构化数据是给机器读的「页面说明书」，两类错误最要命：
 *
 * 1. **说错**（把页面说成它不是的东西）：所以锁死 @type=Article、法规用
 *    about: Legislation、截止日期同时给 expires 与 additionalProperty；
 * 2. **说空**：取不到的字段必须**整个属性省略**。写 null 或空串会让消费方读成
 *    「已知为空」（例如「该公示没有截止日期」），比缺属性更糟。
 *
 * 另有安全性质：标题 / 正文摘自政府页面，出现 `</script>` 会提前闭合脚本块，
 * 序列化必须把 `<` 转义掉。
 */

/** 一条完整条目（只覆盖断言关心的字段，其余给中性值）。 */
function noticeRecord(overrides = {}) {
  return {
    id: 'a1b2c3d4',
    sourceId: 'mot',
    title: '交通运输部关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知',
    agency: '交通运输部',
    url: 'https://www.mot.gov.cn/zhengcejiedu/202609/t20260907_123456.html',
    publishedAt: '2026-09-07',
    deadlineAt: '2026-09-24',
    status: 'open',
    categoryTags: ['交通运输'],
    bodyText: '现向社会公开征求意见。',
    attachments: [],
    aiSummary: null,
    summaryModel: null,
    fetchedAt: '2026-09-20T03:00:00.000Z',
    outboundClicks: 3,
    versionOf: null,
    versionSeq: null,
    ...overrides,
  };
}

const SITE = 'https://cn101.top';

describe('issue #39：详情页 JSON-LD', () => {
  it('完整条目：字段齐备且口径正确（Article + 法规 + 截止日期 + 原文出处）', () => {
    const doc = buildNoticeJsonLd({
      notice: noticeRecord(),
      siteUrl: SITE,
      description: '征求意见中 · 截止 2026-09-24。现向社会公开征求意见。',
    });

    assert.equal(doc['@context'], 'https://schema.org');
    assert.equal(doc['@type'], 'Article', '本页是文档页，不是 Event / GovernmentService');
    assert.equal(doc.headline, noticeRecord().title);
    assert.equal(doc.url, `${SITE}/notices/a1b2c3d4`, 'url 指向本站条目页（canonical 口径）');
    assert.equal(doc.inLanguage, 'zh-CN');
    assert.equal(doc.datePublished, '2026-09-07');
    assert.equal(doc.creativeWorkStatus, '征求意见中');
    assert.deepEqual(doc.author, { '@type': 'Organization', name: '交通运输部' });
    assert.deepEqual(doc.publisher, { '@type': 'Organization', name: '主人翁', url: SITE });
    assert.equal(doc.isBasedOn, noticeRecord().url, 'isBasedOn = 官方原文页（聚合内容的出处）');
    assert.equal(doc.keywords, '交通运输');

    // 截止日期：标准属性 + 逐字属性各给一份
    assert.equal(doc.expires, '2026-09-24');
    assert.deepEqual(doc.additionalProperty, [
      { '@type': 'PropertyValue', name: '征求意见截止日期', value: '2026-09-24' },
    ]);

    // 征求意见针对的法规（标题里的《…》）
    assert.deepEqual(doc.about, [
      { '@type': 'Legislation', name: '《中华人民共和国公路法（修正草案征求意见稿）》' },
    ]);

    assert.equal(doc.description, '征求意见中 · 截止 2026-09-24。现向社会公开征求意见。');
  });

  it('取不到的字段整个属性省略（不写 null / 空串）', () => {
    const doc = buildNoticeJsonLd({
      notice: noticeRecord({
        title: '关于征求某标准意见的函', // 标题里没有《…》
        agency: '',
        publishedAt: null,
        deadlineAt: null,
        categoryTags: [],
      }),
      siteUrl: SITE,
    });

    for (const key of ['expires', 'additionalProperty', 'about', 'author', 'datePublished', 'keywords', 'description']) {
      assert.equal(key in doc, false, `「${key}」取不到时应整个省略，而不是写空值`);
    }
    // 与缺值无关的字段照常输出
    assert.equal(doc['@type'], 'Article');
    assert.equal(doc.headline, '关于征求某标准意见的函');
    assert.equal(doc.creativeWorkStatus, '征求意见中');
  });

  it('状态三态映射为页面同一套中文文案', () => {
    for (const [status, label] of [
      ['open', '征求意见中'],
      ['closed', '已截止'],
      ['resulted', '已出结果'],
    ]) {
      const doc = buildNoticeJsonLd({ notice: noticeRecord({ status }), siteUrl: SITE });
      assert.equal(doc.creativeWorkStatus, label, `status=${status} 应映射为「${label}」`);
    }
  });

  it('可传入展示用有效状态覆盖库内状态（issue #43：库内是每日一轮的快照）', () => {
    // 库内仍是 open（抓取时推导），但截止日已过 —— 页面与结构化数据必须同为「已截止」
    const doc = buildNoticeJsonLd({
      notice: noticeRecord({ status: 'open', deadlineAt: '2026-09-20' }),
      siteUrl: SITE,
      status: 'closed',
    });
    assert.equal(doc.creativeWorkStatus, '已截止');
    assert.equal(doc.expires, '2026-09-20', '截止日期照常给出，读者可自行核对');
    // 不传时按库内状态输出（向后兼容）
    const fallback = buildNoticeJsonLd({ notice: noticeRecord({ status: 'resulted' }), siteUrl: SITE });
    assert.equal(fallback.creativeWorkStatus, '已出结果');
  });

  it('标题含多个《…》时逐个列为 Legislation（草案 + 起草说明这类组合）', () => {
    const doc = buildNoticeJsonLd({
      notice: noticeRecord({
        title: '关于《中华人民共和国邮政法（修订草案征求意见稿）》《邮政法修订起草说明》公开征求意见的通知',
      }),
      siteUrl: SITE,
    });
    assert.deepEqual(doc.about, [
      { '@type': 'Legislation', name: '《中华人民共和国邮政法（修订草案征求意见稿）》' },
      { '@type': 'Legislation', name: '《邮政法修订起草说明》' },
    ]);
  });

  it('序列化转义 `<`：标题里的 </script> 不能提前闭合脚本块', () => {
    const evil = '关于《测试法》征求意见的通知</script><script>alert(1)</script>';
    const json = serializeJsonLd(
      buildNoticeJsonLd({ notice: noticeRecord({ title: evil }), siteUrl: SITE }),
    );

    assert.equal(json.includes('</script>'), false, '序列化结果不得含 </script>');
    assert.equal(json.includes('<'), false, '所有 `<` 都应写成 \\u003c');
    // 转义只影响字面写法，解析结果与原值完全一致
    assert.equal(JSON.parse(json).headline, evil);
  });
});
