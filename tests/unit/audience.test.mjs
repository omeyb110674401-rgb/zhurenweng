import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIENCE_HINTS,
  AUDIENCE_LABELS,
  AUDIENCE_OVERRIDES,
  NOTICE_AUDIENCES,
  deriveNoticeAudience,
  isKnownAudience,
} from '../../src/lib/audience.ts';

/**
 * 单元（issue #83）：受众面判定的**顺序**与"不许兜底"。
 *
 * 这一组值钱的不是各分支都过，而是三件事：
 * 1. **顺序**：法律草案的标题里往往带"公路""道路"这类行业词，先判行业就会把一部
 *    面向全体征求意见的法律判成行业文件；
 * 2. **不许兜底**：标题没线索就是 `unknown`，不能顺手塞进任何一类；
 * 3. **依据可核对**：每条的 `basis` 都要写清是哪条规则撞的（下面用真实标题逐条钉住）。
 *
 * 标题全部来自 2026-09-26 生产库的**真实条目**（只读查出来的原文，未改写）——
 * 假想题判不出"公路法里含公路"这种真实形状。
 */

/** 真实标题 → 期望判定。翻这张表就能看出分类法现在长什么样。 */
const CASES = [
  // 立法：源是全国人大，或标题是法律 / 条例草案
  ['水法（修订草案二次审议稿）征求意见', 'public', 'npc'],
  ['银行业监督管理法（修订草案二次审议稿）征求意见', 'public', 'npc'],
  ['关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知', 'public', 'mot'],
  [
    '国家互联网信息办公室关于《中华人民共和国反网络暴力法（征求意见稿）》公开征求意见的通知',
    'public',
    'cac',
  ],
  ['司法部关于《行政执法监督条例（草案征求意见稿）》公开征求意见的通知', 'public', 'moj'],
  // 「条例」后面没有括号的**实施性文件**不是立法，仍按行业事项判
  ['关于公开征求《保障中小企业款项支付条例》3项配套制度意见的公示', 'sector', 'miit'],

  // 税收与民生
  ['国家发展改革委关于《中华人民共和国国家储备安全法（草案，征求意见稿）》公开征求意见的公告', 'public', 'ndrc'],
  [
    '国家互联网信息办公室关于《国务院关于保障未成年人健康安全使用网络的规定（征求意见稿）》公开征求意见的通知',
    'public',
    'cac',
  ],
  ['关于《综合防控儿童青少年近视实施方案（征求意见稿）》向社会公开征求意见的公告', 'public', 'moe'],
  ['关于对《人民教师誓词（征求意见稿）》公开征求意见的公告', 'public', 'moe'],

  // 行业专业：技术文件、行业管理、专业领域词
  ['住房城乡建设部办公厅关于国家标准《城市绿地设计标准（修订征求意见稿）》公开征求意见的通知', 'sector', 'mohurd'],
  ['住房城乡建设部办公厅关于国家标准《混凝土结构现场检测技术标准（修订征求意见稿）》公开征求意见的通知', 'sector', 'mohurd'],
  ['市场监管总局特种设备局关于《电梯安全技术规程（征求意见稿）》再次公开征求意见的公告', 'sector', 'samr'],
  ['关于公开征求国家生态环境标准《美丽河湖评价技术导则（征求意见稿）》意见的通知', 'sector', 'mee'],
  ['国家发展改革委关于向社会公开征求《售电公司管理办法（公开征求意见稿）》意见的公告', 'sector', 'ndrc'],
  ['关于公开征求《全国动力电池回收利用标准化技术委员会组建委员名单意见》的公示', 'sector', 'miit'],
  // 「注册现场核查要点」是给生产企业的，不是给消费者的食品规定
  [
    '市场监管总局关于公开征求婴幼儿配方乳粉、特殊医学用途配方食品注册现场核查要点及判定原则意见的通知',
    'sector',
    'samr',
  ],
  ['市场监管总局关于公开征求《食糖生产许可审查细则（征求意见稿）》意见的通知', 'sector', 'samr'],

  // 人工覆盖表：规则判错的那些（覆盖表本身就是"可迭代"的落点；按 id 前缀命中，
  // 所以这几条要把生产条目 id 一并传进来）
  [
    '市场监管总局关于公开征求《关于深入推进内外贸产品同线同标同质促进消费扩容提质的实施意见（征求意见稿）》意见的通知',
    'public',
    'samr',
    '954dcc1763249045',
  ],
  ['教育部关于《教育系统内部审计工作规定（征求意见稿）》公开征求意见的公告', 'sector', 'moe', '61323da4f0aa11d2'],
  [
    '市场监管总局关于公开征求2027年市场监管部门食品安全抽检计划建议的公告',
    'sector',
    'samr',
    'c81057ef3f3f7e11',
  ],
];

describe('issue #83：受众面判定', () => {
  for (const [title, expected, sourceId, id] of CASES) {
    it(`${expected} ← ${title.slice(0, 26)}`, () => {
      const decision = deriveNoticeAudience({ title, sourceId, id });
      assert.equal(decision.audience, expected, `${title} → ${decision.audience}（${decision.basis}）`);
      // 判定必须带得出依据：一个说不出凭什么判的字段，使用者既不敢信也没法改
      assert.ok(decision.basis.length > 0);
      assert.ok(AUDIENCE_HINTS[decision.audience].length > 0);
    });
  }

  it('顺序：法律草案里的行业词不许把它判成行业文件', () => {
    // 「公路」在专业领域词表里，但这一条是**法律草案** ⇒ 立法优先
    const law = deriveNoticeAudience({
      title: '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知',
    });
    assert.equal(law.audience, 'public');
    // 同一个词在**标准**里就该判行业：顺序不是"含公路就公众"，而是"先看是不是立法"
    const standard = deriveNoticeAudience({
      title: '住房城乡建设部办公厅关于行业标准《城市道路照明设计标准（修订征求意见稿）》公开征求意见的通知',
    });
    assert.equal(standard.audience, 'sector');
  });

  it('「办法」里的法字不算立法（负向断言）', () => {
    const d = deriveNoticeAudience({
      title: '国家发展改革委关于向社会公开征求《售电公司管理办法（公开征求意见稿）》意见的公告',
    });
    assert.equal(d.audience, 'sector');
    assert.doesNotMatch(d.basis, /法律\/条例草案/);

    // 光看上面这条钉不住负向断言：它的括号里只有「公开征求意见稿」，而 2026-09-27 的收窄
    // 已经不让这个形状命中"简写 = 立法"那一支了。真正会被负向断言拦下的是
    // **括号里写着草案**的部门规章草案 —— 按本站口径那是行业事项（读者是市场主体与从业者），
    // 不是面向全体的立法。**同一个判据，所以放同一条用例里**（拆出去就会让 pin 只选中一半）。
    const regulation = deriveNoticeAudience({
      title: '关于《危险货物道路运输安全管理办法（修订草案征求意见稿）》公开征求意见的通知',
    });
    assert.equal(regulation.audience, 'sector', `实际 ${regulation.audience}（${regulation.basis}）`);
    assert.doesNotMatch(regulation.basis, /法律\/条例草案/);
  });

  it('「…法（征求意见稿）」里的法多半是**方法**，不是立法（2026-09-27 修）', () => {
    // 生产实例：这条是四项环境监测**方法标准**，旧判据按「色谱法（征求意见稿）」判成了公众广域，
    // 而受众面现在决定喂入档位 —— 它被按重档白跑了一遍（issue #86 第十三节 13.1-3）。
    for (const title of [
      '关于公开征求《水质 N,N-二甲基甲酰胺和N,N-二甲基乙酰胺的测定 高效液相色谱法（征求意见稿）》等4项国家生态环境标准意见的通知',
      '关于征求《固定污染源废气 氨的测定 便携式激光吸收光谱法（征求意见稿）》意见的函',
      '关于公开征求《土壤 有效磷的测定 比色法（征求意见稿）》意见的通知',
    ]) {
      const d = deriveNoticeAudience({ title, sourceId: 'mee' });
      assert.notEqual(d.audience, 'public', `${title} 不该判成立法（${d.basis}）`);
      assert.doesNotMatch(d.basis, /法律\/条例草案/);
    }
  });

  it('但**写明是草案**的简写照样算立法（收窄不能把真草案一起挡掉）', () => {
    for (const title of [
      '关于《中华人民共和国公路法（修正草案征求意见稿）》公开征求意见的通知',
      '全国人大常委会关于《森林法（修订草案）》征求意见的通知',
      '关于《收费公路管理条例（草案征求意见稿）》公开征求意见的通知',
    ]) {
      assert.equal(deriveNoticeAudience({ title }).audience, 'public', title);
    }
    // 全国人大源上的一切都算立法，不看标题措辞（那条规则在最前面）
    assert.equal(
      deriveNoticeAudience({ title: '水法（修订草案二次审议稿）征求意见', sourceId: 'npc' }).audience,
      'public',
    );
  });

  it('判不出来就是 unknown，不兜底成任何一类', () => {
    const d = deriveNoticeAudience({ title: '关于公开征求意见的通知' });
    assert.equal(d.audience, 'unknown');
    assert.match(d.basis, /不兜底/);
    // 未判定不是"某一类"，所以它没有"命中词"可写
    assert.equal(AUDIENCE_LABELS.unknown, '未判定');
  });

  it('没有 id 时人工覆盖表不生效（覆盖按 id 前缀登记）', () => {
    const title = '市场监管总局关于公开征求2027年市场监管部门食品安全抽检计划建议的公告';
    assert.equal(deriveNoticeAudience({ title }).audience, 'public', '没有 id 时走规则表');
    assert.equal(deriveNoticeAudience({ title, id: 'c81057ef00000000' }).audience, 'sector');
    assert.equal(deriveNoticeAudience({ title, id: 'ffffffff00000000' }).audience, 'public', '别的 id 不该命中');
  });

  it('覆盖表每条都要写清理由（不许留一个说不出为什么的覆盖）', () => {
    assert.ok(AUDIENCE_OVERRIDES.length > 0);
    for (const override of AUDIENCE_OVERRIDES) {
      assert.match(override.match, /^[0-9a-f]{8}$/, `覆盖键应为 8 位 id 前缀：${override.match}`);
      assert.ok(override.why.length >= 8, `覆盖理由太短：${override.match}`);
      assert.ok(NOTICE_AUDIENCES.includes(override.audience));
    }
  });

  it('筛选取值白名单：只有三个已知值生效', () => {
    for (const key of NOTICE_AUDIENCES) assert.equal(isKnownAudience(key), true);
    for (const bad of ['', 'PUBLIC', 'all', 'both', '公众广域']) {
      assert.equal(isKnownAudience(bad), false, `${bad} 不该是合法筛选值`);
    }
  });
});
