import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildChangeTable,
  changeTableCounts,
  changeTableRows,
  clauseOfSentence,
  isHeaderSentence,
  sentenceSpans,
} from '../../src/lib/change-table.ts';
import { changeTableNote, countChangeMarkers } from '../../src/lib/change-coverage.ts';
import { buildQuotedSummary, parseQuotedSummary } from '../../src/lib/summary-content.ts';

/**
 * 单元：「改了哪几处」那张表**行由程序定**（issue #86 第二十节第 3 小节）。
 *
 * 这一组钉的是一条产品不变量：**表里缺的只能是"某几行的说明"，不能是"整行"**。
 * 它替代的是原先那种形状 —— 表的内容整体来自模型，于是同一份输入跑四遍可以是
 * 8 / 2 / 3 / 8 行，而读者从页面上看不出来（§19.3 实测）。
 *
 * 夹具照《公路法（修正草案征求意见稿）》那一份的真实形状搭（§20.1 那张实测表）：
 * 一句术语统一的**总述**（一句里三处"修改为"）、编号条目、一个小标题、小标题下面的子条目。
 * 三个"看着像小问题"的地方都在里面：总述句没人描述、标题句含一处表述、子条目里有一句没被覆盖。
 */

const FULL = [
  '将“交通主管部门”统一修改为“交通运输主管部门”，将“贫困地区”修改为“欠发达地区”，将“利用贷款或者集资”修改为“利用贷款或者向企业、个人集资”。',
  '一、将第三十六条修改为：“国家采用依法征税的办法筹集公路管理养护资金。”',
  '二、增加一条，作为第六十八条：“收费公路的管理养护费用在车辆通行费中列支。”',
  '八、对部分条文作以下修改：',
  '（一）将相关条文中的“交通主管部门”统一修改为“交通运输主管部门”；',
  '（二）将第五条中的“贫困地区”修改为“欠发达地区”。',
].join('\n');

/** 只用到 quote —— 表要回答的是"这一行说的是哪一句"，不是"这一行写了什么" */
const row = (quote) => ({ quote });
const QUOTE_36 = '将第三十六条修改为：“国家采用依法征税的办法筹集公路管理养护资金。';
const QUOTE_5 = '将第五条中的“贫困地区”修改为“欠发达地区”';

describe('issue #86 §20.3：表里的行由程序定', () => {
  it('每一句一行：模型写出的行照旧、没写出的行只报事实、标题句不单独成行', () => {
    const table = buildChangeTable(FULL, [row(QUOTE_36), row(QUOTE_5)]);
    const shape = table.entries.map((entry) =>
      entry.type === 'described' ? `described#${entry.change}` : `fact(${entry.clause || '—'})`,
    );
    assert.deepEqual(
      shape,
      ['fact(—)', 'described#0', 'fact(第六十八条)', 'fact(—)', 'described#1'],
      '顺序 = 正文顺序；总述句（三处表述、没有可核对说明）与子条目（一）各占一行',
    );
    assert.equal(table.headers, 1, '「八、对部分条文作以下修改：」下面挂着子条目 ⇒ 不单独成行');
  });

  it('**一行都不许丢**：引的原文落不到任何一句里时，补在表尾而不是消失', () => {
    // 反查那一关会把引不到的整行丢掉，所以这个输入"不该发生" —— 但表不能靠它不发生来保证不少行
    const table = buildChangeTable(FULL, [row(QUOTE_36), row('这段话在任何一份正文里都不存在')]);
    const described = table.entries.filter((entry) => entry.type === 'described');
    assert.deepEqual(
      described.map((entry) => entry.change),
      [0, 1],
      '找不着归属的那一行补在表尾：顺序略偏，但不能不见',
    );
  });

  it('同一句被两行描述 ⇒ 两行都在（合并成一行就会白丢一条说明）', () => {
    const table = buildChangeTable(FULL, [row(QUOTE_36), row('一、将第三十六条修改为：')]);
    const described = table.entries.filter((entry) => entry.type === 'described');
    assert.deepEqual(described.map((entry) => entry.change), [0, 1]);
  });

  it('一条改动说明永远只出现一次（表 + 反查两处都不许复制它）', () => {
    const changes = [row(QUOTE_36), row(QUOTE_5), row('不在正文里的一句话')];
    const table = buildChangeTable(FULL, changes);
    const seen = table.entries.filter((entry) => entry.type === 'described').map((entry) => entry.change);
    assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2]);
    assert.equal(new Set(seen).size, seen.length);
  });

  it('模型把附件里的换行压成一行 ⇒ 仍然归得到那一句（与落库反查同一把尺子）', () => {
    const text = '一、将第五条中的\n“贫困地区”修改为\n“欠发达地区”。';
    const table = buildChangeTable(text, [row('将第五条中的“贫困地区”修改为“欠发达地区”')]);
    assert.deepEqual(table.entries, [{ type: 'described', change: 0 }]);
  });

  it('跨句的引用归到它碰到的第一句**带改动表述**的句子（引用里带分号时，整条包含判会判成没归属）', () => {
    const text =
      '一、将第五十九条修改为：“符合下列条件的公路，可以收费：\n“（一）由地方人民政府依法举借债务建成的公路；\n“（二）由国内外经济组织依法投资建成的公路。”';
    const table = buildChangeTable(text, [row('将第五十九条修改为：“符合下列条件的公路，可以收费：')]);
    assert.deepEqual(table.entries, [{ type: 'described', change: 0 }], '归到第一句，而不是补到表尾');
  });

  it('数不到改动表述 ⇒ 不给表（页面退回"只列模型写出的行"）', () => {
    const table = buildChangeTable('这份文件通篇没有一处改动表述。', [row(QUOTE_36)]);
    assert.deepEqual(table, { entries: [], headers: 0 });
  });

  it('空文本不抛错', () => {
    assert.deepEqual(buildChangeTable('', []), { entries: [], headers: 0 });
  });
});

describe('issue #86 §20.3：按句切分与条号、标题判据（判据写出来，不靠"看着像"）', () => {
  it('句边界是中文句读与换行（引号里的句号照样断句 —— 这是实测踩过的那一处）', () => {
    const spans = sentenceSpans('甲。乙；丙！丁？\n戊');
    assert.deepEqual(
      spans.map((span) => '甲。乙；丙！丁？\n戊'.slice(span.start, span.end)),
      ['甲。', '乙；', '丙！', '丁？', '\n', '戊'],
    );
  });

  it('条号抽得到就抽（含款），抽不到给空串 —— 空串让页面印破折号，不是编一个编号', () => {
    assert.equal(clauseOfSentence('一、将第三十六条修改为：“……”。'), '第三十六条');
    assert.equal(clauseOfSentence('将第六十条第一款修改为：“……”。'), '第六十条第一款');
    assert.equal(clauseOfSentence('将“交通主管部门”统一修改为“交通运输主管部门”。'), '');
  });

  it('标题判据两条都要满足：句中没有引号引起来的条款内容 + 紧跟着的是子条目', () => {
    assert.equal(isHeaderSentence('八、对部分条文作以下修改：', ['（一）将相关条文中的……；']), true);
    assert.equal(
      isHeaderSentence('八、对部分条文作以下修改：', ['这一句不是子条目']),
      false,
      '没有子条目 ⇒ 它也可能真是一句改动表述，不能当成标题藏起来',
    );
    assert.equal(
      isHeaderSentence('八、将“甲”修改为“乙”。', ['（一）将相关条文中的……；']),
      false,
      '句中有引号引起来的条款内容 ⇒ 它是一句真改动，哪怕后面挂着子条目',
    );
    assert.equal(
      isHeaderSentence('八、对部分条文作以下修改：', [undefined]),
      false,
      '后面什么都没有 ⇒ 不判标题',
    );
  });
});

describe('issue #86 §20.3：那一句交代（新增的行数要说得出来）', () => {
  it('有只报事实的行 ⇒ 说清几行有说明、几行没有；有几行是标题也照说', () => {
    const note = changeTableNote({ markers: 14, rows: 10, described: 8, factOnly: 2, headers: 1 });
    assert.equal(note.rows, 10);
    assert.equal(note.factOnly, 2);
    assert.match(note.detail, /检测到 14 处修改表述/);
    assert.match(note.detail, /按句归并成 10 行/);
    assert.match(note.detail, /8 行附了逐字原文与可核对的说明/);
    assert.match(note.detail, /2 行只报「检测到改动表述」这一事实/);
    assert.match(note.detail, /另有 1 句是小标题（不含条款内容），不单独列行/);
    assert.match(note.detail, /检测按本站读到的全部附件正文数/);
    // 分母不是"改了几条"：一句里可以数出三处，这个数不许被说成条款数
    assert.doesNotMatch(note.detail, /共 ?\d+ ?条(?:改动|修改)/);
  });

  it('每一行都有说明 ⇒ 不说"其中几行只报事实"（没缺就不许提缺口）', () => {
    const note = changeTableNote({ markers: 3, rows: 3, described: 3, factOnly: 0, headers: 0 });
    assert.match(note.detail, /3 行都附了逐字原文与可核对的说明/);
    assert.doesNotMatch(note.detail, /只报/);
    assert.doesNotMatch(note.detail, /小标题/);
  });

  it('数不到改动表述 ⇒ 不给「共几处」', () => {
    const note = changeTableNote({ markers: 0, rows: 0, described: 0, factOnly: 0, headers: 0 });
    assert.doesNotMatch(note.detail, /共 0 处/);
    assert.match(note.detail, /没有数到成文的修改表述/);
  });
});

describe('issue #86 §20.3：页面渲染哪几行（页面与验收脚本共用同一份判据）', () => {
  it('没有表就走旧形状：存量摘要照旧只列模型写出的行', () => {
    // 这一版之前落库的摘要没有 changeTable 这个键（生产里是绝大多数）。
    // 判据分家过一次的代价见 README 里"量具自己说谎"那一族：页面与验收脚本各判一次，
    // 就会一个印新形状、一个印旧形状。
    const rows = changeTableRows([{ quote: '甲' }, { quote: '乙' }], null);
    assert.deepEqual(rows, [
      { type: 'described', change: 0 },
      { type: 'described', change: 1 },
    ]);
  });

  it('有表就按表的行序（含只报事实的那几行、且不再重复列出模型的行）', () => {
    const table = {
      entries: [
        { type: 'fact', clause: '', kinds: ['modify'], sentence: '甲。' },
        { type: 'described', change: 1 },
        { type: 'described', change: 0 },
      ],
      headers: 0,
    };
    assert.deepEqual(changeTableRows([{ quote: '甲' }, { quote: '乙' }], table), table.entries);
  });

  it('空表当作没有表（否则那一段会渲染成一张空白表）', () => {
    const rows = changeTableRows([{ quote: '甲' }], { entries: [], headers: 0 });
    assert.deepEqual(rows, [{ type: 'described', change: 0 }]);
  });

  it('数得出几行有说明、几行只报事实（页面与验收脚本共用这一份）', () => {
    const counts = changeTableCounts([
      { type: 'fact', clause: '第七条', kinds: ['delete'], sentence: '删去第七条第二款。' },
      { type: 'described', change: 0 },
      { type: 'fact', clause: '', kinds: ['modify'], sentence: '将“甲”修改为“乙”。' },
    ]);
    assert.deepEqual(counts, { described: 1, factOnly: 2 });
  });
});

describe('issue #86 §20.3：落库形状（新增的键要与旧行共存）', () => {
  const DRAFT = { name: '草案.docx', url: 'https://example.gov.cn/a.docx', text: FULL };

  function build() {
    const summary = buildQuotedSummary(
      {
        what: '这是什么',
        who: '',
        whoCanSubmit: '',
        afterDeadline: '',
        deadline: null,
        howToComment: '如何提意见',
        channels: [],
        changes: [
          { clause: '第三十六条', kind: 'modify', text: '改由依法征税筹集', quote: QUOTE_36 },
        ],
      },
      undefined,
      [DRAFT],
      null,
      countChangeMarkers(FULL),
    );
    // 表由 worker 在反查之后补上（与 worker/jobs/summarize-notices.ts 同一手法）
    return { ...summary, changeTable: buildChangeTable(FULL, summary.changes) };
  }

  it('build → parse 等价（表连同它的行序一起落库、一起读回）', () => {
    const built = build();
    assert.ok(built.changeTable, '有改动表述就该有表');
    const parsed = parseQuotedSummary(JSON.parse(JSON.stringify(built)));
    assert.deepEqual(parsed, built);
  });

  it('buildQuotedSummary 自己给的是 null（表要等 changes 定下来才知道缺口）', () => {
    const built = buildQuotedSummary(
      { what: '这是什么', who: '', whoCanSubmit: '', afterDeadline: '', deadline: null, howToComment: '如何提意见', channels: [], changes: [] },
      undefined,
      [DRAFT],
      null,
      countChangeMarkers(FULL),
    );
    assert.equal(built.changeTable, null);
  });

  it('**没有这个键的旧行**照常解析（新键不许把存量条目打回占位）', () => {
    const raw = JSON.parse(JSON.stringify(build()));
    delete raw.changeTable;
    const parsed = parseQuotedSummary(raw);
    assert.ok(parsed);
    assert.equal(parsed.changeTable, null, 'null = 页面退回"只列模型写出的行"，不是形状异常');
    assert.equal(parsed.changes.length, 1);
  });

  it('单行形状不对 ⇒ 只跳过那一行，不判整行摘要异常', () => {
    const raw = JSON.parse(JSON.stringify(build()));
    raw.changeTable.entries = [
      { type: 'described', change: 0 },
      { type: 'described', change: '第三十六条' },
      { type: 'fact', sentence: '   ' },
      { type: 'fact', clause: '第五条', kinds: ['modify', '莫名其妙'], sentence: QUOTE_5 },
    ];
    raw.changeTable.headers = -3;
    const parsed = parseQuotedSummary(raw);
    assert.ok(parsed, '脏行绝不能让整页掉回占位（#85 第三节的教训）');
    assert.deepEqual(parsed.changeTable, {
      entries: [
        { type: 'described', change: 0 },
        { type: 'fact', clause: '第五条', kinds: ['modify'], sentence: QUOTE_5 },
      ],
      headers: 0,
    });
  });

  it('一行都不剩的表当作"没有表"（README 里那条：空壳比没有更坏）', () => {
    const raw = JSON.parse(JSON.stringify(build()));
    raw.changeTable.entries = [{ type: 'described', change: -1 }];
    assert.equal(parseQuotedSummary(raw).changeTable, null);
  });
});
