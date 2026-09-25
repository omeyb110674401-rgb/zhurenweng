import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GENRE_LABELS, deriveNoticeGenre, genreDecisionWins } from '../../src/lib/notice-genre.ts';

/**
 * 单元（issue #76）：体裁判定的顺序与"不许兜底"。
 *
 * 这一组最值钱的不是各分支都过，而是**顺序**那两条：打包标准的标题里常带
 * "（修订征求意见稿）"，一旦先判修正，全站打包清单会被吞进修正案；名单类同理。
 * 都是生产里真有的标题形状，不是假想题。
 */

describe('issue #76：体裁判定', () => {
  it('修正案：附件名里的新旧对照表是决定性证据', () => {
    const d = deriveNoticeGenre({
      title: '关于公开征求《某某管理办法》意见的通知',
      attachmentNames: ['附件2：新旧对照表.docx'],
    });
    assert.equal(d.genre, 'amendment');
    assert.match(d.basis, /对照/);
  });

  it('修正案：附件正文的对照措辞优先于标题（标题没写"修正"也算）', () => {
    const d = deriveNoticeGenre({
      title: '关于公开征求《公路安全保护条例》意见的通知',
      attachmentNames: ['征求意见稿.doc'],
      attachmentText: '第三条修改为：……；删去第七条；增加一条作为第八条。',
    });
    assert.equal(d.genre, 'amendment');
    assert.match(d.basis, /修改为/);
  });

  it('只有标题证据时，basis 要写明"仅标题证据"（正文抽出来还会重算）', () => {
    const d = deriveNoticeGenre({ title: '企业破产法（修订草案二次审议稿）征求意见' });
    assert.equal(d.genre, 'amendment');
    assert.match(d.basis, /仅标题证据/);
  });

  it('打包清单不许被"修订"抢走（顺序判据）', () => {
    const d = deriveNoticeGenre({
      title: '关于公开征求《冶金企业煤气管道防泄漏排水安全要求》等11项强制性国家标准（修订征求意见稿）意见的函',
      attachmentNames: ['11项标准修订文本.zip'],
    });
    assert.equal(d.genre, 'package_plan', '先判打包，否则 11 项一起的项目会被当成单一修正案');
    assert.match(d.basis, /等\s*11\s*项|一项|多项/);
  });

  it('名单类最先判：它连条文都没有', () => {
    assert.equal(
      deriveNoticeGenre({ title: '关于公开征求全国动力电池回收利用标准化技术委员会组建委员名单意见的公示' }).genre,
      'list_or_result',
    );
  });

  it('新案：有草案形状、没有任何改现行文本的迹象', () => {
    const d = deriveNoticeGenre({
      title: '中国民航局关于《运输机场运营许可规定（征求意见稿）》公开征求意见的通知',
      attachmentNames: ['运输机场运营许可规定（征求意见稿）.pdf'],
      attachmentText: '第一条 为了规范运输机场运营许可……第二条 ……',
    });
    assert.equal(d.genre, 'new_draft');
    assert.match(d.basis, /无改现行文本/);
  });

  it('判不出来就是 unknown，不兜底成新案', () => {
    const d = deriveNoticeGenre({ title: '关于公开征求有关工作意见建议的通告' });
    assert.equal(d.genre, 'unknown');
    assert.match(d.basis, /不兜底/);
  });

  it('标准也用"修订"，它确实是改现行 ⇒ 归修正案', () => {
    assert.equal(
      deriveNoticeGenre({
        title: '住房城乡建设部办公厅关于国家标准《城市绿地设计标准（修订征求意见稿）》意见的函',
      }).genre,
      'amendment',
    );
  });

  it('展示名与枚举一一对应（后台与详情页角标共用同一份）', () => {
    assert.deepEqual(Object.keys(GENRE_LABELS).sort(), [
      'amendment',
      'list_or_result',
      'new_draft',
      'package_plan',
      'unknown',
    ]);
  });
});

describe('issue #76：证据强度覆盖规矩', () => {
  it('弱证据不覆盖强证据（正文级判定不能被标题级结果降回去）', () => {
    assert.equal(genreDecisionWins('title', 'attachment_text'), false);
    assert.equal(genreDecisionWins('attachment_names', 'attachment_text'), false);
    assert.equal(genreDecisionWins('none', 'title'), false);
  });

  it('强证据与同强度可以覆盖，存量（null）一律可以写入', () => {
    assert.equal(genreDecisionWins('attachment_text', 'title'), true);
    assert.equal(genreDecisionWins('title', 'title'), true, '同强度要能跟随标题变化重算');
    assert.equal(genreDecisionWins('none', null), true);
  });
});
