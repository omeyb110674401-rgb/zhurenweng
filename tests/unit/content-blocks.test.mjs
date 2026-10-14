import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * 单元：内容区块各自是一个独立容器（2026-10-05 用户拍板）。
 *
 * ## 这一刀要挡的是什么
 *
 * 改动前，详情页摘要卡里的九段（这是什么 / 影响谁 / 可能的争议点 / 逾期会怎样 /
 * 草案条文要点 / 改了哪几处 / 编制说明要点 / 截止日期 / 如何提意见）**共处
 * `.summary-sections` 一个容器**里，逐区块量出来的读数是九段全都
 * "边框 0 / 圆角 0 / 内边距 0 / 背景透明" —— 块与块之间唯一的界线是 12px 空隙；
 * 「分步提意指引」与摘要卡之间靠一条 `.detail-main > .how-to { border-top }` 打补丁；
 * 右栏那四件（CTA / 意见提交方式 / 出站提意点击 / 订阅提醒）全挤在 `.action-slot`
 * **同一个**白卡里。于是"这一段到哪儿为止"要读者自己找。
 *
 * ## 为什么这一组按**源码**钉，而不是按渲染结果
 *
 * 与 `tests/unit/who-display.test.mjs` 同一手法、同一理由：判据住在 `.tsx` 与
 * `globals.css` 里，而 e2e 跑的是 `.next` 构建产物 —— 撤掉源码不重建，页面照旧，
 * 断言不会红（假绿）。所以这里直读源码；渲染出来的几何由
 * `scripts/measure-rendered-geometry.mjs` 那一路人工量（本轮量过，见下方各条的注释）。
 *
 * ## 这一组**不**钉什么
 *
 * 不钉像素、不钉颜色值以外的观感、不钉"间距多大好看"。钉的是三件事：
 * ① 每个内容块真的挂上了那条边界；② 曾经共用容器的两处（摘要九段 / 右栏四件）
 * 不许退回去；③ 为了保住行宽读数而刻意写下的两处内边距不许被"顺手调回来"。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readRepoFile(relative) {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

/**
 * 去掉 CSS 注释之后再断言"某条规则不许存在"。
 *
 * 本轮踩到过：注释里写着"改动前这里有一条 `.detail-main > .how-to { border-top }` 的打补丁
 * 规则"，于是 `css.includes('.detail-main > .how-to')` 恒为真 —— 一条**永远为真**的断言
 * 比没有断言更坏（下一轮的人会以为这条被验证过，其实它连一次失败的机会都没有）。
 * 所以"不许存在"一律看**规则**本身。
 */
function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

const css = readRepoFile('src/app/globals.css');
/** 只有规则、没有注释的那一份：给"不许存在"与"取规则体"用。 */
const cssRules = stripCssComments(css);

/** 取某条 CSS 规则声明的属性文本（`{` 起、第一个 `}` 止）—— 与 e2e 那份 helper 同一手法。 */
function ruleBody(source, selector) {
  const at = source.indexOf(selector);
  assert.ok(at >= 0, `globals.css 应存在规则 ${selector}`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  assert.ok(open > 0 && close > open, `${selector} 的规则块不完整`);
  return source.slice(open + 1, close);
}

describe('2026-10-05 内容区块：每个区块一个独立容器', () => {
  it('边界的唯一定义处给出四件套（白底 / 描边 / 圆角 / 内边距）', () => {
    const block = ruleBody(cssRules, '.content-block,');
    // 2026-10-07：色值做了两层令牌化（primitive 在 `:root` 顶部，semantic 指向它），
    // 白底现在写作 `var(--c-white)`。断言的语义仍是"白底"这一件事，只是认得 token 形式。
    assert.match(block, /background:\s*(?:#fff|var\(--c-white\))/, '白底');
    assert.match(block, /border:\s*1px solid var\(--line\)/, '1px 描边（与全站既有卡片同一条线）');
    assert.match(block, /border-radius:\s*8px/, '圆角与全站其它卡片同值');
    assert.match(block, /padding:\s*14px 16px/, '内边距 —— 没有它，边界贴着文字，等于没边界');
  });

  /**
   * 九段由**五处**元素渲染：`SectionBlock`（这是什么 / 影响谁 / 逾期会怎样 / 截止日期 /
   * 如何提意见）一处，判读 / 条文要点 / 改动表 / 编制说明各自内联一处。
   * 断言"一处都不许是裸的"而不是"至少有几处挂了类" —— 前者才挡得住"改了一半"。
   */
  it('摘要卡的九段全都挂着 content-block —— 不能只有部分段落有边界', () => {
    const view = readRepoFile('src/app/_lib/summary-view.tsx');
    assert.equal(
      [...view.matchAll(/className="summary-section"/g)].length,
      0,
      '裸的 summary-section 一处都不许剩（剩一处就是"这一段又跟邻段长成一样了"）',
    );
    assert.equal(
      [...view.matchAll(/className="summary-section content-block"/g)].length,
      5,
      '五处渲染点都要挂：SectionBlock 一处 + 判读 / 条文要点 / 改动表 / 编制说明四处',
    );
  });

  it('详情页其余各块也各是独立容器', () => {
    const page = readRepoFile('src/app/notices/[id]/page.tsx');
    for (const className of [
      'how-to content-block',
      'notice-body content-block',
      'click-stats content-block',
      'subscribe-hint content-block',
    ]) {
      assert.ok(
        page.includes(`className="${className}"`),
        `${className} 必须是自己的容器（改动前它要么裸着、要么与邻块共处一个卡片）`,
      );
    }
  });

  /**
   * 附件清单这一块**故意**由 CSS 那边认领：`tests/e2e/detail-layout.test.mjs` 用
   * `class="attachments"` 精确断言（引号是断言的一部分），加一个类名会让那条守卫变红 ——
   * 而它是"附件清单在主栏内"的守卫，不该为了这一刀改。所以这里钉的是 CSS 名单里有它。
   */
  it('附件清单的边界由 CSS 那条认领（e2e 精确断言它的 class，不许动）', () => {
    assert.match(
      css,
      /\.content-block,\s*\.attachments\s*\{/,
      '`.attachments` 必须列在边界那一条的选择器名单里',
    );
    assert.match(
      readRepoFile('tests/e2e/detail-layout.test.mjs'),
      /class="attachments"/,
      '那条精确断言仍在（它若被删掉，说明有人改成给元素加类名了 —— 请改回 CSS 认领）',
    );
  });

  /**
   * 右栏那一刀：`.action-slot` 从"一张白卡装四件"退回**纯摆放**。
   * 它自己一旦再给边界，四件就又变成"四张小卡套在一张大卡里"。
   */
  it('右栏不再是「一个卡片装四件」', () => {
    const slot = ruleBody(cssRules, '.action-slot {');
    assert.match(slot, /display:\s*flex/, '竖排由 flex 给');
    assert.match(slot, /gap:\s*12px/, '栏内间距只由 gap 给');
    assert.doesNotMatch(slot, /background/, '.action-slot 不许再给自己底色（那是共用卡片回来了）');
    assert.doesNotMatch(slot, /border/, '.action-slot 不许再给自己描边（同上）');
    assert.match(
      cssRules,
      /\.action-slot > \* \{[^}]*margin-top:\s*0/,
      '栏内那几件各自还带着旧的上外边距，抹平那条不许删（删了间距会与 gap 叠成 22–26px）',
    );
    /*
     * 2026-10-07 加强：从"规则**存在**"升级为"规则**真的生效**"。
     *
     * 上面那条 assert.match 只证明文件里写着 `.action-slot > * { margin-top: 0 }` ——
     * 而它此前恰好被**后写的**三条规则静默覆盖（`.click-stats` / `.subscribe-hint` /
     * `.channels` 各自还带 margin，特异性同为 (0,1,0)，后写者胜），右栏实际间距因此是
     * gap 12px **加上** 14/10/12px。也就是说那条断言**看着在守、其实守不住**：
     * 实测（1440×900，逐元素读计算样式）栏内空档是 26/22/24px，不是 12px。
     *
     * 判据取"源顺序"：抹平那一条靠"后写者胜"生效，所以它必须出现在栏内所有可能带
     * margin 的规则**之后**（当前是 `.channels` 之后）。移到前面 = 静默失效，
     * 而这正是它此前失效的方式。
     */
    const flattenAt = cssRules.indexOf('.action-slot > * {');
    const lastMarginOwner = Math.max(
      cssRules.indexOf('.click-stats {'),
      cssRules.indexOf('.subscribe-hint {'),
      cssRules.indexOf('.channels {'),
    );
    assert.ok(flattenAt >= 0, '抹平那条规则必须在（见上）');
    assert.ok(lastMarginOwner >= 0, '栏内那几件的规则必须在（它们各带旧的上外边距）');
    assert.ok(
      flattenAt > lastMarginOwner,
      '抹平那条必须写在 `.click-stats` / `.subscribe-hint` / `.channels` **之后** —— '
        + '三者的特异性与它同为 (0,1,0)，靠"后写者胜"生效；写在前面会被静默覆盖，'
        + '右栏间距于是变回 gap + 14/10/12px（实测 26/22/24px），而上面那条断言照样绿。',
    );
  });

  it('打补丁式的分隔线不许回来（边界各自成立后它已无必要）', () => {
    assert.ok(
      !/\.detail-main\s*>\s*\.how-to\s*\{/.test(cssRules),
      '`.detail-main > .how-to { border-top }` 是"两块共用一个容器、只好画一条线"的补丁；'
        + '边界各自成立之后它应当消失，重新出现说明某一块的边界又没了',
    );
  });

  /**
   * 行宽读数（量具 `scripts/measure-rendered-geometry.mjs` 的同一套指标）。
   *
   * **2026-10-07 更新**：正文档从 14px 升到 16px（用户要的"字大一点"），读数随之变化 ——
   * `.summary-section-text` 1440px 视口 **40** 字/行、375px 视口 **16**；
   * `.body-text` 1440px **42**、375px **19**。
   * （升级前是 44 / 19 与 44 / 22；变了是因为 `max-inline-size: 44em` 这个上限在更大的
   * 字号下不再咬合 —— 44em 从 616px 涨到 704px，宽屏主栏的内容盒反而装不下，行宽于是
   * 改由容器宽度决定。**上限本身没动，它要守的"不许通栏长行"也没有变。**）
   *
   * 保住这些读数的正是下面两条"反直觉的内边距"：外卡的水平内边距缩到 4px（缩进交给
   * 子块），正文块的水平内边距留 0（缩进由 `.body-text` 自己给）。两级内边距一叠，
   * 两处读数都会掉（升级前的实测口径：外卡写 16px 时窄屏 19 → 17；正文块写 16px 时
   * 22 → 19）。所以这两条要钉住。
   */
  it('两级内边距不许叠（否则行宽读数会掉）', () => {
    assert.match(
      ruleBody(cssRules, '.summary-card {'),
      /padding:\s*14px 4px/,
      '摘要外卡的水平内边距必须留 4px —— 与子块的内边距叠起来会把行宽吃掉两遍',
    );
    assert.match(
      ruleBody(cssRules, '.notice-body {'),
      /padding:\s*14px 0/,
      '正文块的水平内边距必须是 0 —— 原文那一段自己带 16px 缩进（`.body-text`）',
    );
    assert.match(ruleBody(cssRules, '.body-text {'), /max-inline-size:\s*44em/, '正文行宽上限仍在');
    assert.match(
      ruleBody(cssRules, '.summary-section-text {'),
      /max-inline-size:\s*44em/,
      '摘要各段行宽上限仍在',
    );
  });

  it('统计页 / 订阅页 / 对比页的区块同样各成一块', () => {
    // 对比页那两个是 `diff-version diff-version-old|new content-block`（三件套的类名），
    // 所以这一栏按**正则**数，不按前缀数 —— 前缀数不出"三件套里有没有第三件"。
    const cases = [
      ['src/app/stats/page.tsx', /className="stats-section content-block"/g, 5],
      ['src/app/subscribe/page.tsx', /className="subscribe-section content-block"/g, 2],
      ['src/app/notices/[id]/diff/page.tsx', /className="diff-version diff-version-(?:old|new) content-block"/g, 2],
    ];
    for (const [file, matcher, count] of cases) {
      assert.equal(
        [...readRepoFile(file).matchAll(matcher)].length,
        count,
        `${file} 里 ${matcher.source} 应恰好 ${count} 处（少一处就是那一块又裸着了）`,
      );
    }
  });

  it('订阅表单不再自己做一张卡（卡里套卡）', () => {
    const form = ruleBody(cssRules, '.subscribe-form {');
    assert.doesNotMatch(form, /background/, '表单自己再给白底 ⇒ 区块卡片里套了一张卡');
    assert.doesNotMatch(form, /border/, '同上');
  });
});

/**
 * 第二组：**块内部**的层级（2026-10-05，加完容器边界之后从截图里量出来的缺陷）。
 *
 * 加边界解决的是"块与块之间"，没解决"块内谁主谁次"。实测（375px 视口，逐元素读计算样式）：
 * `.summary-section-note`（块级免责声明）与 `.impact-kind`（每条判读的类型标签）**在
 * globals.css 里一条规则都没有** —— 全仓只有 .tsx 在用这两个类名，于是它们退回
 * **浏览器默认段落**：16px、正文黑（--ink）、默认 16px 上下外边距。后果两条：
 *
 * ① **层级倒置**：整块里最大的字是免责声明（102px 高、5 行）与类型标签（16px），
 *    而真正的推断正文 `.summary-section-text` 只有 14px —— 元信息压过了内容；
 * ② `.impact-kind` 那对默认外边距在**兼任**每条判读之间的气口（`li` margin 0、`ul` gap 8px），
 *    每条凭空多 32px 空白。
 *
 * 这一组钉的就是"这两条修补许被删回去"，以及由它派生出来的字号阶梯与分隔线。
 */
describe('2026-10-05 摘要卡块内层级：元信息不许比内容更大', () => {
  /**
   * 从规则体里读 font-size 的像素值（读不出来就是没写 —— 那正是本组要挡的事）。
   *
   * 2026-10-07：样式表的 101 处 font-size 已**全量改成 rem**（px 站完全不跟随浏览器的
   * "默认字号"，rem 站才跟随 —— 那是适老化的第一杠杆），所以这里两种单位都要认。
   * 折算成同一个口径再比较，是因为这条用例问的是"**谁比谁大**"这个阶梯关系，
   * 不是"写的是哪种单位"；换算用 1rem = 16px，与本文件 `html` 未设 font-size 的
   * 默认口径一致。断言本身一个字都没改。
   */
  const REM_IN_PX = 16;
  function fontSizeOf(selector) {
    const match = /font-size:\s*(\d+(?:\.\d+)?)(px|rem)/.exec(ruleBody(cssRules, selector));
    assert.ok(match, `${selector} 应显式给 font-size（不写就退回浏览器默认的 16px）`);
    return Number(match[1]) * (match[2] === 'rem' ? REM_IN_PX : 1);
  }

  it('元信息类名必须有自己的规则（无规则就退回浏览器默认：16px 正文黑）', () => {
    // `ruleBody` 在找不到选择器时就断言失败，所以"规则被删/被改名"当场红
    assert.match(ruleBody(cssRules, '.summary-section-note {'), /color:\s*var\(--ink-soft\)/,
      '免责声明与两处覆盖度说明共用这个类名（3 处），它必须是灰一档的元信息');
    assert.match(ruleBody(cssRules, '.impact-kind {'), /font-weight:\s*600/,
      '每条判读的类型标签必须是个标签，不能是默认段落');
  });

  it('字号阶梯：类型标签 < 元信息 ≤ 推断正文', () => {
    const body = fontSizeOf('.summary-section-text {');
    const kind = fontSizeOf('.impact-kind {');
    const note = fontSizeOf('.summary-section-note {');
    const overview = fontSizeOf('.impact-overview,');
    assert.ok(kind < body, `类型标签（${kind}px）必须小于推断正文（${body}px）—— 反了就是"标题 + 小字"`);
    assert.ok(note <= body, `免责声明（${note}px）不许大过它标注的正文（${body}px）`);
    assert.ok(overview <= body, `概览行（${overview}px）不许大过正文（${body}px）`);
  });

  it('气口改由清单自己的分隔线给，不再靠默认外边距', () => {
    assert.doesNotMatch(cssRules, /\.impact-kind[^}]*margin:\s*16px/,
      '类型标签不许再带浏览器默认的那对 16px 外边距（它此前在兼任条目之间的分隔）');
    assert.match(
      ruleBody(cssRules, '.summary-points li + li {'),
      /border-top:\s*1px solid var\(--line\)/,
      '条目之间的分隔线是那条外边距的替代品，删了三条列表（判读 / 条文要点 / 编制说明）会糊成一片',
    );
  });
});

/**
 * 第三组：**类名审计** —— 写了 `className` 就必须有规则（或在"有意无样式"清单里）。
 *
 * 为什么值得单开一条：上面那个缺陷的根因是"类名写了、规则没写"，而它**不报错、不红、
 * 没有任何门能发现**，视觉于是落在**浏览器默认值**上 —— 直到有人把页面渲染出来看。
 * 全仓扫一遍的读数（2026-10-05）：186 个类名在用，其中 9 个没有规则，逐个看过之后
 * 只有 `.summary-section-note` / `.impact-kind` 是真的（其余是模板串前缀或有意留白的钩子，
 * 见下面那张清单）。这类"静默生效的默认值"会随每次改版再长出来，所以把清单钉在这里：
 * 新写一个没有规则的类名，这条就会红，作者必须在"补规则"与"登记进清单"之间做个选择。
 */
describe('2026-10-05 类名审计：写了 className 就必须有规则', () => {
  /**
   * 有意无样式者（逐个看过，不是图省事堆上来的）。
   * 每条都写清"它靠什么生效"，否则这张清单两轮之后就成了垃圾桶。
   */
  const ALLOWED_UNSTYLED = new Set([
    'diff-page', // 对比页 <article> 的页面标记类（宽度与排版由 .page 与子元素给，与 .detail-page 同路数）
    'notice-detail', // 详情页 <article> 的语义包装，视觉全部由里面的各区块承担
    'diff-version-old', // 对比页两版的 DOM 钩子（样式在 .diff-version 与 .diff-version-label 上）
    'diff-version-new',
    'diff-side-new', // 新文那侧走 .diff-side 基础规则；只有旧文那侧需要专门样式（.diff-side-old）
    'summary-quote-text', // 引用正文继承 .summary-quote 的排版（12px 灰），它自己只当锚点
    'summary-section', // 摘要各段的标记类：**可见边界由 `.content-block` 给**（2026-10-05 起），
    // 它自己只当"这是一段摘要区块"的锚点 —— 与 .summary-section-title / -text / -note 同族但不同层，
    // 那三个各自有规则。审计第一版把它误判成缺陷（因为对"前缀变体"放宽到了所有 token），
    // 收紧之后它是唯一被新规则捞出来的真实用例，逐个看过之后登记在这里。
  ]);

  /** 取 `className="…"` / `className={`…`}` / `className={'…'}` 里的字面类名。 */
  function classNameTokens(source) {
    /** token → 这个名字是否来自 **模板串插值**（`className={`audience-${x}`}`）。 */
    const tokens = new Map();
    const patterns = [
      [/className="([^"]*)"/g, false],
      [/className=\{`([^`]*)`\}/g, true],
      [/className=\{'([^']*)'\}/g, false],
    ];
    for (const [pattern, interpolated] of patterns) {
      for (const match of source.matchAll(pattern)) {
        const hadInterpolation = interpolated && /\$\{[^}]*\}/.test(match[1]);
        const cleaned = match[1].replace(/\$\{[^}]*\}/g, ' ');
        for (const raw of cleaned.split(/\s+/)) {
          const token = raw.replace(/^-+|-+$/g, '');
          if (!/^[a-z][a-z0-9-]*$/.test(token)) continue;
          tokens.set(token, (tokens.get(token) ?? false) || hadInterpolation);
        }
      }
    }
    return tokens;
  }

  const cssClasses = new Set([...cssRules.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));

  /**
   * 有规则就算数。**"以它开头的变体"只在两种情况下算数**：
   *
   * ① 这个 token 来自**模板串插值**（`className={`audience-${notice.audience}`}`）：源码里只
   *    留下 `audience-`，真正的类名是 `.audience-public` / `.audience-sector`。不这样认，
   *    审计会把三处正确的接线报成缺陷（第一次扫就是这么误报的）。
   * ② 源码里直接写全名的带后缀写法（如 `className="summary-basis summary-basis-attachment-points"`）
   *    本来就有自己的 token，用不着这条规则。
   *
   * **这条宽松必须按 token 逐个判**（2026-10-05 踩到）：一开始对所有 token 都放宽，结果
   * "把 `.impact-who {` 改名成 `.impact-who-legacy {`"这种撤法被当成了"仍有样式"，
   * 于是自证框架里那条 pin 报"撤掉实现后测试仍然通过" —— 一条**看起来在守、其实守不住**的断言。
   */
  function styled(token, interpolated) {
    if (cssClasses.has(token)) return true;
    if (!interpolated) return false;
    for (const candidate of cssClasses) {
      if (candidate.startsWith(`${token}-`)) return true;
    }
    return false;
  }

  function walkTsx(dir, out = []) {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walkTsx(full, out);
      else if (name.endsWith('.tsx')) out.push(full);
    }
    return out;
  }

  it('除了清单里那几个，其它类名都必须有规则（无规则 = 退回浏览器默认值）', () => {
    const offenders = [];
    for (const file of walkTsx(path.join(repoRoot, 'src/app'))) {
      for (const [token, interpolated] of classNameTokens(readFileSync(file, 'utf8'))) {
        if (styled(token, interpolated) || ALLOWED_UNSTYLED.has(token)) continue;
        offenders.push(`${path.relative(repoRoot, file).replace(/\\/g, '/')}: .${token}`);
      }
    }
    assert.deepEqual(
      [...new Set(offenders)].sort(),
      [],
      '这些类名在 .tsx 里写了、globals.css 里却没有规则 —— 视觉会落在浏览器默认值上（'
        + '.summary-section-note / .impact-kind 就是这么栽的：元信息比正文还大）。'
        + '要么补规则，要么把它登记进 ALLOWED_UNSTYLED 并写清靠什么生效。',
    );
  });
});
