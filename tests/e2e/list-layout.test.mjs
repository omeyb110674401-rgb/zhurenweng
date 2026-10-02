import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * 列表页 / 首页宽屏两栏（2026-10-02 用户拍板）：**没有浏览器时的守卫**。
 *
 * 为什么是源码文本断言：e2e 跑的是 `.next` 构建产物（ADR-0001，本仓库不引浏览器依赖），
 * 所以"栅格排成几列、筛选条落在第几列、容器宽度怎么写"这些**渲染后才有答案**的事，
 * 在门里只能用源码文本钉住 —— 与 `detail-layout.test.mjs` 第二节同一个手法。
 *
 * 这一批断言里最要紧的是第 4 条：**宽屏的列位必须写死**。
 * 第一版靠栅格自动放置，注释里还写着"筛选条（第一个子项）自然落到第一列"—— 那是反的：
 * `minmax(0,1fr) 320px` 的第一列是主栏，而 DOM 里筛选条排在结果区**之前**（顺序不能动，
 * 否则窄屏下筛选会跑到列表下面），于是筛选条占掉主栏、**列表被塞进 320px 的右栏**。
 * 这正是详情页那一刀的同族缺陷（结构看着对、渲染出来是错的），而 e2e 没有浏览器
 * 照样看不出来 —— 只有把页面真的渲染出来才看得见。所以这里必须有一条会红的断言。
 *
 * 这些断言读的是 `src/app/globals.css` 这个**文件**，所以撤掉源码里的实现能让它们变红 ——
 * 自证脚本（`scripts/check-test-pins.mjs`）给它们配了钉子。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

/** 取某条 CSS 规则声明的属性文本（`{` 起、第一个 `}` 止）。取的是**第一次**出现的那条。 */
function ruleBody(css, selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `globals.css 应存在规则 ${selector}`);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  assert.ok(open > 0 && close > open, `${selector} 的规则块不完整`);
  return css.slice(open + 1, close);
}

/**
 * 取**含某个标记**的那个 `@media (min-width: 1000px)` 整块。
 *
 * 为什么不能像 `detail-layout.test.mjs` 那样直接取第一个：本文件现在有**两个**同断点的
 * 媒体查询（详情页一个、列表页一个，刻意分开 —— 改一个不会顺手碰另一个）。
 * 按标记挑，将来再加第三个也不会选错。
 */
function wideBlockContaining(css, marker) {
  const needle = '@media (min-width: 1000px)';
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    assert.ok(at >= 0, `globals.css 应有一个含 ${marker} 的 ${needle} 块`);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const block = css.slice(at, i + 1);
          if (block.includes(marker)) return block;
          from = i + 1;
          break;
        }
      }
    }
  }
}

describe('列表页两栏：断点、栅格与列位（源码文本，没有浏览器时的唯一办法）', () => {
  const css = readSource('src/app/globals.css');

  it('容器宽度是连续式（含百分比、禁 100vw）：断点处不许再跳一次', () => {
    const widened = ruleBody(css, '.page:has(.list-page) {');
    assert.match(widened, /max-width:\s*min\(\s*1120px/, '上限放到 1120px');
    assert.match(widened, /100vw/, '必须是连续式（视口单位）—— 写死 px 会在断点处跳一次');
    assert.doesNotMatch(
      widened,
      /100%/,
      '不许用 100%：嵌套的 .page 上会把内边距算两遍（详情页那边渲染出来才发现，主栏缩了 48px）',
    );
  });

  it('两栏切换与加宽绑在同一个 :has(.list-page) 上（降级必须安全）', () => {
    const wide = wideBlockContaining(css, '.list-layout');
    assert.match(
      wide,
      /\.page:has\(\.list-page\)\s+\.list-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 320px/,
      '两栏要挂在同一个 :has(.list-page) 上 —— 不支持 :has() 时两条都不生效，页面与改动前逐字一致',
    );
    assert.doesNotMatch(
      wide,
      /(^|\n)\s*\.list-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 320px/,
      '两栏不许写成不依赖 :has() 的独立规则（那会退化成 760 容器里硬塞两列）',
    );
  });

  it('基础规则是单列：窄屏落回改动前的样子', () => {
    const base = ruleBody(css, '.list-layout {');
    assert.match(base, /display:\s*grid/, '栅格写在基础规则里（宽屏只是换列数，不是从无到有）');
    assert.match(base, /grid-template-columns:\s*minmax\(0, 1fr\);/, '基础（窄屏）应是单列');
    assert.doesNotMatch(
      base,
      /(^|\n)\s*grid-column\s*:/,
      '窄屏不写列位：写了就会把筛选条塞进一个不存在的第二列',
    );
  });

  it('**宽屏的列位写死了**：列表在第 1 列、筛选条在第 2 列（不许靠自动放置）', () => {
    const wide = wideBlockContaining(css, '.list-layout');
    assert.match(
      wide,
      /\.page:has\(\.list-page\)\s+\.list-main\s*\{\s*grid-column:\s*1;/,
      '列表必须显式落在第 1 列（主栏）',
    );
    assert.match(
      wide,
      /\.page:has\(\.list-page\)\s+\.list-layout\s*>\s*\.filter-bar\s*\{\s*grid-column:\s*2;/,
      '筛选条必须显式落在第 2 列（右栏）—— 靠自动放置会把它放进主栏、把列表挤进 320px',
    );
  });

  it('不用 order 摆位：视觉顺序与焦点顺序不许分家', () => {
    const wide = wideBlockContaining(css, '.list-layout');
    assert.doesNotMatch(wide, /(^|\n)\s*order:/, 'order 会让键盘 Tab 的到达顺序与眼睛看到的相反');
  });
});
