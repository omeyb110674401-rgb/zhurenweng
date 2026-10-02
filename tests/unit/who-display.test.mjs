import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { shouldRenderWho } from '../../src/lib/impact-display.ts';
import { buildQuotedSummary, parseQuotedSummary } from '../../src/lib/summary-content.ts';

/**
 * 单元：摘要卡「影响谁」的渲染判据 + 卡片内部的段落顺序（2026-10-02 两栏版式这一刀）。
 *
 * 三件事，一件都不能少：
 * 1. **判据本身**（`shouldRenderWho` 的真值表）：只在行业专业档、且文本非空时渲染。
 *    它与「可能的争议点」的门控**方向相反**（那段只给公众广域），所以两边的真值表
 *    都要在，否则改门控的人只会看见一半 —— 把两档都放开或都关掉，都有一半是静默的。
 * 2. **判据接在页面上**（源码接线）：判据写对了、页面没接上，是这一类改动最常见的断线，
 *    而详情页的 `.tsx` 在 e2e 里跑的是 `.next` 构建产物 —— 撤源码不会红。
 *    所以这条按**源码**钉（与 `tests/unit/feed-intake-note.test.mjs` 同一手法）。
 * 3. **段落顺序**（DOM 契约）：顺序本身是用户拍板的决定（规格第四节），
 *    而它是"看起来对、其实错位"那一类最容易在重构里被挪回去的东西。
 *
 * 「谁能提」为什么不再存在：字段本身已于 2026-10-02 删除（渲染先删，随后提示词 / 形状解析 /
 * 落库 / 检索 / 后台表单一起删）。删它的理由见 `summary-view.tsx` 的头注（96 条摘要里 95 条
 * 等价于"公众可提"、平均 10.4 字、28% 是空的 —— 它复述的是读者点进来之前就知道的事实）。
 * 靶子因此从"页面不渲染那一段"移到**摘要形状里没有这个键**，见下面那条用例。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * 按源码顺序取出段落 testid。
 *
 * 正则显式列出两种写法：`SectionBlock` 那几段把 id 写成 **`testId=` 属性**（组件再落到
 * DOM 的 `data-testid` 上），判读 / 改动表那几块直接写在元素上。只认一种写法，顺序断言就会
 * **静默漏掉**最要紧的那几段（「这是什么」「影响谁」「截止日期」「如何提意见」全是
 * `testId=`），于是把判读挪到卡片最后也照样绿 —— 那正是这条用例要防的事。
 * 也不图省事写成 `testid` 加 `i`：那会把注释里提到的 id 一并算进来（头注里就写着
 * `summary-placeholder`），顺序表跟着注释一起漂。
 */
function summaryTestIds(source) {
  return [...source.matchAll(/(?:data-testid|testId)="(summary-[a-z-]+)"/g)].map(
    (match) => match[1],
  );
}

describe('2026-10-02 两栏版式：「影响谁」给谁看', () => {
  it('行业专业 + 文本非空 ⇒ 渲染（这一档里受影响主体就是读者自己那一行）', () => {
    assert.equal(shouldRenderWho({ audience: 'sector', who: { text: '运输机场运营人' } }), true);
  });

  it('公众广域 ⇒ 不渲染（实测它是标题复述：把公示名称加上行业或主体）', () => {
    assert.equal(
      shouldRenderWho({ audience: 'public', who: { text: '受该草案影响的公众与相关主体' } }),
      false,
    );
  });

  it('行业专业但文本为空串 ⇒ 不渲染，连标题都不出现（#55 / #85 的教训）', () => {
    assert.equal(shouldRenderWho({ audience: 'sector', who: { text: '' } }), false);
    assert.equal(shouldRenderWho({ audience: 'sector', who: { text: '   ' } }), false, '只有空白也算空');
  });

  it('未判定 / 判不出来 ⇒ 不渲染（判不出来就不给它加码，与判读同规矩）', () => {
    assert.equal(shouldRenderWho({ audience: 'unknown', who: { text: '运输机场运营人' } }), false);
    assert.equal(shouldRenderWho({ audience: null, who: { text: '运输机场运营人' } }), false);
  });

  it('整段缺失（存量旧行）⇒ 不渲染，而不是抛错', () => {
    assert.equal(shouldRenderWho({ audience: 'sector', who: null }), false);
    assert.equal(shouldRenderWho({ audience: 'sector', who: undefined }), false);
  });
});

describe('2026-10-02 两栏版式：摘要卡的段落顺序与门控接线（源码）', () => {
  const source = readRepoFile('src/app/_lib/summary-view.tsx');

  it('摘要卡里的段落顺序是拍板的那一个（顺序本身是决定，别重排）', () => {
    const ids = summaryTestIds(source);
    assert.deepEqual(
      ids,
      [
        // 头注里提到的占位块契约（注释里的 id 也算进来了 —— 这条表按源码顺序取，见上面的注释）
        'summary-placeholder',
        'summary-quote', // SectionQuote 的锚点，出现在段落之前（它不是一个段落）
        'summary-what',
        'summary-who',
        'summary-impacts',
        'summary-impacts-note',
        'summary-impacts-overview',
        'summary-impacts-overview-who',
        'summary-impact-kind',
        'summary-impact-who',
        'summary-impact-source',
        'summary-after-deadline',
        'summary-key-points',
        'summary-draft-point-source',
        'summary-changes',
        'summary-change-coverage',
        'summary-change-table',
        'summary-change-row-fact',
        'summary-change-fact-note',
        'summary-change-row-described',
        'summary-change-source',
        'summary-explanations',
        'summary-explanation-coverage',
        'summary-explanation-heading',
        'summary-explanation-source',
        'summary-deadline',
        'summary-how-to-comment',
        'summary-sources',
        'summary-basis',
        'summary-model',
        'summary-unavailable',
        'summary-unavailable-label',
        'summary-not-generated',
        'summary-not-generated-label',
        'summary-placeholder',
        'summary-review-note',
      ],
      '段落顺序：这是什么 → 影响谁 → 可能的争议点（免责声明 → 概览行 → 主体行 → 逐条）→ 逾期会怎样 → 条文要点 → 改了哪几处 → 编制说明要点 → 截止日期 → 如何提意见',
    );
  });

  it('「可能的争议点」排在「这是什么」之后（判读上移，规格第一节第 7 条）', () => {
    const ids = summaryTestIds(source);
    assert.ok(
      ids.indexOf('summary-impacts') > ids.indexOf('summary-what'),
      '判读必须排在「这是什么」之后',
    );
    assert.ok(
      ids.indexOf('summary-impacts') < ids.indexOf('summary-key-points'),
      '判读要排在条文要点之前 —— 上移的是它，不是把证据推下去',
    );
  });

  /**
   * 这一条**换过靶子**（2026-10-02 删 `whoCanSubmit` 字段时）。
   *
   * 原来钉的是「`summary-who-can-submit` 节点与 `label="谁能提"` 都不许在页面上」——
   * 那在字段还在的时候是活的（数据能驱动那一段回来）。字段删掉之后它钉不住任何东西：
   * 没有数据能渲染出那一段，断言永远为真。而**永远为真的 pin 比没有 pin 更坏** ——
   * 下一轮的人会以为"这一段被验证过"，其实它连一次失败的机会都没有。
   *
   * 换成活的：这一刀删的是"我们不再生成、不再认识它"，所以靶子移到**形状**上 ——
   * ① 我们造出来的摘要里没有这个键；
   * ② 旧行（生产库里那 97 条）带着这个键，解析器照旧吃下、且**不许把它带进内存形状** ——
   *    带出来就等于字段还在，只不过没人渲染，而那正是这一刀要终结的状态。
   */
  it('摘要形状里不再有 `whoCanSubmit`：新产物没有这个键，带这个键的旧行读出来即丢弃', () => {
    const built = buildQuotedSummary({
      what: '这是什么',
      who: '',
      afterDeadline: '',
      deadline: null,
      howToComment: '如何提意见',
      channels: [],
    });
    assert.ok(
      !Object.hasOwn(built, 'whoCanSubmit'),
      '「谁能提」已删：buildQuotedSummary 的产物上不许再有这个键',
    );

    // 旧行：生产库里那 97 条摘要的形状（多一个 whoCanSubmit 段）
    const legacy = parseQuotedSummary({
      ...built,
      whoCanSubmit: { text: '社会各界均可提出意见', quote: '征求社会各界意见' },
    });
    assert.ok(legacy, '旧行必须照常解析 —— 读不出来它们会从「有摘要」掉回「待人工复核」占位');
    assert.ok(
      !Object.hasOwn(legacy, 'whoCanSubmit'),
      '多出来的键读出来即丢弃，不许进内存形状（否则字段只是"没人渲染"，不是删掉了）',
    );
    assert.equal(legacy.afterDeadline.text, '', '其余各段一个都不能少');
  });

  it('页面真的用了 shouldRenderWho（判据写对了却没接上，是这一类改动最常见的断线）', () => {
    assert.match(
      source,
      /shouldRenderWho\(\{ audience: notice\.audience, who: summary\.who \}\)/,
      '「影响谁」必须走 lib/impact-display.ts 的判据，而不是在 .tsx 里另写一个 if',
    );
  });

  /**
   * issue #88 第二刀：「影响点」三件的两处接线（每一条的「影响：主体 · 方面」行、块首概览）。
   *
   * 与上面那条 shouldRenderWho 同一手法、同一理由：判据写在 `lib/impact-display.ts` 里
   * （另有用例逐条钉着），而**页面有没有用它**在 e2e 里看不见 —— 详情页 `.tsx` 跑的是
   * `.next` 构建产物，撤掉源码不重建，页面照旧。判据对而页面没接上，正是这类改动最常见的断线。
   *
   * 判据取**调用**（名字后面跟左括号）而不是名字本身：两个名字在 import 行与注释里都出现过，
   * 撤一个名字等于什么都没撤。`from '@/lib/impact-display'` 那一句则拦住"页面里另写一个同名函数"。
   */
  it('页面真的用了 impactLine 与 impactOverview（判据写对了却没接上，是这一类改动最常见的断线）', () => {
    assert.match(
      source,
      /impactLine\(/,
      '每条判读那行「影响：主体 · 方面」必须走 impactLine —— 页面自己判 `impact.who ?` '
        + '会把"有方面没主体"的新形状整行吞掉',
    );
    assert.match(
      source,
      /impactOverview\(/,
      '块首概览（计数行 + 主体行）必须走 impactOverview —— 那两行没有模型兜底，页面里拼错就是错的',
    );
    assert.match(
      source,
      /import \{[^}]*impactLine[^}]*impactOverview[^}]*\} from '@\/lib\/impact-display'/,
      '两个判据都要从 lib/impact-display.ts 引入（页面里另写一个同名函数不算接上）',
    );
  });
});
