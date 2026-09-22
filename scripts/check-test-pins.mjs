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
  url: 'src/lib/attachment-url.ts',
  extract: 'worker/jobs/extract-attachments.ts',
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
    // 2026-09-22 线上核对：samr 征集食品补充检验方法时随文只有空白申报书，两条各抽到
    // 587 / 624 个汉字的表头，还把真正的通知挤在名额之外。撤掉这两个词，那条断言要红。
    label: '申报书 / 报名表不再判为填报类（空白模板重占名额）',
    file: 'select',
    from: " '申报书', '报名表',",
    to: ' ',
    pattern: '空白申报书与报名表排不进名额',
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
    // 生产影子轮的真实失效：一份 mee 的 PDF 抽出 8 个 U+0000，PostgreSQL 的 text 不收 NUL，
    // 那条 UPDATE 抛错、整轮中断。撤掉出口处的清洗，接在出口上的那条断言要变红。
    label: '解析出口不再清洗控制字符（NUL 写库失败）',
    file: 'parse',
    from: '  const clean = sanitizeExtractedText(text);',
    to: '  const clean = text;',
    pattern: '不含 NUL 与其它控制符',
    test: 'tests/unit/attachment-parse.test.mjs',
  },
  {
    // 一行 `new Uint8Array(body)` 同时兜住两件事（pdfjs 移交缓冲、以及它拒绝 Buffer），
    // 两条断言都撤同一行 —— 撤掉任何一边都会红，这正是想要的冗余。
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
    // 生产影子轮实测：按「包开头有没有 [Content_Types].xml」分 docx / xlsx 会把住建部
    // 20 个真 docx 全部拒掉。撤掉判型（zip 一律当 docx 候选），两条断言都要红。
    label: 'zip 判型退回「看条目名猜 docx」',
    file: 'magic',
    from: "  if (startsWith(head, ZIP_SIGNATURE) || startsWith(head, ZIP_EMPTY_SIGNATURE)) return 'docx';",
    to: "  if (startsWith(head, ZIP_SIGNATURE) || startsWith(head, ZIP_EMPTY_SIGNATURE)) return 'other';",
    pattern: 'docx 候选',
    test: 'tests/unit/file-magic.test.mjs',
  },
  {
    // 同一类缺陷的第二发：OLE2 的流名在目录项里（扇区位置由 FAT 决定），头部找不到
    // WordDocument 就把真 .doc / .wps 判成 other —— 影子轮因此白丢 9 个附件。
    label: 'OLE2 退回「按头部流名猜 doc」',
    file: 'magic',
    from: '  if (startsWith(head, OLE2_SIGNATURE)) return \'doc\';',
    to: '  if (startsWith(head, OLE2_SIGNATURE)) return \'other\';',
    pattern: '当 doc 候选',
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
  {
    // 影子轮结论：miit 16 条带附件的公示 ok=0，全是 jyhwzhq 子域整台主机 403。
    // 撤掉换域这一手，那 14 份草案就又读不到了。
    label: '被拒后不换到详情页 origin（直连一拒就落 blocked）',
    file: 'extract',
    from: '      refusal = `HTTP ${response.status}（${host}）`;\n      continue;',
    to: '      return {\n        probed: false,\n        outcome: { status: \'blocked\', bytes: 0, error: `HTTP ${response.status}`, fetchedAt: new Date() },\n      };',
    pattern: '换到详情页 origin',
    test: 'tests/e2e/attachment-extract-job.test.mjs',
  },
  {
    label: '换域取回不留出处痕（事后看不出文本来自哪台主机）',
    file: 'extract',
    from: '    : `直连 ${hostOf(attachment.url)} 未取到，改由 ${host} 取回同一路径`;',
    to: '    : null;',
    pattern: '换到详情页 origin',
    test: 'tests/e2e/attachment-extract-job.test.mjs',
  },
  {
    label: '沿用旧文本的判据不看本轮结论（成功的一轮被写成刷新失败）',
    file: 'extract',
    from: "    if (outcome.status === 'ok') return outcome;",
    to: '    // 撤掉这一行',
    pattern: '不算「未能刷新」',
    test: 'tests/e2e/attachment-extract-job.test.mjs',
  },
  {
    label: '同 origin 也补第二条候选（正常源站白多一个请求）',
    file: 'url',
    from: '  if (file.origin === page.origin) return [attachmentUrl];',
    to: '  if (false) return [attachmentUrl];',
    pattern: '也算同一处',
    test: 'tests/unit/attachment-url.test.mjs',
  },
  {
    label: '同站判据放宽到两段后缀（公共后缀下把不相干的站判成同站）',
    file: 'url',
    from: '  if (commonSuffixLabels(file.hostname, page.hostname) < 3) return [attachmentUrl];',
    to: '  if (false) return [attachmentUrl];',
    pattern: '只共享两段后缀不算同站',
    test: 'tests/unit/attachment-url.test.mjs',
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
