import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * 单元：门入口的「上一次撤实现脚本被强杀了吗」守卫（`scripts/check-pins-clean.mjs`）。
 *
 * 为什么需要它：`check-test-pins.mjs` 运行期间工作区里**真的躺着假代码**，被强杀时
 * 只留下 `.pins-inflight.json` 留痕，而自愈要等它**自己下一次启动**。在那之前跑测试，
 * 得到的是一批与被测改动毫无关系的红 —— 2026-09-25 实测踩到（5 条 crawl-timeout-guard
 * 失败，看着像抓取层回归），定位它比修它花的时间长。
 *
 * 这个守卫的三条契约：拦得住、说得出是哪一条、以及**拦的依据是"留痕还在"而不是
 * "留痕可读"**（文件坏了照样拦，否则最该拦的那次反而放行）。
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-pins-clean.mjs',
);
const MARKER = '.pins-inflight.json';

/** 在一个临时目录里跑守卫（留痕按 cwd 找，所以每个用例各造一个干净现场）。 */
function runGuard(markerContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-pins-clean-'));
  if (markerContent !== null) fs.writeFileSync(path.join(dir, MARKER), markerContent);
  const run = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}`, dir };
}

describe('门的入口守卫：撤实现脚本被强杀不许当成正常状态', () => {
  it('没有留痕 ⇒ 静默放行（正常路径不该被守卫打扰）', () => {
    const { code, out } = runGuard(null);
    assert.equal(code, 0, `应放行，输出：${out}`);
    assert.equal(out.trim(), '', '正常路径一个字都不该说');
  });

  it('留痕在 ⇒ 拦下来，并说出当时撤的是哪一条', () => {
    const { code, out } = runGuard(
      JSON.stringify({ label: '演示：撤掉 timeout signal', file: 'x.ts', original: 'a', mutated: 'b' }),
    );
    assert.equal(code, 1, '这个状态必须挡住门');
    assert.match(out, /被强杀/, '要说清发生了什么，而不是只说"出错了"');
    assert.match(out, /演示：撤掉 timeout signal/, '要报出留痕里的 label，人才知道去哪看');
    assert.match(out, /--recover-only/, '要给出唯一正确的下一步命令');
    assert.match(out, /git status/, '要说清跑完之后怎么确认真的干净了');
  });

  it('留痕是坏的（非法 JSON）⇒ 照样拦 —— 拦的依据是它还在，不是它可读', () => {
    const { code, out } = runGuard('{ 这不是 JSON');
    assert.equal(code, 1, '读不出内容不等于可以放行；最该拦的正是这种半坏状态');
    assert.match(out, /被强杀/);
  });

  it('留痕带 BOM 也能读出 label（人可能手改过这个文件）', () => {
    const { code, out } = runGuard(
      `\uFEFF${JSON.stringify({ label: '带 BOM 的那一条', file: 'x.ts', original: 'a', mutated: 'b' })}`,
    );
    assert.equal(code, 1);
    assert.match(out, /带 BOM 的那一条/, 'BOM 不该让这条报告退化成"读不出来"');
  });
});
