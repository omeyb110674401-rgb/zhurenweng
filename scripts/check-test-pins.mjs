#!/usr/bin/env node
/**
 * 回归自证：逐条**撤掉实现**，确认对应断言当场变红（issue #57 起新增）。
 *
 * 为什么要有这个脚本：本仓库的口径是「测试要在撤掉修复后变红才算数」。人肉做这件事
 * 会偷懒（只做显眼的那几条），而且做过的痕迹不留下来 —— 下一轮改动就没人知道哪些
 * 断言其实从没被验证过。这里把「撤哪一行、跑哪个测试」和测试本身放在一起，
 * 于是它同时是一张可执行的清单。
 *
 * 用法：node scripts/check-test-pins.mjs
 * 退出码非 0 的情况：某条断言撤掉实现后仍然为绿（说明它没钉住任何东西），
 * 或者某个 `from` 片段在源码里找不到（说明代码改过、这条用例已经过期）。
 *
 * 注意：每次都会把源码原样写回，所以只读不脏工作区；但**别在它跑的时候改同一批文件**。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TARGETS = {
  select: 'src/lib/attachment-select.ts',
  parse: 'src/lib/attachments/parse.ts',
  magic: 'src/lib/file-magic.ts',
};

const CASES = [
  {
    label: '截取退化成「取前 N 字」（红线）',
    file: 'select',
    from: '  const anchors = findAnchorSpans(text);',
    to: '  return text.slice(0, maxChars);\n  const anchors = findAnchorSpans(text);',
    pattern: '红线',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '锚点窗口不合并（重复条文）',
    file: 'select',
    from: '    if (last !== undefined && span.start <= last.end) {',
    to: '    if (false) {',
    pattern: '同一句条文不能出现两遍',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '不拿锚点之外的文字补满预算',
    file: 'select',
    from: '  for (const gap of subtractSpans({ start: 0, end: text.length }, anchors)) {',
    to: '  for (const gap of []) {',
    pattern: '完全没有锚点词的长文',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '不补章节骨架',
    file: 'select',
    from: "  const outlineBudget = outline === '' ? 0 : Math.min(",
    to: '  const outlineBudget = 0 && Math.min(',
    pattern: '远处的章节标题',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '不按扩展名丢压缩包',
    file: 'select',
    from: '  return SKIP_EXTENSIONS.includes(extensionOf(name));',
    to: '  return false;',
    pattern: '根本不下载',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '空白表阈值形同虚设',
    file: 'select',
    from: '  return countCjk(text) >= MIN_DRAFT_CJK_CHARS;',
    to: '  return countCjk(text) >= 1;',
    pattern: '空白意见表判为没有正文',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '汉字数改成一律数长度',
    file: 'select',
    from: '  let count = 0;',
    to: '  return text.length;\n  let count = 0;',
    pattern: 'countCjk 只数汉字',
    test: 'tests/unit/attachment-select.test.mjs',
  },
  {
    label: '扫描件判据去掉（0 字也报 ok）',
    file: 'parse',
    from: "    if (pages >= SCANNED_MIN_PAGES && chars / pages < SCANNED_MAX_CHARS_PER_PAGE) {",
    to: '    if (false) {',
    pattern: '扫描型 PDF',
    test: 'tests/unit/attachment-parse.test.mjs',
  },
  {
    // 一行 `new Uint8Array(body)` 同时兜住两件事（pdfjs 的移交、以及它拒绝 Buffer），
    // 所以两条断言都撤同一行 —— 撤掉任何一边都会红，这正是想要的冗余。
    label: 'pdfjs 的 Buffer / 移交限制（撤掉那次复制）',
    file: 'parse',
    from: '    data: new Uint8Array(body),',
    to: '    data: body,',
    pattern: '接受下载侧那种字节',
    test: 'tests/unit/attachment-parse.test.mjs',
  },
  {
    label: 'docx 正文不按段落换行',
    file: 'parse',
    from: "    .replace(/<\\/w:p>/g, '\\n');",
    to: "    .replace(/<w:p[\\\\s\\\\S]*?<\\/w:p>/g, '');",
    pattern: '段落分开',
    test: 'tests/unit/attachment-parse.test.mjs',
  },
  {
    label: 'zip 判型不再要求 OOXML 标记',
    file: 'magic',
    from: "    return findAscii(head, OOXML_MARKER, 1024) ? 'docx' : 'other';",
    to: "    return 'docx';",
    pattern: 'OOXML 标记',
    test: 'tests/unit/file-magic.test.mjs',
  },
  {
    label: 'HTML 判定不再锚定开头',
    file: 'magic',
    from: "    text.startsWith('<!doctype html') ||",
    to: "    text.includes('<!doctype html') || text.includes('<body') ||",
    pattern: '恰好出现 <body>',
    test: 'tests/unit/file-magic.test.mjs',
  },
];

let red = 0;
const problems = [];
for (const testCase of CASES) {
  const file = TARGETS[testCase.file];
  const original = readFileSync(file, 'utf8');
  if (!original.includes(testCase.from)) {
    problems.push(`${testCase.label} —— 源码里找不到要撤的那段，用例已过期（改了实现要同步改这里）`);
    console.log(`?? ${problems[problems.length - 1]}`);
    continue;
  }
  writeFileSync(file, original.replace(testCase.from, testCase.to));
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-name-pattern', testCase.pattern, testCase.test],
    { encoding: 'utf8', timeout: 300_000 },
  );
  writeFileSync(file, original);

  const out = `${run.stdout}\n${run.stderr}`;
  if (!/\nℹ tests ([1-9]\d*)/.test(out)) {
    problems.push(`${testCase.label} —— 名字模式没匹配到任何测试，这条用例本身是空的`);
  } else if (/\nℹ fail ([1-9]\d*)/.test(out)) {
    red += 1;
    console.log(`红 ✓ ${testCase.label}`);
  } else {
    problems.push(`${testCase.label} —— 撤掉实现后测试仍然通过，这条断言没钉住任何东西`);
  }
  if (original !== readFileSync(file, 'utf8')) problems.push(`${testCase.label} —— 源码没被还原！`);
}

console.log(`\n撤掉实现后变红 ${red}/${CASES.length}`);
if (problems.length > 0) {
  console.log(`有问题 ${problems.length} 条：`);
  for (const problem of problems) console.log(`  · ${problem}`);
  process.exitCode = 1;
}
