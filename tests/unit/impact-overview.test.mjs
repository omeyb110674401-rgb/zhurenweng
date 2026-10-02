import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IMPACT_OVERVIEW_WHO_MAX,
  impactLine,
  impactOverview,
} from '../../src/lib/impact-display.ts';

/**
 * 单元：「影响点」三件的两条纯函数（issue #88 第二刀，规格第七节）。
 *
 * 这一段改的是**每一条判读的第一行**与**块首那一行概览** —— 它们是读者扫过判读块时
 * 唯一一定会读到的两行，所以两条函数都是"错一个字就整页读错"的那一类：
 *
 * 1. `impactLine`：一条判读的「影响：<主体> · <方面>」。**两半各自可缺**（模型写不出具体
 *    主体时留空串，存量 39 条还全都没有 `point`），而"缺一半"与"两半都在"必须长得不一样 ——
 *    退化成只显示 who 就等于把新加的"方面"静默丢掉（那正是本刀要加的东西）。
 * 2. `impactOverview`：块首概览，**程序聚合、不额外调模型**。它把"N 处判读"与"都是些什么"
 *    压成两行，所以每一个数都要与下面的条目对得上 —— 数错了读者不会发现（他没法一条条数）。
 *
 * **上限为什么必须 import 常量**：`topWho` 列几个（4 还是 3）用户还没拍板（规格 7.5 明写
 * "待定"）。把 3/4 写进断言，等于把"待定"偷偷变成一个测试里的事实 —— 用户拍 4 的那天，
 * 红的是测试，而测试没错。所以本文件里**任何地方都不出现字面的 3 或 4**，
 * 一律用 `IMPACT_OVERVIEW_WHO_MAX` 现算（超限那条用 `MAX + 2`，也不写死数字）。
 *
 * 判据放在 `lib/impact-display.ts` 而不是页面里，理由与 `shouldRenderImpacts` 同源：
 * 页面 `.tsx` 进不了本仓库的单测（自证框架只认 `node --test` 直读 `.ts`），
 * 而**钉不住的判据等于没有判据**。
 */

/** 造一条判读。默认值刻意是"两半都空"，因为那是存量旧行的真实形状（没有 point、who 也可能空）。 */
function impact(parts = {}) {
  return {
    quote: '这一处的逐字原文',
    who: '',
    point: '',
    text: '可能带来什么',
    kind: 'risk',
    source: null,
    sourceUrl: null,
    ...parts,
  };
}

/** 造 N 个互不相同的 who（不写死 3/4：条数一律由调用方按常量算出来）。 */
function distinctWho(count) {
  return Array.from({ length: count }, (_, index) => `主体${index + 1}`);
}

describe('issue #88：「影响：<主体> · <方面>」这一行（impactLine）', () => {
  it('两半都有 ⇒ 用「 · 」连起来（用户 2026-10-02 给的正例形状）', () => {
    assert.equal(impactLine({ who: '平台', point: '合规成本' }), '影响：平台 · 合规成本');
  });

  it('只有 who ⇒ 只显示 who（存量 39 条全都没有 point，它们必须照常显示）', () => {
    assert.equal(impactLine({ who: '以车辆通行费筹集养护资金的地方政府', point: '' }), '影响：以车辆通行费筹集养护资金的地方政府');
  });

  it('只有 point ⇒ 只显示 point（写不出主体不等于这半句没价值）', () => {
    assert.equal(impactLine({ who: '', point: '匿名发声空间' }), '影响：匿名发声空间');
  });

  it('两半都空 ⇒ null（**这一行整行不出现**，不是显示一个「影响：」空壳）', () => {
    assert.equal(impactLine({ who: '', point: '' }), null);
  });

  it('纯空白算空（模型很爱吐一个空格；"看着有值"与"真有值"必须同一个判据）', () => {
    assert.equal(impactLine({ who: '   ', point: '' }), null);
    assert.equal(impactLine({ who: '', point: '  ' }), null);
    assert.equal(impactLine({ who: '  ', point: '   ' }), null);
  });

  it('前后空白要 trim（落库前已 trim 过一次，这里是第二道 —— 拼接处多一个空格看不出来）', () => {
    assert.equal(impactLine({ who: ' 平台 ', point: ' 合规成本 ' }), '影响：平台 · 合规成本');
    assert.equal(impactLine({ who: ' 平台 ', point: '   ' }), '影响：平台');
    assert.equal(impactLine({ who: '  ', point: ' 合规成本 ' }), '影响：合规成本');
  });
});

describe('issue #88：块首概览（impactOverview）', () => {
  it('空数组 ⇒ 两行都不出现、计数为零（空壳比没有更坏）', () => {
    const overview = impactOverview([]);
    assert.equal(overview.total, 0);
    assert.deepEqual(overview.countsByKind, []);
    assert.deepEqual(overview.topWho, []);
    assert.equal(overview.whoOverflow, 0);
    assert.equal(overview.countsLine, null, '一条判读都没有时连「共 0 处」都不该写');
    assert.equal(overview.whoLine, null);
  });

  it('全部 who 为空 ⇒ whoLine 为 null，但计数照算（规格 7.5：都空则不显示那一行）', () => {
    const overview = impactOverview([
      impact({ who: '', kind: 'risk' }),
      impact({ who: '', kind: 'burden' }),
    ]);
    assert.deepEqual(overview.topWho, []);
    assert.equal(overview.whoLine, null, '一个主体都写不出来时，那一行整行不出现');
    assert.equal(overview.whoOverflow, 0);
    assert.equal(overview.countsLine, '共 2 处：1 处可能的不利后果 · 1 处新增的义务或成本');
  });

  it('who 去重、按首次出现顺序（同一主体在几条判读里重复出现是常态）', () => {
    const overview = impactOverview([
      impact({ who: '平台' }),
      impact({ who: '自媒体账号' }),
      impact({ who: '平台' }),
      impact({ who: '实名用户' }),
      impact({ who: '自媒体账号' }),
    ]);
    assert.deepEqual(overview.topWho, ['平台', '自媒体账号', '实名用户']);
    assert.equal(overview.whoOverflow, 0);
    assert.equal(overview.whoLine, '影响：平台、自媒体账号、实名用户');
  });

  it('纯空白的 who 不算一个主体（否则概览里会出现一个空的顿号位）', () => {
    const overview = impactOverview([
      impact({ who: '平台' }),
      impact({ who: '   ' }),
      impact({ who: '实名用户' }),
    ]);
    assert.deepEqual(overview.topWho, ['平台', '实名用户']);
    assert.equal(overview.whoLine, '影响：平台、实名用户');
  });

  it('恰好等于上限 ⇒ 全部列出，尾部**不出现**「等 N 类」', () => {
    const overview = impactOverview(distinctWho(IMPACT_OVERVIEW_WHO_MAX).map((who) => impact({ who })));
    assert.equal(overview.topWho.length, IMPACT_OVERVIEW_WHO_MAX, '上限由常量定，不写死数字');
    assert.equal(overview.whoOverflow, 0);
    assert.equal(
      overview.whoLine,
      `影响：${distinctWho(IMPACT_OVERVIEW_WHO_MAX).join('、')}`,
      '刚好装得下时不许写「等 0 类」那种话',
    );
  });

  it('超过上限 ⇒ 只列前 N 个，尾部「 等 N 类」的 N 是**没列出来的去重条数**', () => {
    const overflow = 2;
    const total = IMPACT_OVERVIEW_WHO_MAX + overflow;
    const overview = impactOverview(distinctWho(total).map((who) => impact({ who })));
    assert.equal(overview.topWho.length, IMPACT_OVERVIEW_WHO_MAX);
    assert.deepEqual(overview.topWho, distinctWho(IMPACT_OVERVIEW_WHO_MAX));
    assert.equal(overview.whoOverflow, overflow);
    assert.equal(overview.whoLine, `影响：${distinctWho(IMPACT_OVERVIEW_WHO_MAX).join('、')} 等 ${overflow} 类`);
  });

  it('上限算的是**去重后**的条数，不是判读条数（重复的主体不占名额）', () => {
    const impacts = [];
    for (const who of distinctWho(IMPACT_OVERVIEW_WHO_MAX)) {
      impacts.push(impact({ who }), impact({ who }), impact({ who }));
    }
    impacts.push(impact({ who: '多出来的那个主体' }));
    const overview = impactOverview(impacts);
    assert.equal(overview.topWho.length, IMPACT_OVERVIEW_WHO_MAX, '三个重复的主体只占一个名额');
    assert.equal(overview.whoOverflow, 1);
    assert.ok(overview.whoLine.endsWith(' 等 1 类'));
  });

  /**
   * countsLine 的**类型顺序**取「冻结接口里写死的那一条」：risk → loophole → burden → other
   * （`countsByKind` 的注释与 `IMPACT_KIND_ORDER` 都是这个顺序）。
   *
   * 为什么这里要专门写一段注释：88 号文档 7.5 与接口说明里给的那行**例子**
   * （`共 6 处：2 处可能被规避或滥用 · 2 处新增的义务或成本 · 2 处可能的不利后果`）
   * 是 loophole → burden → risk，与上面那条固定顺序**不一致** —— 两处不可能同时对。
   * 这里按**成规则写下来的那一条**（固定顺序）断言：它是唯一被写成"规则"的表述，
   * 而且 `countsByKind` 的数组顺序与 countsLine 的措辞顺序必须是同一个（否则同一份数据
   * 有两个顺序，读者与下一个人都说不清哪个是准的）。文档里那行例子待 Lead/用户定夺 ——
   * **要改就两处一起改**（`IMPACT_KIND_ORDER` 与本文件的两条字面量）。
   */
  it('countsLine：N 是判读总条数，措辞按固定顺序 risk → loophole → burden → other', () => {
    const overview = impactOverview([
      impact({ kind: 'risk' }),
      impact({ kind: 'loophole' }),
      impact({ kind: 'burden' }),
      impact({ kind: 'risk' }),
      impact({ kind: 'loophole' }),
      impact({ kind: 'burden' }),
    ]);
    assert.equal(overview.total, 6);
    assert.equal(
      overview.countsLine,
      '共 6 处：2 处可能的不利后果 · 2 处可能被规避或滥用 · 2 处新增的义务或成本',
      '与 countsByKind 同一个顺序；措辞用 IMPACT_KIND_LABELS 的实际取值',
    );
  });

  it('countsByKind 的顺序固定为 risk → loophole → burden → other，与输入顺序无关', () => {
    const overview = impactOverview([
      impact({ kind: 'other' }),
      impact({ kind: 'burden' }),
      impact({ kind: 'risk' }),
      impact({ kind: 'loophole' }),
      impact({ kind: 'risk' }),
    ]);
    assert.deepEqual(overview.countsByKind, [
      { kind: 'risk', count: 2 },
      { kind: 'loophole', count: 1 },
      { kind: 'burden', count: 1 },
      { kind: 'other', count: 1 },
    ]);
    assert.equal(
      overview.countsLine,
      '共 5 处：2 处可能的不利后果 · 1 处可能被规避或滥用 · 1 处新增的义务或成本 · 1 处其他可能的影响',
    );
  });

  it('count 为 0 的类别不进 countsByKind、也不进那一行（不写「0 处…」占位置）', () => {
    const overview = impactOverview([
      impact({ kind: 'loophole' }),
      impact({ kind: 'loophole' }),
      impact({ kind: 'other' }),
    ]);
    assert.deepEqual(overview.countsByKind, [
      { kind: 'loophole', count: 2 },
      { kind: 'other', count: 1 },
    ]);
    assert.equal(overview.countsLine, '共 3 处：2 处可能被规避或滥用 · 1 处其他可能的影响');
  });

  it('计数不受 who / point 有无影响（只有 who 或只有 point 的条目照样算一处）', () => {
    const overview = impactOverview([
      impact({ who: '平台', point: '' }),
      impact({ who: '', point: '合规成本' }),
      impact({ who: '', point: '' }),
    ]);
    assert.equal(overview.total, 3);
    assert.equal(overview.countsLine, '共 3 处：3 处可能的不利后果');
    assert.equal(overview.whoLine, '影响：平台');
  });
});
