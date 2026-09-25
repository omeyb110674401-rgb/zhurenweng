import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  MAX_FILES_PER_NOTICE,
  MIN_DRAFT_CJK_CHARS,
  PROMPT_CHARS_PER_ATTACHMENT,
  countCjk,
  excerptForPrompt,
  hasDraftText,
  scoreAttachmentName,
  attachmentRole,
  selectAttachmentCandidates,
  shouldSkipByExtension,
} from '../../src/lib/attachment-select.ts';
import { parseAttachment } from '../../src/lib/attachments/parse.ts';

/**
 * 单元：附件打分与结构感知截取（issue #57）。
 *
 * 这两个函数决定「摘要到底看到了什么」，所以断言都朝着同一个失效模式钉：
 * **截取退化成「取前 N 字」时，测试必须变红**。前 N 字在真实附件里是封面 + 目录，
 * 「适用范围」（`who` 唯一来源）在第二章 —— 退化的实现会让整条链路白跑。
 */

const ELLIPSIS = '……（中间省略）……';

/** 造一份「真实形状」的长文：封面与目录在前，实质条文埋在两万字之后。 */
function longDraft(anchorAt = 20_000) {
  const scope = '第二条 适用范围：本文件适用于从事建筑活动的施工企业、监理单位和建设单位。';
  // 封面要真的够长才叫「埋在后段」：按 repeat 次数算长度，别用 slice 补出一个假位置
  const cover = '某某标准 发布文本 封面 XXXXXXXXXXXX'.repeat(Math.ceil(anchorAt / 30));
  const tail = '第十条 申报材料应当真实、准确、完整，不得虚假。'.repeat(600);
  return `${cover.slice(0, anchorAt - scope.length)}${scope}${tail}\n第三章 监督管理\n第四章 附则`;
}

describe('文件名打分与选取', () => {
  it('同一条公示里，草案要排在意见征求表前面', () => {
    const picked = selectAttachmentCandidates([
      { name: '建筑市场信用管理办法意见征求表.docx', url: 'https://e.gov.cn/a' },
      { name: '建筑市场信用管理办法（草案征求意见稿）.pdf', url: 'https://e.gov.cn/b' },
      { name: '附图.jpg', url: 'https://e.gov.cn/c' },
    ]);
    assert.equal(picked[0].name, '建筑市场信用管理办法（草案征求意见稿）.pdf');
    assert.ok(
      scoreAttachmentName('建筑市场信用管理办法意见征求表.docx') < scoreAttachmentName('某办法征求意见稿.pdf'),
      '「征求表」是填了寄回去的空白表，体积还最大 —— 按大小或按名字正序都会把它排第一',
    );
  });

  it('填报类给负分，条文类给正分', () => {
    assert.ok(scoreAttachmentName('某办法（征求意见稿）.pdf') > 0);
    assert.ok(scoreAttachmentName('意见反馈表.doc') < 0, '空白表的总分要压到负数才排不进前三');
    assert.ok(scoreAttachmentName('意见反馈表.doc') < scoreAttachmentName('某办法正文.doc'));
    assert.ok(scoreAttachmentName('某文件.pdf') > scoreAttachmentName('某文件'), '扩展名先验要起作用');
    assert.ok(scoreAttachmentName('某办法通知.docx') > scoreAttachmentName('某办法.txt'));
  });

  it('空白申报书与报名表排不进名额（samr 征集检验方法时的真实形状）', () => {
    assert.ok(scoreAttachmentName('食品补充检验方法立项申报书.docx') < 0, '那是要人填的模板，抽出来的字是表头');
    assert.ok(scoreAttachmentName('参加国际标准化组织报名表.doc') < 0);
    const picked = selectAttachmentCandidates([
      { name: '附件1 食品补充检验方法立项申报书.docx', url: 'u1' },
      { name: '附件2 食品快速检测方法立项申报书.docx', url: 'u2' },
      { name: '附件3 征集通知.pdf', url: 'u3' },
      { name: '附件4 方法清单.docx', url: 'u4' },
    ]);
    assert.deepEqual(
      picked.map((item) => item.url),
      ['u3', 'u4', 'u1'],
      '两个申报书挤在中间的话，正文反而进不了前三',
    );
  });

  it('压缩包与表格根本不下载，无扩展名的照常候选', () => {
    assert.equal(shouldSkipByExtension('标准文本.zip'), true);
    assert.equal(shouldSkipByExtension('填报表xlsx.xlsx'), true);
    assert.equal(shouldSkipByExtension('W020240918374552331299.pdf'), false);
    // cac / mohurd 的真实形态：名字在 fileName= 参数里，常常没有扩展名
    assert.equal(shouldSkipByExtension('关于征求某办法意见的通知'), false);
    const picked = selectAttachmentCandidates([
      { name: '正文.pdf', url: 'u1' },
      { name: '材料汇编.zip', url: 'u2' },
      { name: '统计表.xlsx', url: 'u3' },
      { name: '无扩展名的起草说明', url: 'u4' },
    ]);
    assert.deepEqual(
      picked.map((item) => item.url),
      ['u1', 'u4'],
    );
  });

  it('一条公示最多下 3 个文件', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `附件${i} 办法草案.pdf`, url: `u${i}` }));
    assert.equal(selectAttachmentCandidates(many).length, MAX_FILES_PER_NOTICE);
  });

  it('打分并列时保持页面原序（官方清单通常正文在前）', () => {
    const picked = selectAttachmentCandidates([
      { name: '甲办法.pdf', url: 'first' },
      { name: '乙办法.pdf', url: 'second' },
    ]);
    assert.deepEqual(
      picked.map((item) => item.url),
      ['first', 'second'],
    );
  });
});

describe('有没有条文正文', () => {
  it('countCjk 只数汉字，英文数字与下划线都不算', () => {
    assert.equal(countCjk('适用范围 ABC 123 ＿＿＿'), 4);
    assert.equal(countCjk(''), 0);
  });

  it('空白意见表判为没有正文，草稿判为有（阈值钉在真夹具上）', async () => {
    const blank = await parseAttachment({
      kind: 'docx',
      body: new Uint8Array(readFileSync(path.join('fixtures/e2e-attachments', 'blank-form.docx'))),
    });
    const draft = await parseAttachment({
      kind: 'docx',
      body: new Uint8Array(readFileSync(path.join('fixtures/e2e-attachments', 'draft.docx'))),
    });
    assert.equal(hasDraftText(blank.text), false, '2.2MB 的空白表被判成有正文，摘要就会对着下划线编条文');
    assert.ok(MIN_DRAFT_CJK_CHARS > 100, '阈值太低等于没判');
    assert.ok(
      countCjk(blank.text) < MIN_DRAFT_CJK_CHARS && countCjk(draft.text) > 0,
      `草稿 ${countCjk(draft.text)} 字 / 空白表 ${countCjk(blank.text)} 字`,
    );
  });
});

describe('excerptForPrompt：结构感知截取', () => {
  it('没超预算就原样返回，不注入省略标记', () => {
    const text = '第一条 适用范围：本办法适用于所有单位。';
    assert.equal(excerptForPrompt(text, 500), text);
  });

  it('红线：「适用范围」埋在两万字之后也必须被服务到', () => {
    const text = longDraft();
    const excerpt = excerptForPrompt(text, PROMPT_CHARS_PER_ATTACHMENT);
    assert.ok(
      excerpt.includes('适用范围：本文件适用于从事建筑活动的施工企业'),
      '抽不到「适用范围」= who 仍然没有依据，这一整段截取就白做',
    );
  });

  it('输出不超预算，且每一段都是原文的逐字子串（出处回查依赖它）', () => {
    const text = longDraft();
    const excerpt = excerptForPrompt(text, 4000);
    assert.ok(excerpt.length <= 4000, `超预算 ${excerpt.length}`);
    for (const chunk of excerpt.split(ELLIPSIS)) {
      const clean = chunk.replace('\n【全文结构（标题骨架）】\n', '').trim();
      if (clean === '') continue;
      assert.ok(text.includes(clean) || /^第[一二三四五六七八九十\d]+[章节编部分]/.test(clean), `这段不是原文：${clean.slice(0, 40)}`);
    }
  });

  it('拼接处要有省略标记，不能让模型以为原文连续', () => {
    const excerpt = excerptForPrompt(longDraft(), 2000);
    assert.ok(excerpt.includes(ELLIPSIS), '没有标记时模型会把两段缝成一句「原文」');
  });

  it('完全没有锚点词的长文退回取开头，不能截成空串', () => {
    const text = 'This standard describes test methods for concrete. '.repeat(1000);
    const excerpt = excerptForPrompt(text, 1500);
    assert.ok(excerpt.length > 1000, `只截出 ${excerpt.length} 字`);
    assert.ok(text.startsWith(excerpt.slice(0, 200)));
  });

  it('相邻锚点的窗口要合并，同一句条文不能出现两遍', () => {
    // 「第一条 适用范围」让两个锚点命中同一处，窗口几乎完全重叠
    const text = `前言。${'这里是没有信息量的封面文字。'.repeat(60)}第一条 适用范围：本办法适用于全部建设单位，其他单位参照执行。${'后附条文说明。'.repeat(400)}`;
    const excerpt = excerptForPrompt(text, 1500);
    const sentence = '第一条 适用范围：本办法适用于全部建设单位';
    const hits = excerpt.split(sentence).length - 1;
    assert.equal(hits, 1, `同一句出现了 ${hits} 次：窗口重叠时没合并，模型会以为条文重复了两遍`);
  });

  it('远处的章节标题以骨架形式补进来', () => {
    const excerpt = excerptForPrompt(longDraft(), 3000);
    assert.ok(excerpt.includes('第三章 监督管理'), '看不到骨架，模型会以为全文只有被选中的几条');
  });

  it('锚点出现几十次时窗口不铺满全文，仍留出预算', () => {
    const text = `封面 filler。${'适用于本单位的规定如下。'.repeat(3000)}`;
    const excerpt = excerptForPrompt(text, 2000);
    assert.ok(excerpt.length <= 2000);
    assert.ok(excerpt.length > 1500, '窗口互相吞并后退化成不截，预算应基本用满');
  });
});

/**
 * 附件角色与"给说明留一位"（issue #76 第 3 刀）。
 *
 * 生产底数：25 份说明类附件里 8 份压根没被下载，全部集中在"一条公示附件多于 3 个名额"
 * 的 3 条上。所以这一位不是理论优化，是把那 8 份捞回来的具体动作 —— 但前提写死在
 * 最后一条用例里：**不能为了说明把条文全挤掉**，说明是解释文本，规定本身在条文里。
 */
describe('附件角色（issue #76 第 3 刀）', () => {
  it('名字里带编制说明/起草说明的是 explanation', () => {
    assert.equal(attachmentRole('《某某标准》编制说明.docx'), 'explanation');
    assert.equal(attachmentRole('关于《公路法（修正草案）》的起草说明.wps'), 'explanation');
  });

  it('不收「说明」这个单字：使用说明/填写说明不是对草案的解读', () => {
    assert.notEqual(attachmentRole('系统使用说明.pdf'), 'explanation');
    assert.notEqual(attachmentRole('申报表填写说明.pdf'), 'explanation');
  });

  it('条文类是 draft，空白表格类是 other', () => {
    assert.equal(attachmentRole('某某法（修正草案征求意见稿）.docx'), 'draft');
    assert.equal(attachmentRole('项目立项申报汇总表.xlsx'), 'other');
  });
});

describe('给编制说明留一个下载名额（issue #76 第 3 刀）', () => {
  const allDraftsPlusExplanation = [
    { name: '甲标准（征求意见稿）.docx', url: 'https://a/1' },
    { name: '乙标准（征求意见稿）.docx', url: 'https://a/2' },
    { name: '丙标准（标准文本）.pdf', url: 'https://a/3' },
    { name: '丙标准编制说明.docx', url: 'https://a/4' },
  ];

  it('说明排不进前 3 时，换掉分数最低的最后一个名额', () => {
    const chosen = selectAttachmentCandidates(allDraftsPlusExplanation, 3).map((item) => item.name);
    assert.ok(chosen.includes('丙标准编制说明.docx'), `说明该被捞进来，实际：${chosen.join(' / ')}`);
    assert.equal(chosen.includes('丙标准（标准文本）.pdf'), false, '被换掉的应是并列分里排最后的那份');
    assert.ok(chosen.includes('甲标准（征求意见稿）.docx'), '条文不能被换掉');
  });

  it('本来就在名额里时不做任何换动', () => {
    const two = [
      { name: '某某法（草案征求意见稿）.docx', url: 'https://a/1' },
      { name: '某某法草案编制说明.docx', url: 'https://a/2' },
    ];
    const chosen = selectAttachmentCandidates(two, 3).map((item) => item.name);
    assert.deepEqual(chosen, ['某某法（草案征求意见稿）.docx', '某某法草案编制说明.docx'], '同分保持清单原序（官方页面通常正文在前）');
  });

  it('只有一个名额时不换：宁可不看说明，也不能只看说明', () => {
    const chosen = selectAttachmentCandidates(allDraftsPlusExplanation, 1).map((item) => item.name);
    assert.deepEqual(chosen, ['甲标准（征求意见稿）.docx']);
  });
});
