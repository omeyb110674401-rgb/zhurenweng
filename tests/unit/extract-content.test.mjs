import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as cheerio from 'cheerio';
import {
  blockText,
  extractDeadline,
  firstContentSelector,
} from '../../src/sources/adapters/extract.ts';

/**
 * 单元：正文抽取与截止日期抽取的两个缺陷修复（issue #24）。
 *
 * 两处都是**线上真实页面**暴露的：交通运输部「意见征集」栏目里混排了民航局与
 * 国家铁路局的条目，7 条入库后正文与截止日期全空（占全站 5%）。逐条定位后
 * 发现根因不在适配器的容器选择，而在两个共用工具：
 *
 * 1. `extractDeadline` 的引导词只允许**一个**字符（`(?:为|：|:)?`），而民航局写法是
 *    「意见反馈截止日期**为：**2026年10月7日」——「为」与「：」同时出现 → 整条抽不到；
 * 2. `blockText` 不剔除内联脚本，铁路局 `#Zoom` 容器里 `document.write(...)` 的
 *    脚本源码混进了正文（正文尾部出现 `if(xg_text!='' …)`）。
 *
 * 顺带把「多模板详情页」的容器探测抽成 `firstContentSelector`：按内容探测而不是按
 * host 分派，E2E 快照与生产才走同一条代码路径。
 */

describe('extractDeadline：引导词组合（为 / ：/ :）', () => {
  it('「为」与「：」同时出现也要能抽到（民航局实测写法）', () => {
    assert.equal(
      extractDeadline('意见反馈截止日期为：2026年10月7日'),
      '2026-10-07',
      '「截止日期为：X」是本次线上缺陷的原始写法',
    );
  });

  it('单引导词与无引导词的历史写法不回归', () => {
    assert.equal(extractDeadline('征求意见截止时间为2026年10月14日'), '2026-10-14');
    assert.equal(extractDeadline('截止日期：2026-10-14'), '2026-10-14');
    assert.equal(extractDeadline('截止日期:2026/10/14'), '2026-10-14');
    assert.equal(extractDeadline('截止时间为2026年10月14日'), '2026-10-14');
    assert.equal(extractDeadline('反馈截止日期为2026年10月7日'), '2026-10-07');
  });

  it('区间写法取结束日、「于…前」写法取该日期', () => {
    assert.equal(
      extractDeadline('征求意见时间为2026年3月20日至2026年4月19日'),
      '2026-04-19',
    );
    assert.equal(extractDeadline('请于2026年10月14日前反馈意见'), '2026-10-14');
  });

  it('没有截止句时返回 null（绝不用其它日期顶替）', () => {
    assert.equal(extractDeadline('本通知自发布之日起施行。'), null);
    assert.equal(extractDeadline('发布日期：2026年9月7日'), null, '发布日不是截止日');
    assert.equal(extractDeadline(undefined), null);
    assert.equal(extractDeadline(''), null);
  });
});

describe('blockText：剔除内联脚本', () => {
  it('容器内的 <script> / <style> 不混进正文（铁路局实测写法）', () => {
    const html = `
      <div id="Zoom">
        <p>国家铁路局关于《铁路交通事故调查处理规则（修订草案征求意见稿）》公开征求意见的通知</p>
        <p>反馈截止时间为2026年7月30日。</p>
        <script>
          var xg_text = '相关链接';
          if (xg_text != '') { document.write('<a href="">相关链接</a>'); }
        </script>
        <style>.hidden { display: none; }</style>
        <noscript>请开启 JavaScript</noscript>
      </div>`;
    const $ = cheerio.load(html);
    const text = blockText($, '#Zoom');

    assert.ok(text.includes('反馈截止时间为2026年7月30日'), '正文应保留');
    assert.ok(!text.includes('document.write'), '脚本源码不应出现在正文里');
    assert.ok(!text.includes('xg_text'), '脚本变量名不应出现在正文里');
    assert.ok(!text.includes('display: none'), '样式不应出现在正文里');
    assert.ok(!text.includes('请开启 JavaScript'), 'noscript 文案不应出现在正文里');
  });

  it('剔除脚本不影响调用方后续的附件收集（用克隆体，不改原树）', () => {
    const html = `
      <div class="content">
        <p>正文</p>
        <a href="./P020260908622963070372.docx">意见反馈表</a>
      </div>`;
    const $ = cheerio.load(html);
    blockText($, 'div.content');
    assert.equal(
      $('a[href]').length,
      1,
      'blockText 之后原文档树里的链接仍在（克隆后剔除，不就地删除）',
    );
  });
});

describe('firstContentSelector：多模板正文容器探测', () => {
  const page = (inner) => cheerio.load(`<html><body>${inner}</body></html>`);

  it('按序取第一个有正文的容器（三站模板各取各的）', () => {
    const selectors = ['#article-content', '#Zoom', 'div.content'];
    assert.equal(
      firstContentSelector(page('<div id="article-content"><p>本部正文</p></div>'), selectors),
      '#article-content',
    );
    assert.equal(
      firstContentSelector(page('<div id="Zoom"><p>铁路局正文</p></div>'), selectors),
      '#Zoom',
    );
    assert.equal(
      firstContentSelector(page('<div class="content"><p>民航局正文</p></div>'), selectors),
      'div.content',
    );
  });

  it('前面的容器存在但为空时继续往后探测（空壳不挡住正文）', () => {
    const html = '<div id="article-content"></div><div class="content"><p>民航局正文</p></div>';
    assert.equal(
      firstContentSelector(page(html), ['#article-content', '#Zoom', 'div.content']),
      'div.content',
    );
  });

  it('全部探测不到时返回 undefined（未知模板降级，不误取侧栏）', () => {
    assert.equal(
      firstContentSelector(page('<div class="sidebar"><p>侧栏</p></div>'), [
        '#article-content',
        '#Zoom',
        'div.content',
      ]),
      undefined,
    );
  });
});
