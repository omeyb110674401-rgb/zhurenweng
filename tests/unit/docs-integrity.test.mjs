import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * 单元：仓库里 Markdown 的结构完整性。
 *
 * 为什么值得一条门：**在 GitHub 账号停用期间，`docs/pending-issues/` 就是本项目的事实
 * tracker**（README 与 FOLLOWUPS 都靠它），文档坏了没有第二条路能替代。而这一类坏法
 * 全都**悄无声息**：一张表被空行拦腰截断，渲染出来是「后半张变成普通段落」；
 * 单元格里混进一个没转义的竖线，那一行就多出一列、整行错位；编码手滑留下的
 * U+3401 谁也不会主动去找。
 *
 * 2026-09-25 盘点时实测：`FOLLOWUPS.md` 5 处空行截断 + 1 处多余竖线 + 4 个 U+3401；
 * `README.md` 的「接入的源」表被空行切成两张；`docs/pending-issues/README.md` 的
 * `67-*` 那一行被拆成 5 行（中间三行不以 `|` 开头，表格到这里就断了）。
 * 而我**自己修文档时又在表格单元格里复现了同一个错**（把 `㐁` 与裸 `|` 当例子写进去）
 * —— 所以这条门不是假想出来的。
 *
 * 判据刻意保守，只收"任何情况下都是错"的四种：
 * ① U+3401 / U+FFFD（乱码与替换字符，没有正当用途）；
 * ② 前后两行都是表格行、中间夹一个空行（一定断表）；
 * ③ 同一张表内列数不一致 —— `\|` 是转义，不计入列分隔；
 * ④ 表头与分隔行（`| --- |`）不匹配。
 * 围栏代码块（``` 之内）整块跳过：那里画表格是合法的，列数不必自洽。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'out']);

function markdownFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') {
      if (entry.isDirectory()) continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      markdownFiles(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** 只看真正起分隔作用的 `|`：`\|` 是转义，不算列分隔。 */
function cellCount(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/).length;
}

const isRow = (line) => line.trim().startsWith('|');
const isDelimiter = (line) => isRow(line) && /^\|[\s|:-]+\|$/.test(line.trim());

/**
 * 分析一个文件的 Markdown 结构，返回问题列表（空数组 = 干净）。
 * 纯函数、不碰文件系统，好读也好测。
 */
export function findMarkdownProblems(text) {
  const problems = [];
  const lines = text.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const [label, code] of [['U+3401', 0x3401], ['U+FFFD', 0xfffd]]) {
      if ([...line].some((c) => c.codePointAt(0) === code)) {
        problems.push(`${index + 1} 行含 ${label} 乱码：${line.trim().slice(0, 60)}`);
      }
    }
  }

  // 围栏代码块内的行不参与表格判定（那里画表格合法，列数不必自洽）
  const inFence = new Array(lines.length).fill(false);
  let fence = false;
  for (const [index, line] of lines.entries()) {
    if (/^\s*```/.test(line)) {
      inFence[index] = true;
      fence = !fence;
      continue;
    }
    inFence[index] = fence;
  }

  const usable = (i) => !inFence[i];
  let breakAt = 0;
  for (let i = 1; i < lines.length - 1; i += 1) {
    if (
      usable(i) &&
      lines[i].trim() === '' &&
      usable(i - 1) &&
      usable(i + 1) &&
      isRow(lines[i - 1]) &&
      isRow(lines[i + 1])
    ) {
      problems.push(`${i + 1} 行：空行夹在两张表格行之间，会把表拦腰截断`);
      breakAt += 1;
    }
  }

  let i = 0;
  while (i < lines.length) {
    if (!usable(i) || !isRow(lines[i])) {
      i += 1;
      continue;
    }
    const start = i;
    const cols = [];
    while (i < lines.length && usable(i) && isRow(lines[i])) {
      cols.push(cellCount(lines[i]));
      i += 1;
    }
    const unique = [...new Set(cols)];
    if (unique.length > 1) {
      problems.push(
        `${start + 1}-${i} 行：同一张表内列数不一致（${unique.join(' / ')}）` +
          '——单元格里多半混进了没转义的 `|`（要写成 `\\|`）',
      );
    }
    // 分隔行必须在第 2 行，且列数与表头一致（GFM 要求在表头之后）
    if (cols.length >= 2 && !isDelimiter(lines[start + 1])) {
      problems.push(`${start + 2} 行：表头后面不是分隔行（|---|），这张表不会被渲染成表`);
    }
  }

  return { problems, breakAt };
}

describe('Markdown 结构完整性（文档坏了没有第二条路能替代）', () => {
  const files = markdownFiles(repoRoot);

  it('扫到的 md 文件数是合理的（防止遍历写错、扫了个空目录就"全绿"）', () => {
    assert.ok(
      files.length >= 20,
      `只扫到 ${files.length} 个 md，太少了 —— 遍历逻辑多半坏了，这条门会假绿`,
    );
  });

  it('每个 md 都没有断表 / 列数错位 / 乱码', () => {
    const failures = [];
    for (const file of files) {
      const { problems } = findMarkdownProblems(fs.readFileSync(file, 'utf8'));
      for (const problem of problems) {
        failures.push(`${path.relative(repoRoot, file).replace(/\\/g, '/')} ${problem}`);
      }
    }
    assert.deepEqual(
      failures,
      [],
      `文档结构有问题（表格断了、列数错位或混进乱码）：\n  ${failures.join('\n  ')}`,
    );
  });
});

describe('Markdown 结构判据本身（不能靠"没扫到"来绿）', () => {
  it('空行夹在两张表之间 ⇒ 报出来', () => {
    const { problems } = findMarkdownProblems('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| 3 | 4 |\n');
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /拦腰截断/);
  });

  it('单元格里没转义的竖线 ⇒ 列数不一致被报出来', () => {
    const { problems } = findMarkdownProblems('| a | b |\n| --- | --- |\n| 1 | x | y |\n');
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /列数不一致/);
    assert.match(problems[0], /\\\|/, '要告诉人怎么改：反斜杠 + 竖线');
  });

  it('转义过的竖线（`\\|`）不算列分隔 —— 否则会误报', () => {
    const { problems } = findMarkdownProblems('| a | b |\n| --- | --- |\n| 1 | `x \\| y` |\n');
    assert.deepEqual(problems, [], '这是合法的 GFM 写法，不该报');
  });

  it('围栏代码块里画表格 ⇒ 跳过，不按列数判', () => {
    const text = '说明：\n\n```\n| 随便 | 画 |\n| 不等 | 列 | 数 |\n```\n\n结束\n';
    assert.deepEqual(findMarkdownProblems(text).problems, []);
  });

  it('表头后面缺分隔行 ⇒ 报出来（这张表根本不会被渲染成表）', () => {
    const { problems } = findMarkdownProblems('| a | b |\n| 1 | 2 |\n');
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], /分隔行/);
  });

  it('U+3401 与 U+FFFD 都报出来', () => {
    assert.match(findMarkdownProblems(`x ${String.fromCodePoint(0x3401)} y`).problems[0], /U\+3401/);
    assert.match(findMarkdownProblems(`x ${String.fromCodePoint(0xfffd)} y`).problems[0], /U\+FFFD/);
  });
});
