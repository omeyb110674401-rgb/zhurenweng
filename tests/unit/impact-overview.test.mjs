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
 * 3. 概览**只收不含顿号的主体**（2026-10-02 第二刀残留第 4 件）：顿号＝枚举，而概览是给人
 *    **扫**的一行、用处是**索引** —— 索引条目读不出边界就没有意义。被筛掉的条目**不丢信息**：
 *    它在每条判读自己那一行上照旧完整，也照旧计入「等 N 类」。这条规则**只对旧行动刀**
 *    （第二刀重跑过的 3 条公示 `who` 里顿号数是 0，新数据一个字都不变）。
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

/**
 * 线上旧行的**真实夹具**：`0b00deff17dfa050`《中华人民共和国反网络暴力法（征求意见稿）》
 * 落库摘要里的 6 条判读（`who` / `kind` 逐字抄自那条真实落库行，没有 `point` —— 那正是
 * 第二刀之前的形状）。这条公示**已截止、不在方案 B 的重跑范围**，所以它就是"范围外旧行"。
 */
const PRODUCTION_IMPACTS = [
  { who: '进行批评性报道、爆料的媒体和自媒体账号', kind: 'loophole' },
  { who: '网络服务提供者', kind: 'burden' },
  { who: '不愿实名发言的用户以及依赖匿名用户的中小平台', kind: 'risk' },
  { who: '被平台限流、暂停或关闭账号的用户', kind: 'loophole' },
  { who: '整理、使用他人已公开个人信息开展营销或业务的机构', kind: 'risk' },
  { who: '收集社交、医疗、地理位置信息的平台企业', kind: 'burden' },
].map((parts) => impact(parts));

/** 改前线上实取的那一行（逐字）：6 个主体被顿号连成一句，读者分不出一个主体在哪结束。 */
const PRODUCTION_RUN_ON =
  '影响：进行批评性报道、爆料的媒体和自媒体账号、网络服务提供者、不愿实名发言的用户以及依赖匿名用户的中小平台、被平台限流、暂停或关闭账号的用户 等 2 类';

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

  /**
   * 下面四条是「概览只收不含顿号的主体」这一刀的判据（2026-10-02 第二刀残留第 4 件）。
   *
   * 顿号＝枚举，而**一串枚举不是一个"主体类别"**：旧行的 `who` 自己就带顿号，与概览连接
   * 主体用的顿号是同一个字，于是「影响：A、B、C」在读者眼里分不出一个主体在哪结束。
   * 概览是给人**扫**的一行、用处是**索引** —— 索引条目读不出边界就没有意义。
   * 被筛掉的条目**不进这一行**，但它在**每条判读自己那一行**照旧完整，也照旧计入「等 N 类」。
   */
  it('带顿号的主体不进 topWho，但**计入** whoOverflow（不进索引 ≠ 不算数）', () => {
    const overview = impactOverview([
      impact({ who: '进行批评性报道、爆料的媒体和自媒体账号' }),
      impact({ who: '网络服务提供者' }),
      impact({ who: '平台' }),
      impact({ who: '进行批评性报道、爆料的媒体和自媒体账号' }),
    ]);
    assert.deepEqual(
      overview.topWho,
      ['网络服务提供者', '平台'],
      '带顿号的那个不进索引，也不影响其余主体的**首次出现顺序**（去重仍按原顺序做）',
    );
    assert.equal(overview.whoOverflow, 1, '被筛掉的那个也要算进「等 N 类」—— 少报就是看不见的缺口');
    assert.equal(overview.whoLine, '影响：网络服务提供者、平台 等 1 类');
  });

  it('全部主体都带顿号 ⇒ topWho 为空、whoLine 为 null，但计数行照常（不印一行光秃秃的「影响：」）', () => {
    const overview = impactOverview([
      impact({ who: '进行批评性报道、爆料的媒体和自媒体账号', kind: 'loophole' }),
      impact({ who: '被平台限流、暂停或关闭账号的用户', kind: 'risk' }),
    ]);
    assert.deepEqual(overview.topWho, []);
    assert.equal(overview.whoLine, null, '一个干净主体都没有时，那一行整行不出现（与"全都写不出主体"同一条规矩）');
    assert.equal(overview.whoOverflow, 2, '口径统一：whoOverflow 是"没进索引的去重主体数"，与 whoLine 印不印无关');
    assert.equal(overview.countsLine, '共 2 处：1 处可能的不利后果 · 1 处可能被规避或滥用');
  });

  it('不含顿号的新数据 ⇒ 概览逐字与改动前一致（回归守卫：重跑过的 3 条一个字都不该变）', () => {
    // 形状取自线上重跑后的实取（88 号文档 7.9）：who 是 ≤20 字的单一主体，point 是新字段。
    const shantong = impactOverview([
      impact({ who: '三同产品生产企业', point: '备案程序与合规成本' }),
      impact({ who: '中小外贸企业' }),
      impact({ who: '三同产品消费者' }),
    ]);
    assert.deepEqual(shantong.topWho, ['三同产品生产企业', '中小外贸企业', '三同产品消费者']);
    assert.equal(shantong.whoOverflow, 0);
    assert.equal(shantong.whoLine, '影响：三同产品生产企业、中小外贸企业、三同产品消费者');

    const gonglu = impactOverview([
      impact({ who: '高速公路通行车主', point: '通行费用支出' }),
      impact({ who: '收费公路通行车主' }),
      impact({ who: '地方举债建路沿线通行者' }),
    ]);
    assert.equal(gonglu.whoLine, '影响：高速公路通行车主、收费公路通行车主、地方举债建路沿线通行者');

    // 干净数据超过上限时，「等 N 类」的口径也与改动前一模一样（筛顿号那一步对它是空操作）。
    const many = distinctWho(IMPACT_OVERVIEW_WHO_MAX + 2);
    const overflowed = impactOverview(many.map((who) => impact({ who })));
    assert.equal(overflowed.whoOverflow, 2);
    assert.equal(overflowed.whoLine, `影响：${many.slice(0, IMPACT_OVERVIEW_WHO_MAX).join('、')} 等 2 类`);
  });

  it('线上那条旧行（6 个主体里只有 2 个不含顿号）⇒ 概览不再把 6 个连成一句', () => {
    // 先证明这个夹具**真的复现了改前那一行**（照旧实现的算法现算一遍）——
    // 否则"不再连写"是一句没有对象的话。
    const whoAll = [...new Set(PRODUCTION_IMPACTS.map((item) => item.who.trim()))];
    const legacy =
      `影响：${whoAll.slice(0, IMPACT_OVERVIEW_WHO_MAX).join('、')}` +
      (whoAll.length > IMPACT_OVERVIEW_WHO_MAX ? ` 等 ${whoAll.length - IMPACT_OVERVIEW_WHO_MAX} 类` : '');
    assert.equal(legacy, PRODUCTION_RUN_ON, '夹具要能复现改前那一行，这条用例才钉得住东西');

    const overview = impactOverview(PRODUCTION_IMPACTS);
    assert.deepEqual(overview.topWho, ['网络服务提供者', '不愿实名发言的用户以及依赖匿名用户的中小平台']);
    assert.equal(overview.whoOverflow, 4, '另外 4 个（含顿号的）不进索引，但一个都不能少报');
    assert.equal(overview.whoLine, '影响：网络服务提供者、不愿实名发言的用户以及依赖匿名用户的中小平台 等 4 类');
    assert.notEqual(overview.whoLine, PRODUCTION_RUN_ON, '改后不许再是那一串分不出边界的连写');
    assert.equal(
      overview.countsLine,
      '共 6 处：2 处可能的不利后果 · 2 处可能被规避或滥用 · 2 处新增的义务或成本',
      '计数行一个字都不该变（线上实取逐字）',
    );

    // 不进索引 ≠ 不显示：被筛掉的 4 个主体在**每条判读自己那一行**上照旧完整。
    for (const item of PRODUCTION_IMPACTS) {
      assert.ok(impactLine(item).includes(item.who), `「${item.who}」仍要在它自己那一行上完整出现`);
    }

    /**
     * **已知残留（本刀按 Lead 定的判据只筛顿号，别把它当 bug 查）**：第 3 个主体没有顿号、
     * 却是用「以及」连起来的复合主体，所以它**留在**索引里。概览从"6 个连成一句"收到"2 个"，
     * 但这一条本身仍是复合的 —— 要不要把「以及」这类枚举连接词也纳入判据是另一刀的决定，
     * 本刀不自作主张。这条断言把当前行为**显式钉住**，免得它悄悄漂移。
     */
    assert.ok(overview.topWho.includes('不愿实名发言的用户以及依赖匿名用户的中小平台'));
  });
});
