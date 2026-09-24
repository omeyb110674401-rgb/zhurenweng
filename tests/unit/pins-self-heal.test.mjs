import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * 单元（issue #67）：`check-test-pins.mjs` 被强杀之后的自愈。
 *
 * 为什么要给"检查测试的脚本"本身写测试：它会**改写工作区里的源码**，而 Windows 上终止
 * 进程不跑 `process.on('exit')` 钩子 —— 2026-09-24 实测踩过：脚本被中途终止，工作区留下
 * `registered: true` 的假实现，同一时刻 `npm run build` 正在读源码，于是假代码被编进
 * `.next`，e2e 报了一条与当次改动毫无关系的红。撤掉自愈的那次调用，这个状态就重新变成
 * "要靠人记得去 git diff" —— 而当时我显然没记得。
 *
 * 另一半要点在被改过的文件上：自愈**不许**把过期原文写回去。留痕之后文件若又被人工改过，
 * 自动还原会连带抹掉那次改动，那比留一处假代码严重。
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/check-test-pins.mjs',
);
const MARKER = '.pins-inflight.json';
const ORIGINAL = 'export const flag = true;\n';
const MUTATED = 'export const flag = false;\n';

/** 造一个"上次跑到一半被强杀"的工作区：目标文件 + 留痕（marker 为 null 表示没有留痕）。 */
function makeWorkspace(fileContent, withMarker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zw-pins-heal-'));
  fs.writeFileSync(path.join(dir, 'widget.ts'), fileContent);
  if (withMarker) {
    fs.writeFileSync(
      path.join(dir, MARKER),
      JSON.stringify({ label: '测试用的撤除', file: 'widget.ts', original: ORIGINAL, mutated: MUTATED }),
    );
  }
  return dir;
}

function recover(dir) {
  const run = spawnSync(process.execPath, [SCRIPT, '--recover-only'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: run.status, out: `${run.stdout}\n${run.stderr}`, dir };
}

function read(dir) {
  return fs.readFileSync(path.join(dir, 'widget.ts'), 'utf8');
}

describe('issue #67：撤实现脚本的崩溃自愈', () => {
  it('留痕在、文件仍是假代码 ⇒ 还原原样并删掉留痕', () => {
    const { code, out, dir } = recover(makeWorkspace(MUTATED, true));
    assert.equal(code, 0, `应正常退出，输出：${out}`);
    assert.equal(read(dir), ORIGINAL, '假代码要被换回原样');
    assert.equal(fs.existsSync(path.join(dir, MARKER)), false, '留痕处理完就要消失，否则下次还报');
    assert.match(out, /已还原/, '还原必须说出来：静默改工作区里的文件是另一类坑');
  });

  it('留痕在、文件之后又被改过 ⇒ 不动文件、非零退出并交给人核对', () => {
    const edited = 'export const flag = false; // 人工改过\n';
    const { code, out, dir } = recover(makeWorkspace(edited, true));
    assert.notEqual(code, 0, '这种情况不能装作没事');
    assert.equal(read(dir), edited, '把过期原文写回去会连带抹掉人工改动');
    assert.match(out, /git diff/, '要给出可执行的下一步');
    assert.equal(fs.existsSync(path.join(dir, MARKER)), false, '报过之后别每次都来烦人');
  });

  it('没有留痕 ⇒ 一个字都不改（正常路径不能被自愈逻辑当成事故现场）', () => {
    const { code, out, dir } = recover(makeWorkspace(ORIGINAL, false));
    assert.equal(code, 0, `应正常退出，输出：${out}`);
    assert.equal(read(dir), ORIGINAL);
    assert.ok(!out.includes('还原'), `不该凭空报还原：${out}`);
  });
});
