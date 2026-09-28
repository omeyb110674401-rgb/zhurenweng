import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildQuotedSummary,
  normalizeChannels,
  parseQuotedSummary,
} from '../../src/lib/summary-content.ts';

/**
 * 单元：摘要落库形状（issue #55 的「参与导引」重构）。
 *
 * 钉住三件在重构里最容易出事的事：
 * 1. **旧形状的行必须还能解析** —— 全部重刷要跑两轮 worker、一个多小时，这期间存量
 *    58 条带的还是 五段式（有 keyPoints、没有新字段）。解析不了它们，页面上
 *    这 58 条会从「有摘要」掉回「待人工复核」占位，比字段少难看的多。
 * 2. **新字段缺省时不报错** —— 谁能提 / 逾期会两段是「原文有就写、没有就空」，
 *    渲染层按空段整段跳过。
 * 3. **引用与渠道的配对不能被去重打乱** —— normalizeChannels 会去空、去重、截断，
 *    引用必须在去重之前按原始下标配好，否则后面的渠道会挂上前面的引用。
 */

/** issue #55 之前的落库形状（五段式）：重刷期间仍会读到。 */
const LEGACY_SUMMARY = {
  what: { text: '旧：某征求意见稿', quote: '现向社会公开征求意见' },
  who: { text: '旧：社会公众', quote: null },
  keyPoints: [
    { text: '旧：公示期 30 日', quote: '征求意见期限为30日' },
    { text: '旧：可邮件反馈', quote: null },
  ],
  deadline: { text: '2026-10-07', quote: '截止日期为：2026年10月7日' },
  howToComment: { text: '旧：通过邮箱反馈', quote: '一、电子邮箱：a@b.gov.cn' },
};

describe('摘要形状：旧行向后兼容（重刷窗口内不得掉回占位）', () => {
  const parsed = parseQuotedSummary(LEGACY_SUMMARY);

  it('旧五段式仍可解析，keyPoints 原样带出', () => {
    assert.ok(parsed, '旧形状解析失败会让存量条目显示成「待人工复核」');
    assert.equal(parsed.keyPoints.length, 2);
    assert.equal(parsed.keyPoints[0].quote, '征求意见期限为30日');
  });

  it('新字段缺省为空段 / 空数组，而不是解析失败', () => {
    assert.equal(parsed.whoCanSubmit.text, '');
    assert.equal(parsed.whoCanSubmit.quote, null);
    assert.equal(parsed.afterDeadline.text, '');
    assert.deepEqual(parsed.channels, []);
  });

  it('必填两段仍然必填：缺任何一段就判为形状异常', () => {
    const { what: _what, ...withoutWhat } = LEGACY_SUMMARY;
    assert.equal(parseQuotedSummary(withoutWhat), null);
    assert.equal(parseQuotedSummary({ ...LEGACY_SUMMARY, howToComment: null }), null);
  });

  /*
   * 「影响谁」自 issue #56 第八节起是可缺段：整段缺失或没有 text 都解析成空段，
   * **不能**判成形状异常 —— 那会让详情页掉回「待人工复核」占位，
   * 而库里真有一批这种行（模型答不上时返回空串，重刷第一轮 15/50 条）。
   */
  it('影响谁整段缺失仍解析成功，该段为空', () => {
    const { who: _who, ...withoutWho } = LEGACY_SUMMARY;
    const parsedWithoutWho = parseQuotedSummary(withoutWho);
    assert.ok(parsedWithoutWho, '缺 who 不该判异常');
    assert.deepEqual(parsedWithoutWho.who, { text: '', quote: null });
    assert.equal(parseQuotedSummary({ ...LEGACY_SUMMARY, who: { quote: null } }).who.text, '');
  });

  /*
   * issue #85：「改动点」功能（`changes` / `changeMarkers` 两个键）已整体删除，
   * 而**生产库里那一批摘要还带着这两个键** —— 解析必须照常成功、只是不再把它们带出来。
   * 这是"删功能"最容易漏的一步：只删写入侧，读侧遇到多余的键就报形状异常，
   * 于是存量条目在页面上从「有摘要」掉回「待人工复核」占位，而没有任何东西会提醒你。
   */
  it('旧行带着已删除的改动点键也要能解析（键多余不是形状异常）', () => {
    const withDeadKeys = parseQuotedSummary({
      ...LEGACY_SUMMARY,
      changes: [{ clause: '第二条', kind: 'modify', text: '改了什么', quote: '第二条修改为甲' }],
      changeMarkers: { total: 7, byKind: { modify: 4, add: 1, delete: 2, renumber: 0 } },
    });
    assert.ok(withDeadKeys, '带已删除的键的行必须照常解析');
    assert.equal(withDeadKeys.keyPoints.length, 2, '其余字段一个都不能少');
    assert.ok(
      !Object.hasOwn(withDeadKeys, 'changes') && !Object.hasOwn(withDeadKeys, 'changeMarkers'),
      '删掉的功能不该从旧行里"复活"成解析结果的一部分',
    );
  });
});

describe('摘要形状：新输出 round-trip（build → 落库 → parse）', () => {
  const quoted = buildQuotedSummary(
    {
      what: '就机场运营许可规定征求意见',
      who: '运输机场运营人',
      whoCanSubmit: '社会各界均可',
      afterDeadline: '逾期不再受理',
      deadline: '2026-10-07',
      howToComment: '邮件或信函',
      channels: [
        { kind: 'email', value: 'a@b.gov.cn' },
        { kind: 'phone', value: '010-66010000' },
      ],
    },
    {
      what: '现公布如下，征求意见',
      who: '本规定适用于运输机场运营人',
      whoCanSubmit: '',
      afterDeadline: '逾期不再受理',
      deadline: '截止日期为2026年10月7日',
      howToComment: '一、电子邮箱：a@b.gov.cn',
      channels: ['一、电子邮箱：a@b.gov.cn', '二、传真：010-66010000'],
    },
  );
  const reread = parseQuotedSummary(JSON.parse(JSON.stringify(quoted)));

  it('落库再读回等价', () => {
    assert.deepEqual(reread, quoted);
  });

  it('渠道类型与引用逐项对上', () => {
    assert.deepEqual(
      quoted.channels.map((channel) => [channel.kind, channel.value, channel.quote]),
      [
        ['email', 'a@b.gov.cn', '一、电子邮箱：a@b.gov.cn'],
        ['phone', '010-66010000', '二、传真：010-66010000'],
      ],
    );
  });

  it('不带 quotes 时各段 quote 为 null（详情页隐藏引用块）', () => {
    const bare = buildQuotedSummary({
      what: 'a',
      who: 'b',
      whoCanSubmit: '',
      afterDeadline: '',
      deadline: null,
      howToComment: 'c',
      channels: [{ kind: 'other', value: 'v' }],
    });
    assert.equal(bare.what.quote, null);
    assert.equal(bare.deadline.text, null);
    assert.equal(bare.channels[0].quote, null);
  });
});

describe('渠道清单归一化：去重与截断不得打乱引用配对', () => {
  const quotes = ['q0', 'q1', 'q2', 'q3', 'q4'];
  const channels = normalizeChannels(
    [
      { kind: 'email', value: ' A@B.GOV.CN ' },
      { kind: 'email', value: 'a@b.gov.cn' }, // 大小写不同的重复项 → 丢，且不能顶掉后面的引用
      { kind: '', value: '' }, // 空值 → 丢
      { kind: '电子邮箱', value: 'c@d.gov.cn' }, // 中文标签（人工录入写法）
      { kind: '瞎写', value: 'e@f.gov.cn' }, // 不认识的类型 → other，不猜
      { kind: 'online', value: 'www.b.gov.cn' },
      { kind: 'online', value: 'g@h.gov.cn' },
      { kind: 'phone', value: '010-1' },
      { kind: 'phone', value: '021-2' },
    ],
    quotes,
  );

  it('按原始下标配引用，再去重 / 去空 / 截断', () => {
    assert.deepEqual(
      channels.map((channel) => [channel.kind, channel.value, channel.quote]),
      [
        ['email', 'A@B.GOV.CN', 'q0'],
        ['email', 'c@d.gov.cn', 'q3'],
        ['other', 'e@f.gov.cn', 'q4'],
        // 第 6 项起引用数组已用完 → quote 为 null，但仍然保留渠道本身
        ['online', 'www.b.gov.cn', null],
        ['online', 'g@h.gov.cn', null], // 声明的 kind 一律优先，不按值反推
        ['phone', '010-1', null],
        ['phone', '021-2', null],
      ],
    );
  });

  it('重复值只留第一条，条数有上限', () => {
    assert.equal(channels.filter((channel) => channel.value.toLowerCase() === 'a@b.gov.cn').length, 1);
    const many = normalizeChannels(
      Array.from({ length: 20 }, (_, index) => ({ kind: 'other', value: `v${index}` })),
    );
    assert.equal(many.length, 8, '超出 8 条视为模型跑偏');
  });

  it('非数组输入一律空清单（模型漏字段不该炸掉整条摘要）', () => {
    for (const bad of [undefined, null, {}, 'x', 42]) {
      assert.deepEqual(normalizeChannels(bad), []);
    }
  });
});
