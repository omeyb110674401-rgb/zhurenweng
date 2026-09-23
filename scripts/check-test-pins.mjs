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
 *
 * 选测试的两条硬规则：
 * 1. 被撤的实现必须**从源码被执行**。e2e 里 `startAppServer` 跑的是 `.next` 构建产物，
 *    改 `src/app/**` 与 SSR 侧 lib 对它无效（撤了也不红 = 假绿）。因此页面/组件的判据
 *    一律配单测（`node --test` 直读 .ts），只有 worker 侧与仓储侧的改动才走 e2e ——
 *    worker 子进程是 `node worker/index.ts`，跑的就是源码。
 * 2. 名字模式**不能只选中多轮状态型套件里的一个 it**。`--test-name-pattern` 会跳过
 *    前面的用例，而那些用例正是「造成被断言的那个状态」的轮次（实测踩过：撤掉
 *    「成功清错误列」，只跑第 3 轮的断言照样绿 —— 因为第 1、2 轮没跑，那列本来就是空的）。
 *    这种套件要按 **describe 名**匹配，让整组按顺序跑完。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TARGETS = {
  select: 'src/lib/attachment-select.ts',
  parse: 'src/lib/attachments/parse.ts',
  magic: 'src/lib/file-magic.ts',
  url: 'src/lib/attachment-url.ts',
  extract: 'worker/jobs/extract-attachments.ts',
  crawl: 'worker/jobs/crawl-notices.ts',
  sourcesRepo: 'src/db/repo/sources.ts',
  sourceHealth: 'src/lib/source-health.ts',
  summaryDisplay: 'src/lib/summary-display.ts',
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
  // ── issue #58 ───────────────────────────────────────────────
  // 超时这件事有三处可撤：挂 signal、按源解析预算、把预算写进错误消息。各自单钉一条，
  // 因为失效方式不同 —— 少 signal 是「整轮卡住」，少档位是「慢源照样只有全局值」，
  // 少消息是「知道超时却不知道是谁、按多少预算超的」。
  {
    label: '请求不挂超时 signal（停滞的响应体永远等下去）',
    file: 'crawl',
    from: "  return fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });",
    to: "  return fetch(url, { headers, redirect: 'manual' });",
    pattern: 'CRAWL_TIMEOUT_MS 掐断',
    test: 'tests/e2e/crawl-timeout-guard.test.mjs',
  },
  {
    label: '适配器声明的预算被忽略（慢源只能靠抬全局值）',
    file: 'crawl',
    from: '  return request.timeoutMs ?? request.fetchOptions?.timeoutMs ?? DEFAULT_CRAWL_TIMEOUT_MS;',
    to: '  return request.timeoutMs ?? DEFAULT_CRAWL_TIMEOUT_MS;',
    pattern: '适配器档',
    test: 'tests/e2e/crawl-timeout-guard.test.mjs',
  },
  {
    label: '超时不再归因（消息里没有预算与 URL）',
    file: 'crawl',
    from: '    if (error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name)) {',
    to: '    if (false) {',
    pattern: 'CRAWL_TIMEOUT_MS 掐断',
    test: 'tests/e2e/crawl-timeout-guard.test.mjs',
  },
  {
    // #51 的成果：降级当场判红。#58 引入「满 2 轮才判红」之后少了这个钳制，
    // 「一轮内过半条目失败」就会被当成第一轮抖动而静默为健康 —— 两条判据必须正交地都生效。
    label: '数据质量降级不再当场判红（被跨轮门槛吞掉）',
    file: 'crawl',
    from: '            immediateUnhealthy: true,',
    to: '            // 撤掉：不钳到门槛',
    pattern: '判降级 —— 日志写明',
    test: 'tests/e2e/crawl-source-degraded.test.mjs',
  },
  {
    label: '首轮失败也发信（间歇性慢源每天一封，噪声日常化）',
    file: 'crawl',
    from: '        if (shouldAlertForSourceFailure(consecutive)) {',
    to: '        if (true) {',
    pattern: '管理后台与健康告警',
    test: 'tests/e2e/admin.test.mjs',
  },
  {
    label: '满门槛也不发信（真断流没人知道）',
    file: 'crawl',
    from: '        if (shouldAlertForSourceFailure(consecutive)) {',
    to: '        if (false) {',
    pattern: '满两轮每源恰好一封',
    test: 'tests/e2e/admin.test.mjs',
  },
  {
    // 这两条是同一处改动的两半：错误两列现在只描述**当前**故障态。少任何一半，看板都会
    // 退回「一个早已恢复的源永远像正在出事」。
    label: '成功后不清当前故障态的错误信息',
    file: 'sourcesRepo',
    from: '    lastErrorMessage: null,',
    to: '    // 撤掉：留着上一次错误',
    pattern: '不再每天红、每天发信',
    test: 'tests/e2e/crawl-flaky-source.test.mjs',
  },
  {
    label: '成功后计数不归零（恢复后再抖一次仍背着旧账）',
    file: 'sourcesRepo',
    from: '    consecutiveFailures: 0,',
    to: '    // 撤掉：计数不清零',
    pattern: '不再每天红、每天发信',
    test: 'tests/e2e/crawl-flaky-source.test.mjs',
  },
  {
    label: '门槛判据形同虚设（失败一次即判红）',
    file: 'sourceHealth',
    from: '  return consecutiveFailures >= SOURCE_UNHEALTHY_AFTER_CONSECUTIVE_FAILURES;',
    to: '  return true;',
    pattern: '连续失败满 2 轮才判红',
    test: 'tests/unit/config-guards.test.mjs',
  },
  {
    label: '持续故障每轮都重发（红着的源每天一封）',
    file: 'sourceHealth',
    from: '  return since % ALERT_REPEAT_EVERY_ROUNDS === 0;',
    to: '  return true;',
    pattern: '每 7 轮封顶重发',
    test: 'tests/unit/config-guards.test.mjs',
  },
  {
    label: '已有摘要不再第一优先（已截止条目的摘要被界面藏起来）',
    file: 'summaryDisplay',
    from: "  if (input.hasSummary) return 'view';",
    to: "  if (false) return 'view';",
    pattern: '哪怕条目已截止',
    test: 'tests/unit/summary-display.test.mjs',
  },
  {
    label: '截止判据失效（已截止条目重新被承诺「生成中」）',
    file: 'summaryDisplay',
    from: "  if (input.summaryStatus === 'pending' && input.noticeStatus === SUMMARY_NOT_SUMMARIZED_STATUS) {",
    to: "  if (input.summaryStatus === 'pending' && false) {",
    pattern: '已截止且 pending',
    test: 'tests/unit/summary-display.test.mjs',
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
