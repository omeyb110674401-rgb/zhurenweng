import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  IMPACT_REVIEW_NEIGHBORHOOD_CHARS,
  IMPACT_REVIEW_RULES,
  IMPACT_REVIEW_SYSTEM_PROMPT,
  IMPACT_REVIEW_VERDICT_STATUSES,
  UNVERIFIED_RULES,
  impactReviewUserPrompt,
  neighborhoodForQuote,
} from '../../src/lib/impact-review-prompt.ts';
import { impactReviewRecordsFrom } from '../../src/lib/impact-review.ts';

/**
 * 单元：审读规则与**错误案例库**（issue #49）。
 *
 * 这一份是「指导模型」的产出的回归面：`src/lib/impact-review-prompt.ts` 里的六类判据是**文字**，
 * 而文字只有被"某个具体案例"钉住才拦得住改动 —— **放在文档里的案例在规则改动时一个字都不会响**。
 * 所以每条案例都是一个 `it`，断言两件事：
 *
 * 1. **规则覆盖了这个案例的形状**（按规则的**实质要求**文字断言，不是"这段文字还在"）；
 * 2. **案例的输入与期望结论能走通接受层**（`impactReviewRecordsFrom`）：
 *    逐字回显的结论被接受、想换引用的结论不被接受 —— 后者是"只减不加"那条硬约束的可执行形式。
 *
 * ## 语料与覆盖面（如实记，不装作验过）
 *
 * | 来源 | 条数 | 说明 |
 * | --- | --- | --- |
 * | `87-l3-sector-review-sheet.md`（人工过目清单） | 6 条判读，含它点名的 4 处卡点 | 6 条目 / 22 条判读全在那边；本仓**没有那几份附件**，所以邻域取清单里逐字抄录的引用本身 |
 * | 本地开发库那条《反网络暴力法》条目 | 6 条判读（真实产出） | 正文 10,896 字在手 ⇒ 邻域是**真的**从原文里取出来的 |
 *
 * 真实语料里**只出现过 A1 的正例**。A2–A6 没有实证正例，各配一条**构造案例**（标着 `构造`）
 * 用来钉住规则文字；`UNVERIFIED_RULES` 是对此的可执行声明，由本文件最后那一组反着核。
 */

/** 一条错误案例。`rule: null` = 判正的边界案例（探针打在提示词的"多走一步不算错"那句上）。 */
const CASES = [
  {
    id: '87-1-3',
    rule: 'A1',
    source: '真实样本 · 87 过目清单第 1 处卡点',
    probe: /不许推出成本、处罚、监管加强/,
    item: {
      quote: '经方法验证，本标准中 DMF、DMAC 的测定下限均为 0.020 mg/L，可完全匹配 GB 21902-2008 中 DMF 的限值需求。',
      who: '合成革等排放DMF的企业',
      point: '',
      text: '新标准可能加强对企业废水中DMF排放的监测要求。',
    },
    neighborhood:
      '经方法验证，本标准中 DMF、DMAC 的测定下限均为 0.020 mg/L，可完全匹配 GB 21902-2008 中 DMF 的限值需求。',
    neighborhoodNote: '本仓没有这份附件的正文，邻域取清单逐字抄录的那句引用本身（判 A1 够用：引用只讲方法能力）',
    expected: { status: 'rejected' },
    why: '引用是一句关于**方法能力**的话（测定下限能匹配某个限值），推断却跳到"加强对企业的监测要求" —— 引用里没有这层意思，而这层意思是整句推断的全部，删掉它就没有内容可改 ⇒ 剔除。',
  },
  {
    id: '87-4-2',
    rule: 'A1',
    source: '真实样本 · 87 过目清单第 2 处卡点',
    probe: /改到引用支撑得住的范围内/,
    item: {
      quote: '乡镇林业工作站站房建筑面积应符合表3的规定。',
      who: '乡镇林业工作站',
      point: '',
      text: '建筑面积有固定指标要求，可能限制建设灵活性并增加成本。',
    },
    neighborhood: '乡镇林业工作站站房建筑面积应符合表3的规定。',
    neighborhoodNote: '同上：邻域取引用本身；"表3"里的数字本仓没有（这正是"成本"那半句引不到依据的原因）',
    expected: {
      status: 'revised',
      revisedText: '建筑面积有固定指标要求，可能限制设计的灵活性。',
    },
    why: '前半句（有固定指标）引用支撑得住；后半句"增加成本"的依据在表 3 的**数字**里，而引用拿不到那截 ⇒ 改到引用支撑得住的范围内（保留"受限"，删掉"成本"）。',
  },
  {
    id: '87-4-3',
    rule: 'A1',
    source: '真实样本 · 87 过目清单第 2 处卡点',
    probe: /改到引用支撑得住的范围内/,
    item: {
      quote: '乡镇林业工作站应根据承担的职责，按不同等级的业务需求配备专门的仪器、设备',
      who: '乡镇林业工作站',
      point: '',
      text: '设备配置需满足职责和等级要求，可能带来采购和维护成本。',
    },
    neighborhood: '乡镇林业工作站应根据承担的职责，按不同等级的业务需求配备专门的仪器、设备',
    neighborhoodNote: '同上：邻域取引用本身',
    expected: {
      status: 'revised',
      revisedText: '须按不同等级的业务需求配备专门的仪器、设备，采购与维护成为必须做的事项。',
    },
    why: '引用说的是"有配备要求"，不是"成本上升"；把"成本"换成"必须做的事项"就落回引用支撑得住的范围。',
  },
  {
    id: '87-5-2',
    rule: 'A1',
    source: '真实样本 · 87 过目清单第 2 处卡点',
    probe: /不许推出成本/,
    item: {
      quote: '国有林区（林场）管护用房应按国家现行标准进行抗震设防',
      who: '建设单位',
      point: '',
      text: '需按国家现行标准进行抗震设防，可能增加建设成本和合规要求。',
    },
    neighborhood: '国有林区（林场）管护用房应按国家现行标准进行抗震设防',
    neighborhoodNote: '同上：邻域取引用本身',
    expected: {
      status: 'revised',
      revisedText: '需按国家现行标准进行抗震设防，增加了设计与施工的合规要求。',
    },
    why: '同族第三例：引用只支撑"有要求"，"成本"那半句没有依据 ⇒ 改（删成本、留合规要求）。',
  },
  {
    id: '87-6-4',
    rule: null,
    source: '真实样本 · 87 过目清单第 3 处卡点',
    probe: /多走一步/,
    item: {
      quote:
        'a）相似度≥60%的污染源确定为重点排查污染源，基于排污许可、自动监控或无人机遥感等方法开展非现场线索收集分析后，开展现场溯源采样比对，确定疑似污染源；',
      who: '生态环境执法监管人员',
      point: '',
      text: '依赖数据库比对相似度，若数据库不完善或不准确，可能影响溯源结果的可靠性。',
    },
    neighborhood:
      'a）相似度≥60%的污染源确定为重点排查污染源，基于排污许可、自动监控或无人机遥感等方法开展非现场线索收集分析后，开展现场溯源采样比对，确定疑似污染源；',
    neighborhoodNote: '同上：邻域取引用本身',
    expected: { status: 'passed' },
    why: '过目清单把它记为"影响对象与推断主体对不上"（推断说的是数据库不完善影响可靠性，受影响的是被溯源的企业）。那是 `who` 的措辞问题，**而审读改不动 `who`**（只减不加只允许改推断正文）⇒ 判正，并把它记成生成侧提示词的活，不是审读的活。',
  },
  {
    id: '87-2-chain',
    rule: null,
    source: '真实样本 · 87 过目清单点名的"站得住"代表',
    probe: /多走一步/,
    item: {
      quote: '民用航空器国籍登记证书的有效期为一年。持证人应在其国籍登记证书有效期到期前，提前至少 30 日申请延续其国籍登记证书有效期。',
      who: '持有中华人民共和国民用航空器国籍登记证书的航空器所有人或占有人',
      point: '',
      text: '国籍登记证改为一年一续，持证人须每年提前至少 30 日申请，逾期即无法延续。',
    },
    neighborhood:
      '民用航空器国籍登记证书的有效期为一年。持证人应在其国籍登记证书有效期到期前，提前至少 30 日申请延续其国籍登记证书有效期。',
    neighborhoodNote: '同上：邻域取引用本身',
    expected: { status: 'passed' },
    why: '推断与引用一句对一句（一年一续 / 提前 30 日 / 逾期不能延续），没有多走不该走的那一步 ⇒ 判正。**这一条是"不许因为它是推断就判负"的反例**。',
  },
  {
    id: 'anwang-1',
    rule: 'A6',
    source: '真实样本 · 本地库《反网络暴力法》条目（正文在手）',
    probe: /不许漏掉/,
    item: {
      quote: '依法通过网络检举、揭发他人违法犯罪，或者实施舆论监督的，不适用本法。',
      who: '进行批评性报道、爆料的媒体和自媒体账号',
      point: '',
      text: '「检举」「舆论监督」未界定认定标准，批评性爆料易被主张豁免而规避治理。',
    },
    neighborhood:
      '条 组织、策划、煽动、教唆网络暴力活动或者为网络暴力活动提供相关帮助的组织或者个人，除依法承担刑事责任、行政责任以外，造成他人损害的，依照《中华人民共和国民法典》等法律的规定承担民事责任。\n网络暴力侵害自然人人身权益造成严重精神损害的，被侵权人有权请求精神损害赔偿。\n第五十八条 违反本法规定，构成违反治安管理行为的，应当依法给予治安管理处罚；构成犯罪的，依法追究刑事责任。\n第七章 附 则\n第五十九条 依法通过网络检举、揭发他人违法犯罪，或者实施舆论监督的，不适用本法。\n第六十条 本法自 年 月 日起施行。',
    neighborhoodNote: '这是**真的**邻域：由 `neighborhoodForQuote` 从该条目正文（10,896 字）里按引用前后各 200 字取出来的',
    expected: { status: 'passed' },
    why: '推断说的正是这一条（附则里的豁免款）给了豁免而没写认定标准 —— 它没有漏掉免责，也没有把它读成"必须"，引用的邻域里就是这一整条 ⇒ 判正。',
  },
  {
    id: 'anwang-3',
    rule: 'A2',
    source: '真实样本 · 本地库《反网络暴力法》条目（正文在手）',
    probe: /方向相反/,
    item: {
      quote: '用户不提供真实身份信息的，网络服务提供者不得为其提供相关服务。',
      who: '不愿实名发言的用户以及依赖匿名用户的中小平台',
      point: '',
      text: '强制实名方可获服务，可能压缩匿名发声与私下举报的可用空间。',
    },
    neighborhood:
      '有针对性地开展反网络暴力宣传教育。\n第二章 平台治理\n第十一条 网络服务提供者应当建立健全用户注册、账号管理、个人信息保护、信息发布审核、监测预警、识别处置、投诉举报等反网络暴力相关制度，制定并公开管理规则、平台公约，与用户签订服务协议，明确网络暴力防范治理相关权利义务。\n第十二条 网络服务提供者为用户提供信息发布、即时通讯等服务，在与用户签订协议或者确认提供服务时，应当要求用户提供真实身份信息。用户不提供真实身份信息的，网络服务提供者不得为其提供相关服务。\n第十三条 网络服务提供者应当建立健全网络暴力监测识别机制，按照国家有关规定建立网络暴力特征库、典型案例样本库和预警模型，采用人工智能、大数据等技术手段和人工审核相结合的方式，加强对网络暴力的监测、识别和预警。',
    neighborhoodNote: '同上：由 `neighborhoodForQuote` 从正文里取出的真邻域（这一条的邻域里就有第十二条全文）',
    expected: { status: 'passed' },
    why: '引用是"不得为其提供相关服务"，推断写成"强制实名方可获服务" —— 方向一致（都是"不实名就不给服务"），没有说反 ⇒ 判正。**这一条钉的是 A2 不许误伤**。',
  },
  {
    id: '87-2-who-format',
    rule: null,
    source: '真实样本 · 87 过目清单第 4 处卡点',
    probe: /不许新增或删除判读条目/,
    item: {
      quote: '民用航空器国籍登记证书的有效期为一年。',
      who:
        '持有中华人民共和国民用航空器国籍登记证书的航空器所有人或占有人、未在到期前申请延续国籍登记证书有效期的持证人、持有适航证的航空器所有人或占有人',
      point: '',
      text: '国籍登记证改为一年一续，持证人须每年提前至少 30 日申请。',
    },
    neighborhood: '民用航空器国籍登记证书的有效期为一年。',
    neighborhoodNote: '同上：邻域取引用本身',
    expected: { status: 'passed' },
    why:
      '过目清单第 4 处说的是**格式**（`who` 29 字、带顿号，而生成侧契约是 ≤20 字、最多一个顿号），'
      + '不是合规：六类判据里没有"格式"这一类，而审读**改不动 `who`**（只减不加冻结引用与条目集合，'
      + '结论只能落在推断正文上）⇒ 判正，并把它记成生成侧提示词的活。',
  },
  {
    id: '构造-A2',
    rule: 'A2',
    source: '构造（真实语料里没有 A2 的正例）',
    probe: /方向相反/,
    item: {
      quote: '持证人应当在有效期届满前三十日申请延续。',
      who: '持证人',
      point: '',
      text: '未按期申请也可以照常延续，不影响证件的有效性。',
    },
    neighborhood: '持证人应当在有效期届满前三十日申请延续。',
    expected: { status: 'rejected' },
    why: '原文"应当"被读成"也可以照常" —— 方向相反，且这层意思是整句推断的全部 ⇒ 剔除。',
  },
  {
    id: '构造-A3',
    rule: 'A3',
    source: '构造（真实语料里没有 A3 的正例）',
    probe: /去掉引用/,
    item: {
      quote: '各地应进一步细化风险类型和等级划分，结合当地市场运行实际制定合理阈值标准。',
      who: '各地政府及市场运营机构',
      point: '',
      text: '这条把责任下压给地方，属于典型的监管缺位。',
    },
    neighborhood: '各地应进一步细化风险类型和等级划分，结合当地市场运行实际制定合理阈值标准。',
    expected: { status: 'rejected' },
    why: '"典型的监管缺位"是去掉引用仍然成立的一句对政策的评价 ⇒ 剔除（读者核对不了评价）。',
  },
  {
    id: '构造-A4',
    rule: 'A4',
    source: '构造（真实语料里没有 A4 的正例）',
    probe: /把主体换成/,
    item: {
      quote: '网络服务提供者应当建立健全网络暴力监测识别机制。',
      who: '网络服务提供者',
      point: '',
      text: '某平台会借这一条把审核责任摊到用户身上，只顾自己免责。',
    },
    neighborhood: '网络服务提供者应当建立健全网络暴力监测识别机制。',
    expected: { status: 'rejected' },
    why: '把主体换成"某主体"那句话照样成立 ⇒ 评价是冲着主体去的，不是冲着条文 ⇒ 剔除。',
  },
  {
    id: '构造-A5',
    rule: 'A5',
    source: '构造（真实语料里没有 A5 的正例）',
    probe: /合不合法、能不能告/,
    item: {
      quote: '用户不提供真实身份信息的，网络服务提供者不得为其提供相关服务。',
      who: '不愿实名发言的用户',
      point: '',
      text: '这一条可能违法，用户可以起诉平台要求继续提供服务。',
    },
    neighborhood: '用户不提供真实身份信息的，网络服务提供者不得为其提供相关服务。',
    expected: { status: 'rejected' },
    why: '在替读者回答"合不合法、能不能告" ⇒ 构成法律意见，剔除（本站不做法律判断）。',
  },
  {
    id: '构造-A6',
    rule: 'A6',
    source: '构造（真实语料里没有 A6 的正例）',
    probe: /不许读成/,
    item: {
      quote: '各地可以结合当地实际制定阈值标准。',
      who: '各地政府及市场运营机构',
      point: '',
      text: '各地必须制定阈值标准，没有例外。',
    },
    neighborhood: '各地可以结合当地实际制定阈值标准。',
    expected: { status: 'rejected' },
    why: '原文写"可以"，推断写成"必须、没有例外" —— 把可选项读成义务，且改不动（整句就是这层意思）⇒ 剔除。',
  },
  {
    id: '构造-A6-revised',
    rule: 'A6',
    source: '构造（真实语料里没有 A6 的正例）',
    probe: /找不到依据/,
    item: {
      quote: '各地可以结合当地实际制定阈值标准。',
      who: '各地政府及市场运营机构',
      point: '',
      text: '各地应当制定阈值标准，并一律在年底前完成。',
    },
    neighborhood: '各地可以结合当地实际制定阈值标准。',
    expected: {
      status: 'revised',
      revisedText: '各地可以结合当地实际制定阈值标准。',
    },
    why: '同一条原文的两处越界：把"可以"读成"应当"，还加了原文没有的期限。删掉加出来的两层就落回引用支撑得住的范围 ⇒ 已改（改得动就不剔除）。',
  },
];

/** 这条案例是"真实观察到的越界"吗（判正与构造都不算正例）。 */
const isRealPositive = (testCase) =>
  testCase.source.startsWith('真实样本')
  && (testCase.expected.status === 'rejected' || testCase.expected.status === 'revised');

function ruleOf(id) {
  return IMPACT_REVIEW_RULES.find((rule) => rule.id === id);
}

describe('issue #49：错误案例库（每条案例一个 it）', () => {
  for (const testCase of CASES) {
    it(`${testCase.id}｜${testCase.rule ?? '判正'}｜期望 ${testCase.expected.status}`, () => {
      // ① 规则存在、且它的**实质要求**真的进了提示词（改坏/撤掉一处 ⇒ 这一组当场变红）
      if (testCase.rule === null) {
        assert.match(
          IMPACT_REVIEW_SYSTEM_PROMPT,
          testCase.probe,
          `${testCase.id} 是判正的边界案例，提示词里必须留着对应那句（多走一步不算错）`,
        );
      } else {
        const rule = ruleOf(testCase.rule);
        assert.ok(rule, `规则 ${testCase.rule} 必须在 IMPACT_REVIEW_RULES 里`);
        assert.match(
          rule.requirement,
          testCase.probe,
          `${testCase.id}：规则 ${testCase.rule} 的要求文字必须覆盖这个案例的形状（${testCase.why}）`,
        );
        assert.ok(
          IMPACT_REVIEW_SYSTEM_PROMPT.includes(rule.requirement),
          `规则 ${testCase.rule} 的要求必须真的进提示词（拼出来，不是另抄一份）`,
        );
      }

      // ② 期望结论必须是三态之一；「已改」必须有文本，「剔除」不许带文本
      assert.ok(
        IMPACT_REVIEW_VERDICT_STATUSES.includes(testCase.expected.status),
        `${testCase.id} 的期望结论取值非法`,
      );
      if (testCase.expected.status === 'revised') {
        assert.ok(
          (testCase.expected.revisedText ?? '').trim() !== '',
          `${testCase.id}：判"已改"就必须给出审读后文本（否则这条记录不成立）`,
        );
      }

      // ③ 期望结论能走通**接受层**：逐字回显同一对 (quote, text) 才被采信
      const records = impactReviewRecordsFrom({
        impacts: [{ ...testCase.item, kind: 'risk', source: null, sourceUrl: null }],
        verdicts: [
          {
            quote: testCase.item.quote,
            text: testCase.item.text,
            status: testCase.expected.status,
            revisedText: testCase.expected.revisedText ?? null,
          },
        ],
        model: 'stub',
        reviewedAt: '2026-10-04T12:00:00.000Z',
      });
      assert.equal(records.length, 1, `${testCase.id}：逐字回显的结论应当被采信`);

      // ④ 只减不加：**想换引用**的那一版结论不被接受（审读不许换依据）
      const forged = impactReviewRecordsFrom({
        impacts: [{ ...testCase.item, kind: 'risk', source: null, sourceUrl: null }],
        verdicts: [
          {
            quote: `${testCase.item.quote}（这是模型自己加的）`,
            text: testCase.item.text,
            status: testCase.expected.status,
          },
        ],
        model: 'stub',
        reviewedAt: '2026-10-04T12:00:00.000Z',
      });
      assert.deepEqual(forged, [], `${testCase.id}：换了引用的结论必须不被接受`);

      // ⑤ 邻域是真的邻域：至少含引用里最长的一段（否则夹具自己就是坏的）
      if (testCase.neighborhood !== null) {
        const anchor = testCase.item.quote
          .split(/…+|\.{2,}/)
          .map((segment) => segment.trim())
          .filter((segment) => segment.length >= 8)
          .sort((a, b) => b.length - a.length)[0];
        assert.ok(
          testCase.neighborhood.includes(anchor),
          `${testCase.id}：邻域里必须真的含引用（${testCase.neighborhoodNote ?? ''}）`,
        );
      }
    });
  }
});

describe('issue #49：覆盖面如实（不装作验过）', () => {
  it('六类判据各自都在，且每类都至少有一条夹具（真实或构造）', () => {
    assert.deepEqual(
      IMPACT_REVIEW_RULES.map((rule) => rule.id),
      ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
      '六类的编号与顺序是契约（A1–A6），别重排',
    );
    for (const rule of IMPACT_REVIEW_RULES) {
      assert.ok(
        CASES.some((testCase) => testCase.rule === rule.id),
        `规则 ${rule.id} 必须有夹具 —— 没有夹具的规则等于没写`,
      );
    }
  });

  it('`UNVERIFIED_RULES` = 真实语料里没有正例的那些（拿到真样本必须回来改这条声明）', () => {
    const verified = new Set(CASES.filter(isRealPositive).map((testCase) => testCase.rule));
    const unverified = IMPACT_REVIEW_RULES.map((rule) => rule.id).filter(
      (id) => !verified.has(id),
    );
    assert.deepEqual(
      [...UNVERIFIED_RULES].sort(),
      unverified.sort(),
      '真实正例的分布变了：先改 UNVERIFIED_RULES 的声明，再改这条断言',
    );
    assert.ok(
      !unverified.includes('A1'),
      'A1（超出原文）在真实语料里是有正例的（87 过目清单第 1、2 处卡点）',
    );
  });

  it('构造案例必须标着"构造"（不许把编的案例混进真实样本里）', () => {
    for (const testCase of CASES) {
      if (isRealPositive(testCase)) continue;
      if (testCase.rule === null) continue;
      const realCase = testCase.source.startsWith('真实样本');
      if (!realCase) {
        assert.match(testCase.source, /^构造/, `${testCase.id}：不是真实样本就必须标"构造"`);
      }
    }
  });
});

describe('issue #49：原文邻域（引用定位回原文后取前后各 N 字）', () => {
  const TEXT =
    '开头的这一段话比较长一些。第二条 中间那一条的正文就在这里了。第三条 结尾的这段话也不算短。';

  it('以引用为中心取前后各 N 字，贴边时不越界（不补齐）', () => {
    const middle = '中间那一条的正文就在这里了。';
    const at = TEXT.indexOf(middle);
    const window = neighborhoodForQuote(TEXT, middle, 5);
    assert.equal(window.length, middle.length + 10, '两侧各 5 字');
    assert.equal(window.slice(0, 5), TEXT.slice(at - 5, at), '引用前面那 5 字就是原文里的那 5 字');
    assert.equal(
      window.slice(-5),
      TEXT.slice(at + middle.length, at + middle.length + 5),
      '引用后面那 5 字同理',
    );

    const head = '开头的这一段话比较长一些。';
    const headWindow = neighborhoodForQuote(TEXT, head, 5);
    assert.ok(headWindow.startsWith(head), '引用贴近原文开头 ⇒ 窗口就从开头起，前面不补');
    assert.equal(headWindow.length, head.length + 5, '只补得上右边那一侧');

    const tail = '结尾的这段话也不算短。';
    const tailWindow = neighborhoodForQuote(TEXT, tail, 5);
    assert.ok(tailWindow.endsWith(tail), '引用贴近原文结尾 ⇒ 右侧不补');
    assert.equal(tailWindow.length, tail.length + 5);
  });

  it('缺省窗口就是那个具名常量（长度只此一处）', () => {
    const long = `前${'甲'.repeat(400)}中间那句引用在这里。${'乙'.repeat(400)}后`;
    const window = neighborhoodForQuote(long, '中间那句引用在这里。');
    assert.equal(window.length, 400 + '中间那句引用在这里。'.length);
    assert.equal(window, neighborhoodForQuote(long, '中间那句引用在这里。', IMPACT_REVIEW_NEIGHBORHOOD_CHARS));
  });

  it('常量不小于一条的平均长度（实测：那份法 10,896 字 / 78 条 ≈ 140 字）', () => {
    assert.ok(
      IMPACT_REVIEW_NEIGHBORHOOD_CHARS >= 140,
      '窗口要能覆盖"本条" —— 小于平均条长就看不见但书与例外',
    );
  });

  it('容忍附件抽取出来的换行 / 全角空格 / 引号字形差异（否则真引用定位不到）', () => {
    const messy = '第二条 运输机场运营人\n　应当取得许可，并在有效期届满前申请延续。';
    for (const quote of [
      '运输机场运营人应当取得许可', // 空白被压掉
      '运输机场运营人 应当取得许可', // 多余空格
      '“运输机场运营人应当取得许可”', // 引号字形
    ]) {
      assert.notEqual(neighborhoodForQuote(messy, quote, 4), null, `应当定位到：${quote}`);
    }
  });

  it('带省略号的引用用最长的一段定位（整条在原文里找不到）', () => {
    const text = '第一条 甲甲甲甲甲甲甲甲甲。第二条 运输机场运营人应当取得许可。';
    const window = neighborhoodForQuote(text, '甲甲甲甲甲甲甲甲甲……运输机场运营人应当取得许可。', 3);
    assert.notEqual(window, null);
    assert.ok(window.includes('运输机场运营人应当取得许可'), '用最长的那一段定位，窗口落在它周围');
  });

  it('引用不在原文里 / 文本为空 / 引用过短 ⇒ null（调用方据此说"没有邻域可用"）', () => {
    assert.equal(neighborhoodForQuote(TEXT, '这句话不在原文里，一个字都不在。', 5), null);
    assert.equal(neighborhoodForQuote('', '任意引用都行', 5), null);
    assert.equal(neighborhoodForQuote(TEXT, '第三条', 5), null, '短于门槛的段不参与定位');
    assert.equal(neighborhoodForQuote(TEXT, '   ', 5), null);
  });
});

describe('issue #49：提示词把输入与输出都交代清楚（三条端口纪律）', () => {
  it('系统提示词含六类判据、三种结论、只减不加与输出形状', () => {
    for (const rule of IMPACT_REVIEW_RULES) {
      assert.ok(IMPACT_REVIEW_SYSTEM_PROMPT.includes(rule.requirement), `缺规则 ${rule.id}`);
    }
    for (const status of IMPACT_REVIEW_VERDICT_STATUSES) {
      assert.ok(IMPACT_REVIEW_SYSTEM_PROMPT.includes(status), `缺结论 ${status}`);
    }
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /不许换引用/, '只减不加必须写在提示词里');
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /不许新增或删除判读条目/);
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /逐字一致/, '回显要求是接受层能核对的前提');
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /邻域/, '邻域是唯一的判断依据，必须交代');
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /不许凭常识/, '不许用输入之外的知识补事实');
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /判不出来就不给它加码/, 'fail-closed 的方向要写进规则');
  });

  it('用户消息含公示标题、判读四件、邻域，且邻域缺失时显式说明', () => {
    const prompt = impactReviewUserPrompt({
      title: '关于某规定的征求意见通知',
      items: [
        {
          quote: '运输机场运营人应当取得许可',
          who: '运输机场运营人',
          point: '',
          text: '取证成本可能上升。',
          neighborhood: '第一条 运输机场运营人应当取得许可。',
        },
        { quote: '第二句引用', who: '', point: '', text: '另一条推断。', neighborhood: null },
      ],
    });
    assert.match(prompt, /关于某规定的征求意见通知/);
    assert.match(prompt, /【第 1 条判读】/);
    assert.match(prompt, /【第 2 条判读】/);
    assert.match(prompt, /逐字引用：运输机场运营人应当取得许可/);
    assert.match(prompt, /推断正文：取证成本可能上升。/);
    assert.match(prompt, /前后各 200 字/, '邻域长度要在提示词里说清（模型据此判断依据范围）');
    assert.match(prompt, /没有邻域可用/, '邻域取不到时必须明说 —— 否则模型会拿引用自己当邻域');
    assert.match(prompt, /（未写明）/, '写不出的字段给占位，不留空行让模型以为漏读了');
  });

  it('邻域长度只写在常量里：提示词里的那个数必须与常量一致', () => {
    assert.match(IMPACT_REVIEW_SYSTEM_PROMPT, /前后一段原文/);
    const prompt = impactReviewUserPrompt({
      title: 't',
      items: [{ quote: 'q', who: 'w', point: 'p', text: 'x', neighborhood: 'n' }],
    });
    assert.ok(
      prompt.includes(String(IMPACT_REVIEW_NEIGHBORHOOD_CHARS)),
      '提示词里出现的那个数必须来自常量，不许另写一个字面量',
    );
  });
});
