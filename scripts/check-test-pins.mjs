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
 * **它现在是门的一部分**（issue #83，2026-09-26）：挂在 `pretest` 上，所以 `npm test`
 * 会先跑一遍它。此前它是 1,181 行、113 条用例、**0 个调用者** —— 只有"记得手动跑"时才跑，
 * 而人一定会忘（发行记录见 issue #80："验证是手艺而不是门"）。按需单跑仍然可以，
 * 快速循环用 `npm run test:unit`（它只跑 check-pins-clean 那道崩溃守卫，不跑本脚本）。
 * 退出码非 0 的情况：某条断言撤掉实现后仍然为绿（说明它没钉住任何东西），
 * 或者某个 `from` 片段在源码里找不到（说明代码改过、这条用例已经过期）。
 *
 * 本脚本会**改写工作区里的源码**，所以跑它的时候不要同时跑别的读源码的东西
 * （`npm run build` / `npm run e2e` / 编辑器保存）。为什么单独强调：2026-09-24 把它
 * 扔在后台和 build 并行跑，撤掉一半的假代码被编进 `.next`，e2e 当场报了一条与本次
 * 改动毫无关系的红，看着像 #67 引入了回归。被强杀留下的假代码尚能自愈（见
 * `recoverInflight`），但「并行读源码」这件事没有补救办法 —— 只能不并行。
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
 * 3. `from` 片段**写成一行**。工作区里部分 .ts 是 CRLF（`core.autocrlf=true`，提交时才归一成
 *    LF），多行片段里的 `\n` 在那些文件里匹配不上，脚本会把这条报成"用例已过期"。
 *    2026-09-24 实测踩过一次（issue #62 的 `openOnly` 日期条件）。
 * 4. `from` 那串在目标文件里**第一次出现的地方必须就是要撤的那一处**：`String#replace` 只换
 *    第一个匹配。这条在把脚本自己也当靶子时特别容易破 —— 用例里写着要撤的那行代码，于是
 *    第一次命中的是 CASES 里那行"引用"，撤完什么也没变、用例永远为绿。同一天的第二发
 *    （issue #67 的自愈用例），靠"撤掉修复必须当场真会红"这条自查出来。
 * 5. **`pattern` 是正则，不是字面串**（issue #86 第 0 刀实测踩到第二次）：`计数 +1` 里的 `+`
 *    被当成量词，整个模式一条用例都选不中。而这**不会报错**：模式选不中任何用例时
 *    `ℹ tests` 仍然是 1（那是测试文件本身那一条），只判 `tests ≥ 1` 会把"模式写错了"
 *    读成"撤掉实现仍然通过"⇒ 假绿灯。写 pattern 时避开 `+ * ? ( ) [ ] { } . ^ $ |`，
 *    或用 `\+` 转义。选中的判据见下面 `realResults` 那段注释（两版错判据都在那儿记着）。
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  summaryContent: 'src/lib/summary-content.ts',
  // issue #85：「改动点」删除后这个模块只剩编制说明要点的覆盖度，文件随之改名 ——
  // 留着一个叫 amendment-coverage 却不再管修正案的名字，就是下一个读代码的人的坑。
  explanationCoverage: 'src/lib/explanation-coverage.ts',
  attachmentMode: 'src/lib/attachment-mode.ts',
  summarize: 'worker/jobs/summarize-notices.ts',
  noticePage: 'src/app/notices/[id]/page.tsx',
  reminders: 'worker/jobs/send-deadline-reminders.ts',
  subscription: 'src/lib/subscription.ts',
  subsRepo: 'src/db/repo/subscriptions.ts',
  summariesRepo: 'src/db/repo/summaries.ts',
  noticesRepo: 'src/db/repo/notices.ts',
  noticeRecency: 'src/lib/notice-recency.ts',
  homeQuery: 'src/app/_lib/home-query.ts',
  notify: 'worker/jobs/notify-new-notices.ts',
  mail: 'src/lib/mail.ts',
  feed: 'src/lib/feed.ts',
  channelGuidance: 'src/lib/channel-guidance.ts',
  compose: 'docker-compose.yml',
  dailyBackup: 'deploy/daily-backup.sh',
  alertBackup: 'scripts/alert-backup-failure.mjs',
  pipelineHealth: 'src/lib/pipeline-health.ts',
  noticeGenre: 'src/lib/notice-genre.ts',
  // issue #86 第 0 刀：诊断的形状与合成、以及适配器上报响应细节的那一段。
  // 这两处都是"撤掉之后没人看得出来"的典型 —— 诊断少写一个计数，页面一个字都不变，
  // 而下一轮改提示词的人会拿着一个说谎的量具去做决定。
  summaryDiagnostics: 'src/lib/summary-diagnostics.ts',
  llmAdapter: 'src/lib/adapters/openai-compatible-llm.ts',
  // issue #86 第 1 刀：影响判读的展示判据（页面 .tsx 进不了单测，所以判据抽在 .ts 里）
  impactDisplay: 'src/lib/impact-display.ts',
  // issue #47：审读记录的形状、读侧容错与「只减不加」的接受条件。它同样是"撤掉之后
  // 一个字都不报错"的一类 —— 指纹比对放宽一点，页面照常渲染，只是可能配着别人的结论。
  impactReview: 'src/lib/impact-review.ts',
  // issue #87（2026-10-03）：列表页「这条里有什么」的标记。判据在 `.ts`，渲染在 `.tsx` ——
  // 而 `.tsx` 撤不出红（e2e 跑构建产物），所以接线由 `tests/unit/notice-marks.test.mjs`
  // 最后那一组按**源码**钉。这两个键就是给它用的。
  noticeMarks: 'src/lib/notice-marks.ts',
  noticeItem: 'src/app/_lib/notice-item.tsx',
  // issue #86 第 2 刀：「改了哪几处」的覆盖度（改动表述计数 + 三态判词）
  changeCoverage: 'src/lib/change-coverage.ts',
  // issue #86 第二十节第 3 小节：那张表**行由程序定**（按句归并、缺口成行、标题不成行）。
  // 页面只按下标取，所以判据全在这个纯函数文件里 —— 页面 .tsx 进不了自证框架。
  changeTable: 'src/lib/change-table.ts',
  // issue #86 §19.4 收尾（2026-09-30）：读者侧接上 FeedReport。**两处接线**（详情页把清单
  // 传给摘要卡、摘要卡把它交给两处覆盖度判据）落在 `.tsx`，而 e2e 跑的是 `.next` 构建产物、
  // 撤 SSR 侧源码不会红 —— 所以那两处由 `tests/unit/feed-intake-note.test.mjs` 按**源码接线**
  // 钉住（判据本身仍在 .ts 里，另有用例）。这两个键就是给它们用的。
  summaryView: 'src/app/_lib/summary-view.tsx',
  // 2026-10-02 收尾：详情页容器的宽度规则。靶子是 CSS，而断言在
  // `tests/e2e/detail-layout.test.mjs` 里 —— 那条用例用 `readSource()` **直读源码文件**
  // （该文件头的原话：断点这类东西没有浏览器就断言不了），所以撤源码能让它变红。
  // 这不是"e2e 跑构建产物、撤源码不红"那条规则被打破，而是那条用例本来就不吃构建产物。
  pageCss: 'src/app/globals.css',
  summaryGate: 'scripts/show-notice-summary.mjs',
  // 2026-09-30：点名补摘要的工具（`--ids`，默认只读）。它是一条**生产写入**通道，
  // 所以"默认不写库""已有摘要要 --replace""覆盖前先备份"这三条各自要被撤一次。
  summarizeNow: 'scripts/summarize-now.mjs',
  // issue #86 第 3 刀：喂入侧的档位与预算。这一处撤掉之后**一个字都不会报错** ——
  // 档位判错就是"还是老样子"（回到标准档，页面照常出摘要），喂少了只是模型看到的东西变少，
  // 而那正是这一刀要消灭的静默失败，所以它必须有"撤掉实现必须变红"的钉子。
  attachmentFeed: 'src/lib/attachment-feed.ts',
  // issue #86 第十八节：人大网法律草案电子文档（开关 → 声明附件 → 按源预算放行）。
  // 三处都属于"撤掉之后什么都不报错"：开关失效只是"没有附件"（而请求也没发出去，
  // 源站日志里看不见）；文件名判据放宽只是页面上多一个猜出来的名字；按源预算失效则
  // 让那份 41 MB 的草案以 too_large 收场，看起来像"这个文件本来就不让下"。
  npcAdapter: 'src/sources/adapters/npc.ts',
  attachmentBudget: 'src/sources/attachment-budget.ts',
  // issue #83 补的三个"从没被自证覆盖过"的关键面：SSRF 防护、北极星计数的门口、
  // 后台 HTML 转义。它们此前要么只有 e2e 覆盖（而 e2e 跑的是构建产物，撤源码不红），
  // 要么一个测试都没有 —— 正是最该"撤掉实现必须变红"的三处。
  netGuard: 'src/lib/net-guard.ts',
  outboundCounting: 'src/lib/outbound-counting.ts',
  htmlEscape: 'src/lib/html-escape.ts',
  // issue #83 新增的判定与分类（三个纯函数，各自有单测钉着）
  audience: 'src/lib/audience.ts',
  summaryBasis: 'src/lib/summary-basis.ts',
  errorsLib: 'src/lib/errors.ts',
  journalPg: 'drizzle/postgres/meta/_journal.json',
  journalSqlite: 'drizzle/sqlite/meta/_journal.json',
  // 本脚本自己：它改写工作区源码，所以"崩了能不能自愈"和任何一处实现同样需要钉住
  pinsScript: 'scripts/check-test-pins.mjs',
  // 门的入口守卫：它认的就是本脚本留下的留痕，所以和本脚本一样属于"会被自己咬到"的那一类
  pinsClean: 'scripts/check-pins-clean.mjs',
  // e2e 的 bash 解析：解析错了的表现是一条与被测代码毫无关系的红，所以它自己要被钉住
  bashHelper: 'tests/e2e/helpers/bash.mjs',
  // 文档结构门：判据就写在这个测试文件里，所以钉的就是它自己
  docsIntegrity: 'tests/unit/docs-integrity.test.mjs',
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
  {
    label: '缺省收回到 shadow（条文抽好了却不喂摘要，#57 的成果仍不上页面）',
    file: 'attachmentMode',
    from: "  const value = raw === undefined || raw === '' ? 'on' : raw.toLowerCase();",
    to: "  const value = raw === undefined || raw === '' ? 'shadow' : raw.toLowerCase();",
    pattern: '附件档位',
    test: 'tests/unit/config-guards.test.mjs',
  },
  {
    label: 'shadow 也放开「摘要读」（三档塌成一档，影子轮失去意义）',
    file: 'attachmentMode',
    from: "  return rawMode() === 'on';",
    to: "  return rawMode() !== 'off';",
    pattern: '附件档位',
    test: 'tests/unit/config-guards.test.mjs',
  },
  {
    label: 'compose 回退值与代码缺省漂移（只改一处的三方不一致）',
    file: 'compose',
    from: '      ATTACHMENT_TEXT: ${ATTACHMENT_TEXT:-on}',
    to: '      ATTACHMENT_TEXT: ${ATTACHMENT_TEXT:-shadow}',
    pattern: '附件档位的三处缺省一致',
    test: 'tests/unit/deploy-env-contract.test.mjs',
  },
  {
    label: '核对不上出处的条文要点不再丢弃（模型编的条文直接上页面）',
    file: 'summaryContent',
    // issue #86：这一行原本是 `if (source === null) return;` 的裸返回，
    // 现在同一个判断里多了一句丢弃计数（诊断用），所以靶点改成条件本身。
    from: '    if (source === null) {',
    to: '    if (false) {',
    pattern: '核对不上出处的条文要点不落库',
    test: 'tests/unit/summary-draft-points.test.mjs',
  },
  {
    // 2026-09-28：去空白这一步抽成了 `stripQuoteWhitespace`（引用指纹与「改了哪几处」的
    // 按句归并**共用一份口径**），所以靶点跟着挪到那一行 —— 撤掉它，指纹就退回逐字符比对，
    // PDF 换行让真引用永远对不上。
    label: '出处比对退化成逐字符比对（PDF 换行让真引用永远对不上）',
    file: 'summaryContent',
    from: "  return text.replace(/[\\s\\u3000]+/g, '');",
    to: '  return text;',
    pattern: '引用必须逐字落在喂给模型的条文里',
    test: 'tests/unit/summary-draft-points.test.mjs',
  },
  {
    label: '影子档也喂条文（shadow 与 on 不再有任何区别）',
    file: 'summarize',
    // issue #86 第 3 刀把这一行搬进了 `feedPlanForSummary`（它同时要带出喂入清单），
    // 靶点跟着搬：判据（影子档不许喂）一个字没变，撤掉的实现也还是同一处。
    from: '  if (!attachmentTextFeedsSummary()) return { tier, sources: [], report };',
    to: '  if (false) return { tier, sources: [], report };',
    pattern: '附件条文进摘要',
    test: 'tests/e2e/summary-draft-input.test.mjs',
  },
  {
    label: '用到条文也不标「已喂」（详情页那句「本站读到的条文」失去依据）',
    file: 'summarize',
    // #86 第十六节把这一行换成了 `fedUrls`（正文那一份没有对应的附件行，要滤掉）——
    // 判据一个字没变：摘要真用了附件，就必须把附件标成已喂。
    from: '    if (fedUrls.length > 0) {',
    to: '        if (false) {',
    pattern: '附件条文进摘要',
    test: 'tests/e2e/summary-draft-input.test.mjs',
  },
  {
    label: '把「没探测过附件」说成「没有随文附件」',
    file: 'summaryDisplay',
    from: "  if (report === null) return { kind: 'not-probed' };",
    to: "  if (report === null) return { kind: 'no-attachments' };",
    pattern: '条文在哪',
    test: 'tests/unit/summary-display.test.mjs',
  },
  {
    label: '详情页不传附件报告（四个分支永远走默认文案，且不会报错）',
    file: 'noticePage',
    from: '            attachmentReport={draftReport}',
    to: '            attachmentReport={null}',
    pattern: '详情页把附件报告接到了摘要卡',
    test: 'tests/unit/summary-display.test.mjs',
  },
  {
    label: '提醒退回「剩余天数正好等于档」的旧规则（停摆一天就永久丢档）',
    file: 'reminders',
    from: '  const due = REMINDER_DAYS.filter((entry) => remainingDays <= entry.days);',
    to: '  const due = REMINDER_DAYS.filter((entry) => remainingDays === entry.days);',
    pattern: 'pickDueStage',
    test: 'tests/unit/reminder-stages.test.mjs',
  },
  {
    label: '过期不再被挡住（库列还写着 open 的过期条目会收到提醒）',
    file: 'reminders',
    from: '  if (remainingDays < 0) return { stage: undefined, allSent: false };',
    to: '  if (false) return { stage: undefined, allSent: false };',
    pattern: '已过截止一封都不发',
    test: 'tests/unit/reminder-stages.test.mjs',
  },
  {
    label: '补发不标注（剩 5 天却自称「截止前 7 天档」）',
    file: 'mail',
    from: '  return days === nominal',
    to: '  return true || days === nominal',
    pattern: '提醒邮件的档位措辞与实际剩余一致',
    test: 'tests/unit/reminder-stages.test.mjs',
  },
  {
    label: '机关匹配退回子串（订「司法部」会收到「司法部办公厅」的条目）',
    file: 'subscription',
    from: '    if (subscription.agencies.some((agency) => noticeAgencies.has(agency))) return true;',
    to: '    if (subscription.agencies.some((agency) => notice.agency.includes(agency))) return true;',
    pattern: '按参与机关逐个精确相等',
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    label: 'scope=all 不再生效（订全部的人只收到命中条件的）',
    file: 'subscription',
    from: "  if (subscription.scope === 'all') return true;",
    to: "  if (false) return true;",
    pattern: 'issue #60 第 2 刀',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '空条件被当成「订全部」（漏填的人会被所有新公示轰炸）',
    file: 'subscription',
    // issue #84 起这一支多带了 audiences 参数（受众面单独出现也算一条规则）
    from: '  if (!hasAnyRule({ keywords, categories, agencies, audiences })) {',
    to: '  if (false) {',
    pattern: 'validateSubscriptionRules：范围与条件的关系是显式的',
    // 必须指单测：这条判据在**路由**里被调用，而 e2e 跑的是 .next 构建产物 ——
    // 撤掉源码里的实现，构建产物照旧，测试不会红（规则 1；本条曾经就指错成 e2e 而假绿）。
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    label: '改订阅时漏写机关规则（重新提交一次就把机关清没）',
    file: 'subsRepo',
    from: '    agenciesJson: JSON.stringify(input.agencies),',
    to: '    agenciesJson: JSON.stringify([]),',
    pattern: '按参与机关命中',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '建行不写 first_seen_at（"新"失去判据，通知要么不发要么天天重发）',
    file: 'noticesRepo',
    from: '    firstSeenAt: input.fetchedAt,',
    to: '    firstSeenAt: null,',
    pattern: '新公示通知',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '没列进邮件的溢出条目也写成已通知（用户永远看不到它们）',
    file: 'notify',
    from: '        noticeIds: picked.map((notice) => notice.id),',
    to: '        noticeIds: candidates.map((notice) => notice.id),',
    pattern: '新公示通知',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '发信失败照样写去重标记（这批条目从此消失）',
    file: 'notify',
    from: "        ctx.logger(`新公示通知发送失败 subscription=${subscription.email}：${errorMessage(error)}`);\n        continue;",
    to: "        ctx.logger(`新公示通知发送失败 subscription=${subscription.email}：${errorMessage(error)}`);",
    pattern: '一封都没发出去',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '订阅改动不再挂待确认（回到"重复提交即静默改写"，FOLLOWUPS #52 的老问题）',
    file: 'subsRepo',
    from: '        pendingRulesJson: updated.pendingRulesJson,',
    to: '        pendingRulesJson: null,',
    pattern: 'issue #60 第 4 刀',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '确认时不套用待确认规则（用户点了确认，改的东西永远不生效）',
    file: 'subsRepo',
    from: '  if (row.confirmed === 1 && pending === null) return \'confirmed\';',
    to: '  if (row.confirmed === 1) return \'confirmed\';',
    pattern: '点确认之后：新规则才生效',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '确认页对"已确认+待套用"判定不看 pending（按钮不出现，改动永远卡住）',
    file: 'subsRepo',
    from: '  if (rows[0].confirmed === 1 && parsePendingRules(rows[0].pendingRulesJson) === null) {',
    to: '  if (rows[0].confirmed === 1) {',
    pattern: '提交修改后：新规则进待确认',
    test: 'tests/e2e/subscription-scope.test.mjs',
  },
  {
    label: '列表排序参数被忽略（四档排序全退成默认倒计时序）',
    file: 'noticesRepo',
    // 2026-09-26（issue #79）起 `ORDERS` 存的是**构造函数**而不是数组：聚合序的第一键
    // 要按展示口径现算"今天"，提成模块级常量会把今天冻结在进程启动那一刻。
    // 所以这里连那次调用一起撤（撤掉调用 = 四档全走默认聚合序）。
    from: "  return ORDERS[sort ?? 'deadline']();",
    to: '  return aggregationOrder();',
    pattern: 'issue #62 仓储层：排序档位',
    test: 'tests/e2e/discovery-repo.test.mjs',
  },
  {
    label: '「只看未截止」只看库里状态（刚过截止、抓取还没改口的条目混进来）',
    file: 'noticesRepo',
    // 判据自 issue #65 起抽成 `openCondition()`（表上的「未截止」格与 WHERE 共用一份），
    // 缩进随之从 10 空格变成 6 空格 —— 片段跟着挪，撤的仍是同一个日期比较
    from: '      sql`substr(${notices.deadlineAt}, 1, 10) >= ${siteDateIso(new Date())}`,',
    to: '      sql`1 = 1`,',
    pattern: 'issue #62 仓储层：只看未截止与最近新增',
    test: 'tests/e2e/discovery-repo.test.mjs',
  },
  {
    label: '「最近新增」按 fetched_at 判（每天被重抓的老条目天天算新增）',
    file: 'noticesRepo',
    from: '      gte(notices.firstSeenAt, recencyCutoffIso(new Date(), options.firstSeenWithinDays)),',
    to: '      gte(notices.fetchedAt, recencyCutoffIso(new Date(), options.firstSeenWithinDays)),',
    pattern: 'issue #62 仓储层：只看未截止与最近新增',
    test: 'tests/e2e/discovery-repo.test.mjs',
  },
  {
    label: '「最近新增」条件根本不进 WHERE（入口在、什么都不筛）',
    file: 'noticesRepo',
    from: '      gte(notices.firstSeenAt, recencyCutoffIso(new Date(), options.firstSeenWithinDays)),',
    to: '      sql`1 = 1`,',
    pattern: 'issue #62 仓储层：只看未截止与最近新增',
    test: 'tests/e2e/discovery-repo.test.mjs',
  },
  {
    label: '收录时间窗口把天当成分钟（「近 7 天」实为 7 分钟）',
    file: 'noticeRecency',
    from: '  return new Date(now.getTime() - days * DAY_MS).toISOString();',
    to: '  return new Date(now.getTime() - days * 60_000).toISOString();',
    pattern: 'issue #62：recencyCutoffIso 的形状与算法',
    test: 'tests/unit/notice-recency.test.mjs',
  },
  {
    label: '「新」角标的比较方向反了（老条目带角标、新条目不带）',
    file: 'noticeRecency',
    from: '  return seenAt >= Date.parse(recencyCutoffIso(now, days));',
    to: '  return seenAt <= Date.parse(recencyCutoffIso(now, days));',
    pattern: 'issue #62：isNewNotice',
    test: 'tests/unit/notice-recency.test.mjs',
  },
  {
    label: '排序值不做白名单（任意 `?sort=` 都当一档传下去）',
    file: 'homeQuery',
    from: '  return isNoticeSortKey(raw) ? raw : undefined;',
    to: '  return raw as NoticeSortKey;',
    pattern: '排序与收录范围（issue #62）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: 'since 越界被夹到上限（读者要全部，页面给的是窄的一页）',
    file: 'homeQuery',
    from: '  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SINCE_DAYS) return undefined;',
    to: '  if (!Number.isInteger(parsed) || parsed < 1) return undefined;',
    pattern: '排序与收录范围（issue #62）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: 'open=0 / open=任意值都被当成「只看未截止」',
    file: 'homeQuery',
    from: "  return firstParam(value) === '1';",
    to: '  return firstParam(value) !== undefined;',
    pattern: '排序与收录范围（issue #62）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '「只看未截止」不算筛选维度（这一页可被收录，条数文案也不说口径）',
    file: 'homeQuery',
    from: '      openOnly ||',
    to: '      false ||',
    pattern: '排序与收录范围（issue #62）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '子 feed 的频道标题不写条件（订的人不知道这份 feed 筛掉了什么）',
    file: 'feed',
    from: '    `    <title>${escapeXml(feedChannelTitle(filterLabel))}</title>`,',
    to: '    `    <title>${escapeXml(feedChannelTitle())}</title>`,',
    pattern: 'issue #63：buildFeedXml 的 channel 与转义',
    test: 'tests/unit/feed-subscription.test.mjs',
  },
  {
    label: 'atom:link self 丢掉条件（两份订阅在阅读器里被当成同一个源）',
    file: 'feed',
    from: '    `    <atom:link href="${escapeXml(selfUrl ?? `${base}/feed.xml`)}" rel="self" type="application/rss+xml" />`,',
    to: '    `    <atom:link href="${escapeXml(`${base}/feed.xml`)}" rel="self" type="application/rss+xml" />`,',
    pattern: 'issue #63：buildFeedXml 的 channel 与转义',
    test: 'tests/unit/feed-subscription.test.mjs',
  },
  {
    label: '「只看未截止」不进条件摘要（首页那行口径说明与 feed 标题分家）',
    file: 'homeQuery',
    from: "    query.openOnly ? '只看未截止' : '',",
    to: "    '',",
    pattern: '条件的说法与地址（issue #63）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '子 feed 地址丢掉 open（订到的比页面上看到的多）',
    file: 'homeQuery',
    from: "  if (query.openOnly) search.set('open', '1');",
    to: '',
    pattern: '条件的说法与地址（issue #63）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '子 feed 地址丢掉 since（同上，换一维度各钉一次）',
    file: 'homeQuery',
    from: '  if (query.sinceDays) search.set(\'since\', String(query.sinceDays));',
    to: '',
    pattern: '条件的说法与地址（issue #63）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '有渠道也照样给"我没取到"的说明（页面自相矛盾）',
    file: 'channelGuidance',
    from: '  if (input.hasChannels) return null;',
    to: '',
    pattern: 'issue #64：channelGuidance 的分支',
    test: 'tests/unit/channel-guidance.test.mjs',
  },
  {
    label: '正文为空与正文里没句式混成一种（把"读过没找到"说成"没拿到正文"）',
    file: 'channelGuidance',
    from: "    reason: input.bodyChars > 0 ? 'not-in-body' : 'no-body',",
    to: "    reason: 'no-body',",
    pattern: 'issue #64：channelGuidance 的分支',
    test: 'tests/unit/channel-guidance.test.mjs',
  },
  {
    label: '影子档（抽到正文没喂摘要）不算可读（读者被阻止去附件里自己找）',
    file: 'channelGuidance',
    // 只撤 `read-not-used` 那一半：撤整个 readable 会连"可读时指向附件"一起红，
    // 钉的就不是影子档这个决定了（片段在文件里首次出现处即判定行，份数行不受影响）
    from: " || draft.kind === 'read-not-used'",
    to: '',
    pattern: 'issue #64：channelGuidance 的分支',
    test: 'tests/unit/channel-guidance.test.mjs',
  },
  {
    label: '「抽取还没跑到」报成「没有附件」（白删读者一个去处）',
    file: 'channelGuidance',
    from: "          : 'unknown';",
    to: "          : 'none';",
    pattern: 'issue #64：channelGuidance 的分支',
    test: 'tests/unit/channel-guidance.test.mjs',
  },
  {
    label: '说明里不说附件份数（"有 3 份附件"退化成"有附件"）',
    file: 'channelGuidance',
    from: '        ? draft.files',
    to: '        ? 0',
    pattern: 'issue #64：channelGuidance 的分支',
    test: 'tests/unit/channel-guidance.test.mjs',
  },
  {
    label: 'sourceId 条件不进 WHERE（来源下拉存在但什么都不筛）',
    file: 'noticesRepo',
    from: '    conditions.push(eq(notices.sourceId, options.sourceId));',
    to: '    conditions.push(sql`1 = 1`);',
    pattern: 'issue #65 仓储层：来源聚合',
    test: 'tests/e2e/source-facets.test.mjs',
  },
  {
    label: '「未截止」那一格按库列算（表上多出来的那条点进去其实已截止）',
    file: 'noticesRepo',
    // 判据函数自 2026-09-26（issue #79）起叫 `stillOpen()`（原名 `openCondition()`）：
    // 它现在多了第三个调用方 —— 默认排序的第一档，所以名字不能再只说"open=1 的条件"
    from: '        openCount: sql<number>`sum(case when ${stillOpen()} then 1 else 0 end)`,',
    to: "        openCount: sql<number>`sum(case when ${notices.status} = 'open' then 1 else 0 end)`,",
    pattern: 'issue #65 仓储层：来源聚合',
    test: 'tests/e2e/source-facets.test.mjs',
  },
  {
    label: '不取最近收录时间（"源活着但不送新东西"重新变成看不见的故障）',
    file: 'noticesRepo',
    from: '        lastFirstSeenAt: sql<string | null>`max(${notices.firstSeenAt})`,',
    to: '        lastFirstSeenAt: sql<string | null>`null`,',
    pattern: 'issue #65 仓储层：来源聚合',
    test: 'tests/e2e/source-facets.test.mjs',
  },
  {
    label: '零收录的源被挤掉表（只看得到有数据的源，恰好漏掉要看的）',
    file: 'noticesRepo',
    from: '  for (const row of registered) {',
    to: '  for (const row of []) {',
    pattern: 'issue #65 仓储层：来源聚合',
    test: 'tests/e2e/source-facets.test.mjs',
  },
  {
    label: '来源名不查登记表、只显示 ID（给人读的那一行露出内部标识）',
    file: 'noticesRepo',
    from: '      name: names.get(row.id) ?? row.id,',
    to: '      name: row.id,',
    pattern: 'issue #65 仓储层：来源聚合',
    test: 'tests/e2e/source-facets.test.mjs',
  },
  {
    label: '登记表外的源也标成已登记（差额被静默归并，issue #46 的老毛病）',
    file: 'noticesRepo',
    from: '      registered: names.has(row.id),',
    to: '      registered: true,',
    pattern: 'issue #65 仓储层：来源聚合',
    test: 'tests/e2e/source-facets.test.mjs',
  },
  {
    label: '来源条件从口径说明里消失（页面上筛了、说明里不说）',
    file: 'homeQuery',
    from: "    query.source ? `来源：${sourceName ?? query.source}` : '',",
    to: "    '',",
    pattern: '按来源筛选（issue #65）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '子 feed 地址丢掉 source（订到的比页面上看到的多）',
    file: 'homeQuery',
    from: "  if (query.source) search.set('source', query.source);",
    to: '',
    pattern: '按来源筛选（issue #65）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    label: '来源不算筛选维度（这一页可被收录，且索引口径与渲染相反）',
    file: 'homeQuery',
    from: '      source !== undefined ||',
    to: '      false ||',
    pattern: '按来源筛选（issue #65）',
    test: 'tests/unit/home-query.test.mjs',
  },
  {
    // 2026-09-24 生产事故（issue #66）的形状：手工补迁移时 `when` 写得比前一条早，
    // drizzle 对**存量库**会静默跳过它 —— 全新库一次全跑，所以本地全绿也照样出事。
    label: 'journal 的 when 再次非单调（postgres 结构守卫）',
    file: 'journalPg',
    from: '      "when": 1791072004000,',
    to: '      "when": 1789000000004,',
    pattern: 'journal 的 when 严格递增（postgres）',
    test: 'tests/e2e/migrations-integrity.test.mjs',
  },
  {
    label: 'journal 的 when 再次非单调（sqlite 行为守卫：两阶段迁移补不上晚到的列）',
    file: 'journalSqlite',
    from: '      "when": 1791072004000,',
    to: '      "when": 1789000000004,',
    pattern: '存量库向后迁移会补上晚到的迁移',
    test: 'tests/e2e/migrations-integrity.test.mjs',
  },
  {
    label: '置换时不置回 pending（清空了摘要却永远不再被生成）',
    file: 'summariesRepo',
    // issue #86：`clearSummaryForRedraft` 的 `.set({…})` 从一行改成了多行（多了诊断列），
    // 靶点随之落到具体属性行上 —— 撤掉这一行，条目就留在 done 里再也排不到摘要任务。
    from: "      summaryStatus: 'pending',",
    to: '      // 撤掉实现：不置回 pending',
    pattern: 'issue #67：clearSummaryForRedraft',
    test: 'tests/e2e/summary-redraft.test.mjs',
  },
  {
    label: '放回队列时漏清模型名（恢复核对时对不上旧值）',
    file: 'summariesRepo',
    from: '      summaryModel: null,',
    to: '      // 撤掉实现：不清模型名',
    pattern: 'issue #67：clearSummaryForRedraft',
    test: 'tests/e2e/summary-redraft.test.mjs',
  },
  {
    // issue #47：这一列描述的是**那一份判读文本**被审读过什么，而判读随摘要一起没了。
    // 不清的后果是具体的：重跑产出的新判读若与旧文本指纹相同（一字未改），它会静默继承
    // 上一轮的审读结论 —— 而那份结论审的是"上一次那一份"。
    label: '重跑不清审读记录（新判读静默继承上一轮的审读结论）',
    file: 'summariesRepo',
    from: '      impactReviewJson: null,',
    to: '      // 撤掉实现：不清审读记录',
    pattern: '审读记录随重跑一起清空',
    test: 'tests/e2e/summary-redraft.test.mjs',
  },
  {
    // issue #47：审读记录必须**与摘要同一次写入**（"这一列摘要是哪一次调用产出的"只有一个答案）。
    // 撤成 null 之后摘要照常生成、页面照常渲染，只是这一批判读在门翻转之后会集体不渲染 ——
    // 而那时看不出是"审读根本没跑"还是"审读把它们都判负了"。
    label: '摘要落库时不写审读记录（翻转后这批判读集体消失且看不出原因）',
    file: 'summariesRepo',
    from: '      impactReviewJson: input.impactReviewJson,',
    to: '      impactReviewJson: null,',
    pattern: '名单外的条目一个字节不动',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  {
    label: '探针没看到备份目录也报健康（把"我不知道"折叠成"没问题"）',
    file: 'pipelineHealth',
    from: '  if (!input.seenDir) {',
    to: '  if (false) {',
    pattern: 'issue #74：备份产物判据',
    test: 'tests/unit/pipeline-health.test.mjs',
  },
  {
    label: '备份新鲜度不看阈值（永远 ok ⇒ #68 那种"整天没备份"再也不会响）',
    file: 'pipelineHealth',
    from: "    verdict: input.newestAgeHours <= BACKUP_MAX_AGE_HOURS ? 'ok' : 'fail',",
    to: "    verdict: 'ok',",
    pattern: 'issue #74：备份产物判据',
    test: 'tests/unit/pipeline-health.test.mjs',
  },
  {
    label: 'RSS 探针没取到也报健康（把"我不知道"折叠成"没问题"，#68 同族）',
    file: 'pipelineHealth',
    from: '  if (input.feed.ok === false) {',
    to: '  if (false) {',
    pattern: 'issue #75：RSS 判据',
    test: 'tests/unit/pipeline-health-rss.test.mjs',
  },
  {
    label: 'feed 落后于库不翻红（读者少条目，页面全绿）',
    file: 'pipelineHealth',
    from: '  if (input.missingIds.length > 0) {',
    to: '  if (false) {',
    pattern: 'issue #75：RSS 判据',
    test: 'tests/unit/pipeline-health-rss.test.mjs',
  },
  {
    label: '不查没转义的 &（一份非法 XML 会被读者整份拒收）',
    file: 'pipelineHealth',
    from: '          : /&(?!(amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(xml)',
    to: '          : false',
    pattern: 'issue #75：feed 解析与比对口径',
    test: 'tests/unit/pipeline-health-rss.test.mjs',
  },
  {
    label: '比对口径拿最旧的一截当基数（feed 停止更新也不会红）',
    file: 'pipelineHealth',
    from: "    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))",
    to: "    .sort((a, b) => (a.publishedAt ?? '').localeCompare(b.publishedAt ?? ''))",
    pattern: 'issue #75：feed 解析与比对口径',
    test: 'tests/unit/pipeline-health-rss.test.mjs',
  },
  {
    label: '每日备份的安装片段丢掉 CRON_TZ=UTC（`30 19` 就变成北京时间，备份静默不跑）',
    file: 'dailyBackup',
    from: "crontab -l 2>/dev/null | { echo 'CRON_TZ=UTC';",
    to: 'crontab -l 2>/dev/null | {',
    pattern: '每日备份的安装片段带 CRON_TZ=UTC',
    test: 'tests/unit/deploy-env-contract.test.mjs',
  },
  {
    label: '脚本自己 exit 1 的那两处不发信（只剩 EXIT trap 能抓住校验不通过）',
    file: 'dailyBackup',
    from: "trap 'rc=$?; if [ \"$rc\" -ne 0 ]; then alert_failure \"$rc\"; fi; exit \"$rc\"' EXIT",
    to: '',
    pattern: 'issue #71：每日备份失败要发一封告警',
    test: 'tests/e2e/backup-failure-alert.test.mjs',
  },
  {
    label: '告警的 jobName 写错（收信人认不出这是备份还是某个抓取源）',
    file: 'alertBackup',
    from: "    jobName: 'daily-backup',",
    to: "    jobName: 'crawl-notices',",
    pattern: 'issue #71：告警脚本自己（复用 worker 的告警出口）',
    test: 'tests/e2e/backup-failure-alert.test.mjs',
  },
  // 「空名单提前返回」那道保护**不占 pin 位**（2026-09-24 实测）：撤掉 `if (ids.length === 0) return []`
  // 之后 e2e 仍然全绿 —— drizzle 把空的 `inArray` 编成恒假条件而不是非法 SQL，那句没有可观测行为。
  // 记在这里而不是删掉不留痕：留一条钉不住的 pin，下一轮就会以为它被验证过。
  {
    label: '崩溃后不自愈（工作区留着撤掉实现后的假代码，还能被编进构建产物）',
    file: 'pinsScript',
    // 撤的是"写回原样"那一句，不是 `recoverInflight` 的调用。为什么下面这串要拆成两截：
    // 本用例的靶子就是本脚本，整串写在这里会让第一次命中的是这一行"引用"而不是被撤的实现
    // （`.replace` 只换第一个匹配），于是撤了个寂寞、用例永远为绿 —— 规则 4 的第二发
    from: '    writeFileSync(record.file, record.' + 'original);',
    to: '',
    pattern: 'issue #67：撤实现脚本的崩溃自愈',
    test: 'tests/unit/pins-self-heal.test.mjs',
  },
  {
    label: '名单类不再最先判（名单条目被当草案处理，或打包项被名单词吞掉）',
    file: 'noticeGenre',
    from: '  const listHit = LIST_TITLE.exec(title);',
    to: '  const listHit = null as RegExpExecArray | null;',
    pattern: 'issue #76：体裁判定',
    test: 'tests/unit/notice-genre.test.mjs',
  },
  {
    label: '打包清单不抢先判（"等11项标准"会被当成单一修正案逐条摘要）',
    file: 'noticeGenre',
    from: '  const packageHit = PACKAGE_TITLE.exec(title);',
    to: '  const packageHit = null as RegExpExecArray | null;',
    pattern: 'issue #76：体裁判定',
    test: 'tests/unit/notice-genre.test.mjs',
  },
  {
    label: '判不出来就兜底成新案（修正案会静默用错模板，表现只是摘要短了一点）',
    file: 'noticeGenre',
    from: "  return { genre: 'unknown', basis: '标题与附件名都没有体裁线索，不兜底成任何一类', evidence: 'none' };",
    to: "  return { genre: 'new_draft', basis: '兜底', evidence: 'title' };",
    pattern: 'issue #76：体裁判定',
    test: 'tests/unit/notice-genre.test.mjs',
  },
  {
    label: '弱证据也能覆盖强证据（抓取每轮把正文级判定降回标题级，摘要形态天天抖）',
    file: 'noticeGenre',
    from: '  return GENRE_EVIDENCE_RANK[next] >= GENRE_EVIDENCE_RANK[stored];',
    to: '  return true;',
    pattern: 'issue #76：证据强度覆盖规矩',
    test: 'tests/unit/notice-genre.test.mjs',
  },
  {
    // issue #85：这三条原来钉的是「改动点」的覆盖度（分母数正文里的修改表述）。
    // 那套功能因**从未产出过**被整体删除，覆盖度只剩**编制说明要点**这一侧 ——
    // 判据同构（列得少要照实说少、0 个标题不许说成"全部"、启发式数字要带"约"），
    // 所以 pin 原样搬到新模块与新用例上，而不是连带删掉。
    label: '说明要点覆盖度永远说"已列出全部"（窗口截掉的小节被藏起来）',
    file: 'explanationCoverage',
    from: '  if (listed >= sections) {',
    to: '  if (true) {',
    // pattern 必须选中**真的区分这两种状态**的那条用例：指到"分母为 0"那条时，
    // 撤掉这一行它照样绿（实测 —— 本轮第二次踩到"指对了文件、指错了用例"这种假绿灯）。
    pattern: '列得比数到的少要照实说少',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    label: '说明一个标题都没数到也写成"已列出全部 0 个"（读者以为这份说明没有小节）',
    file: 'explanationCoverage',
    from: '  if (sections === 0) {',
    to: '  if (false) {',
    pattern: '分母为 0 时不写',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    label: '说明覆盖度的措辞不再带"约"（启发式数字被说成精确的）',
    file: 'explanationCoverage',
    from: "    return { state: 'complete', detail: `已列出检测到的约 ${sections} 个小节` };",
    to: "    return { state: 'complete', detail: `已列出检测到的 ${sections} 个小节` };",
    pattern: '措辞带"约"',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    // 2026-09-26 补（issue #79）：`force` 是"改了词表之后存量才改得动"的唯一出口。
    // 撤掉它就等于回到"覆盖规矩把全部改动挡在门外"—— 那正是生产上那 22 条一条都修不了的原因。
    label: '词表变更后回填仍守弱证据不覆盖强证据（22 条错判一条都改不动）',
    file: 'noticesRepo',
    from: '    if (!options.force && row.genre !== null && !genreDecisionWins(decision.evidence, storedEvidence)) {',
    to: '    if (row.genre !== null && !genreDecisionWins(decision.evidence, storedEvidence)) {',
    pattern: 'issue #79：改词表后的存量回填',
    test: 'tests/e2e/summary-genre-and-explanations.test.mjs',
  },
  {
    label: '条文与说明共用一个反查池（说明里的话会被标成"摘自条文的原文"）',
    file: 'summaryContent',
    from: "  const draftSide = (draftSources ?? []).filter((source) => source.role !== 'explanation');",
    to: '  const draftSide = draftSources ?? [];',
    pattern: 'issue #76 第 3 刀：段落隔离',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    label: '说明要点也允许引用条文段落（解释与规定混成一片）',
    file: 'summaryContent',
    from: "  const explanationSide = (draftSources ?? []).filter((source) => source.role === 'explanation');",
    to: '  const explanationSide = draftSources ?? [];',
    pattern: 'issue #76 第 3 刀：段落隔离',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    label: '说明要点缺引用/缺说明也落库（页面出现无从核对的小节）',
    file: 'summaryContent',
    from: "    if (quote === null || text === '') continue;",
    to: '    if (false) continue;',
    pattern: 'issue #76 第 3 刀：段落隔离',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    label: '强杀留痕不再拦截（门放行，人对着与被测改动毫无关系的红自己猜）',
    file: 'pinsClean',
    from: 'if (existsSync(MARKER)) {',
    to: 'if (false) {',
    pattern: '并说出当时撤的是哪一条',
    test: 'tests/unit/pins-clean-guard.test.mjs',
  },
  {
    label: 'ZW_BASH 写错了悄悄退回自动探测（覆盖值变成一个"改了没效果"的旋钮）',
    file: 'bashHelper',
    from: '    if (!works(override)) {',
    to: '    if (false) {',
    pattern: '不静默退回自动探测',
    test: 'tests/unit/bash-resolver.test.mjs',
  },
  {
    label: '转义的竖线也被当成列分隔（合法的 GFM 写法被误报，门开始骗人）',
    file: 'docsIntegrity',
    // 用 String.raw：这串里有三个反斜杠，写成普通字符串是 `\\\\` 那种没人看得懂的样子
    from: String.raw`.split(/(?<!\\)\|/).length;`,
    to: '.split(/\\|/).length;',
    pattern: '转义过的竖线',
    test: 'tests/unit/docs-integrity.test.mjs',
  },
  // ── issue #83：新加的几条 + 三个"从没被自证覆盖过"的关键面 ──────────────
  {
    // SSRF 的核心那一行：撤掉它，私网 / 环回 / 云元数据字面量全部放行
    // （末尾剥点那条守卫不是唯一防线，`ipv4Value` 自己也能吃下 `10.0.0.1.`，
    //  所以拿它当靶子会得到一条"撤了也不红"的假用例 —— 这正是本脚本存在的理由）
    label: 'SSRF：IPv4 私网段判定被撤（169.254.169.254 云元数据直接放行）',
    file: 'netGuard',
    from: '    return BLOCKED_IPV4_RANGES.some(([base, prefix]) => inIpv4Range(ipv4, base, prefix));',
    to: '    return false;',
    pattern: 'IPv4 私网、环回、链路本地、CGNAT 与保留段',
    test: 'tests/unit/net-guard.test.mjs',
  },
  {
    // 北极星指标的门口：这一行被撤掉，爬虫与 curl 的每一次遍历都算成"读者的一次提意"
    label: '北极星：脚本 / 爬虫 UA 照常计数（指标被机器灌水）',
    file: 'outboundCounting',
    from: '  if (SCRIPT_CLIENT_UA.test(ua) || BOT_UA_PATTERN.test(ua)) {',
    to: '  if (false) {',
    pattern: '空 UA 与脚本运行时 UA 都不算',
    test: 'tests/unit/outbound-counting.test.mjs',
  },
  {
    // 后台是**带令牌的登录态**，而它插值的错误信息 / 源名来自源站。撤掉转义 = 一发 XSS
    label: '后台转义：`<` 不再转义（源站可控的错误信息变成真标签）',
    file: 'htmlEscape',
    from: "    .replaceAll('<', '&lt;')",
    to: "    .replaceAll('<', '<')",
    pattern: '五个字符全部转义',
    test: 'tests/unit/admin-html.test.mjs',
  },
  {
    label: '受众面：「办法」也被当成立法（负向断言被撤，行业规章全被推给公众）',
    file: 'audience',
    // 靶点跟着 2026-09-27 那次收窄搬到了简写分支上：负向断言现在管的是
    // 「办法 / 方法 + 括号里写着草案」这个形状（判据与用例同步扩了一条，见 audience.test.mjs）。
    from: '(?<![办方做想用说合])法\\s*[（(][^）)]{0,20}草案|',
    to: '法\\s*[（(][^）)]{0,20}草案|',
    pattern: '「办法」里的法字不算立法',
    test: 'tests/unit/audience.test.mjs',
  },
  {
    label: '受众面：判不出来硬塞进一类（「未判定」这个诚实的出口被堵死）',
    file: 'audience',
    from: "  return { audience: 'unknown', basis: '标题与来源都没有足够线索，不兜底成任何一类' };",
    to: "  return { audience: 'sector', basis: '标题与来源都没有足够线索，兜底成行业专业' };",
    pattern: '判不出来就是 unknown',
    test: 'tests/unit/audience.test.mjs',
  },
  {
    // 撤销的是"读了附件但产不出条文要点"与"读了且要点已产出"的区分：撤掉之后
    // 名单 / 打包清单类会被标成「已优化」，页面又会指着一段不存在的栏位说话
    label: '摘要依据：不再区分「喂了附件但零要点」（名单类被标成已优化）',
    file: 'summaryBasis',
    from: '            : input.hasAttachmentPoints',
    to: '            : false',
    pattern: '附件要点已产出',
    test: 'tests/unit/summary-basis.test.mjs',
  },
  {
    label: '摘要依据：旧模板不再算「可重跑」（运营拿着清单也不知道该跑哪些）',
    file: 'summaryBasis',
    from: "    return template === 'current' ? 'optimized' : 'upgradable';",
    to: "    return 'optimized';",
    // 注意 pattern 是**正则**：名字里的 `+` 会被当成量词，所以只取没有元字符的一段
    pattern: '旧模板',
    test: 'tests/unit/summary-basis.test.mjs',
  },
  {
    label: '错误文本退回不认 Error（日志与告警里只剩 [object Object]）',
    file: 'errorsLib',
    from: '  return error instanceof Error ? error.message : String(error);',
    to: '  return String(error);',
    pattern: 'Error 实例取 message',
    test: 'tests/unit/errors.test.mjs',
  },
  // ---- issue #84：受众面进订阅规则 + 截止提醒合并成一封 ----
  {
    // 撤掉这一行 = 受众面从"收窄条件"退回"根本不起作用"。最直接的表现是
    // 勾了「公众广域」的人照样收到行业标准 —— 而这一栏在页面上明明写着"只发这几类"。
    label: '受众面不再收窄（勾了公众广域的人照样收到行业标准）',
    file: 'subscription',
    from: '  if (!matchesAudienceFilter(subscription, notice)) return false;',
    to: '  if (false) return false;',
    pattern: 'issue #84',
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    // 收窄判在 scope='all' 之后 = "订全部 + 只看公众广域"的人收到全部。
    // 这一条单独占一个用例，因为它撤的是**顺序**而不是判断本身，最容易在重构里被挪回去。
    label: '受众面被挪到「订全部」短路之后（收了全部却说只看那一档）',
    file: 'subscription',
    from: "  if (subscription.scope === 'all') return true;",
    to: "  if (subscription.scope === 'all' && false) return true;",
    pattern: 'scope=all 也受受众面收窄',
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    label: '只勾受众面被当成"没有规则"（"这类公示我都要"变成一条永远收不到信的订阅）',
    file: 'subscription',
    from: '  return hasAudienceRules;',
    to: '  return false;',
    pattern: '只勾受众面是一条完整可用的订阅',
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    label: '受众面不算一条有效规则（只勾受众面的人一提交就被 no_rules 拒掉）',
    file: 'subscription',
    from: '    || (rules.audiences ?? []).length > 0',
    to: '    || false',
    pattern: '受众面能单独撑起一条规则',
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    label: '「未判定」也变成可订档（订阅表单上多出一档没人会选的意图）',
    file: 'audience',
    from: "export const SUBSCRIBABLE_AUDIENCES: readonly NoticeAudience[] = ['public', 'sector'];",
    to: "export const SUBSCRIBABLE_AUDIENCES: readonly NoticeAudience[] = ['public', 'sector', 'unknown'];",
    pattern: '可选项只有两档',
    test: 'tests/unit/subscription-rules.test.mjs',
  },
  {
    label: '确认邮件漏写受众面（用户确认的规则与实际生效的不是同一份）',
    file: 'mail',
    from: '    parts.push(`受众面（收窄条件，只有这些才会发）：${audienceLabel}`);',
    to: '    parts.push(``);',
    pattern: 'issue #84：确认邮件里的受众面',
    test: 'tests/unit/mail-html.test.mjs',
  },
  {
    label: '订全部 + 勾了受众面时仍写成「不限关键词 / 领域 / 机关」（把收窄说没了）',
    file: 'mail',
    from: '      : `订阅范围：收录的全部新公示，但只发受众面属于「${audienceLabel}」的那些`;',
    to: '      : `订阅范围：收录的全部新公示（不限关键词 / 领域 / 机关）`;',
    pattern: 'scope=all \\+ 受众面',
    test: 'tests/unit/mail-html.test.mjs',
  },
  {
    label: '待确认规则漏写受众面（确认一次之后受众面悄悄消失）',
    file: 'subsRepo',
    from: '    audiences: rules.audiences,',
    to: '    audiences: [],',
    pattern: '确认前生效的仍是旧的那一档',
    test: 'tests/e2e/subscribe-audience.test.mjs',
  },
  {
    label: '读侧不再过滤受众面白名单（脏值留在规则里，这条订阅永远收不到信且毫无报错）',
    file: 'subsRepo',
    from: '  return safeParseArray(text).filter(isSubscribableAudience);',
    to: '  return safeParseArray(text);',
    pattern: '读侧：列里出现白名单外的值一律丢掉',
    test: 'tests/e2e/subscribe-audience.test.mjs',
  },
  {
    // 撤掉合并 = 回到"一条公示一封"。生产上真的发生过：2026-09-25 那一轮给同一个
    // 人连发 6 封，站长随后退订（原话"订阅信息有点多"）。这条 pin 撤的是信的数量，
    // 不是信的内容 —— 所以它必须由 e2e 来钉（e2e 里 worker 子进程跑的就是源码）。
    label: '提醒退回「一条公示一封」（同一个人一轮里收到 N 封）',
    file: 'reminders',
    from: '          listed.length === 1',
    to: '          true || listed.length === 1',
    pattern: '提醒触发时机与内容',
    test: 'tests/e2e/deadline-reminders.test.mjs',
  },
  {
    label: '上限截断后把溢出的也标成「已通知」（那些条目用户永远看不到）',
    file: 'reminders',
    from: '        listed.map((item) => ({ noticeId: item.notice.id, stage: item.stage })),',
    to: '        due.map((item) => ({ noticeId: item.notice.id, stage: item.stage })),',
    pattern: '合并提醒的条数上限',
    test: 'tests/e2e/subscribe-audience.test.mjs',
  },
  {
    // 构建期的 npm 源（issue #84 部署时加的）。写成硬编码 = .env 里设了也不生效，
    // 而表现是"改了没反应"（构建照旧从被限速的官方源拉），正是幽灵旋钮那一族。
    label: '构建期 npm 源不再转发（.env 里设了也没用，构建照旧走官方源）',
    file: 'compose',
    from: '        NPM_REGISTRY: ${NPM_REGISTRY:-https://registry.npmjs.org}',
    to: '        NPM_REGISTRY: https://registry.npmjs.org',
    pattern: '构建期参数按服务逐条转发',
    test: 'tests/unit/deploy-env-contract.test.mjs',
  },
  {
    // issue #86 第 0 刀：五处各钉一个 —— 落库 / 反查计数 / 归一化计数 / 失败路径 /
    // "没人看过"与"什么都没说"分得开。
    label: '诊断不落库（摘要照常写，但"这一次调用怎么了"永远查不到）',
    file: 'summarize',
    from: '      diagnosticsJson: JSON.stringify(diagnostics),',
    to: '          diagnosticsJson: null,',
    pattern: 'issue #86：摘要调用的诊断随摘要落库',
    test: 'tests/e2e/summary-genre-and-explanations.test.mjs',
  },
  {
    label: '反查失败不计数（丢掉的行从此不留痕迹 —— 改动点当年就是这么死的）',
    file: 'summaryContent',
    from: '      tally.quoteNotFound += 1;',
    to: '      ;',
    pattern: '且那一条不落库',
    test: 'tests/unit/summary-diagnostics.test.mjs',
  },
  {
    label: '超条数上限丢掉的点不计数（诊断说"一条没丢"，实际丢了 3 条）',
    file: 'llmAdapter',
    from: '      if (tally) tally.overLimit += 1;',
    to: '      if (false) tally.overLimit += 1;',
    pattern: '条文要点超过上限 ⇒ 超上限计数 = 多出来的条数',
    test: 'tests/unit/summary-diagnostics.test.mjs',
  },
  {
    label: '端口没上报却写成"有人看过"（把"没人看过"读成"模型什么都没说"）',
    file: 'summaryDiagnostics',
    from: '    instrumented: false,',
    to: '    instrumented: true,',
    pattern: '端口未上报 ⇒ 说清"没人看过"，但落库条数与丢弃数照样写',
    test: 'tests/unit/summary-diagnostics.test.mjs',
  },
  {
    label: '失败路径不挂诊断（"模型输出不是合法 JSON"时又只剩一句 200 字以内的摘要）',
    file: 'llmAdapter',
    from: '        this.diagnosticsFor({ raw: content, elapsedMs, finishReason, usage }),',
    to: '        undefined,',
    pattern: '模型输出不是合法 JSON ⇒ 诊断里留着那段原始输出',
    test: 'tests/unit/summary-diagnostics.test.mjs',
  },
  {
    label: '端口没上报也写出分母（`3/0` 被读成"模型吐了 0 条"，而这两件事处置相反）',
    file: 'summaryDiagnostics',
    from: '  if (diagnostics.instrumented) {',
    to: '  if (true) {',
    pattern: '端口没上报时不写分母',
    test: 'tests/unit/summary-diagnostics.test.mjs',
  },
  {
    // issue #86 第 1 刀：省略号容忍是 2026-09-27 实验量出来的真实损失（10 条里丢 2 条 = 20%），
    // 而省略号是提示词自己教模型写的（字段示例里就写着「……」）。
    label: '引用带省略号就一律丢弃（白丢 20% 的产出，而那形状是本站在提示词里教的）',
    file: 'summaryContent',
    from: '  const segments = quoteSegments(quote).map(quoteFingerprint);',
    to: '  const segments = [quoteFingerprint(quote)];',
    pattern: '中间带中文省略号 ⇒ 命中（每一截都逐字）',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    label: '省略号切出来的短碎片也算数（「第一条…第二条」能蒙中任何公文，出处成了盖章）',
    file: 'summaryContent',
    from: '  if (segments.some((segment) => segment.length < MIN_VERIFIABLE_QUOTE_CHARS)) return null;',
    to: '  if (false) return null;',
    pattern: '有一截短于 8 字 ⇒ 不命中',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    label: '影响判读的出处不再反查（反查不到也照登，随便挂一份附件当出处）',
    file: 'summaryContent',
    from: '    const source = findDraftSourceForQuote(quote, sources);',
    to: '    const source = sources[0] ?? null;',
    pattern: '整条不落库，且计数',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // issue #47：门由谓词变**选择器**之后，这两条靶点跟着搬（#86 那两条钉的是"受众面在不在
    // 门里"与"空数组渲不渲染"，判据一个字没改，只是实现形状换了）。
    //
    // 这一条撤的是**过渡回落**那一行：受众面是否退出判读的渲染判据定在第 6 条（#52），
    // 本切片撤掉它 = 行业专业 / 未判定也把推断推给读者 —— 而那正是用户 2026-09-27
    // 拍板要挡的那一档（"先只上公众广域 + 人工过一遍"）。
    label: '判读的过渡回落被撤（非公众广域也把"可能的争议点"推给读者）',
    file: 'impactDisplay',
    from: "  if (input.audience !== 'public') return null;",
    to: '',
    pattern: '过渡回落',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // 撤掉"空则 null"（改成直接返回数组）= 页面上留下一个只有标题的空壳。
    // #85 的教训：一个写着标题、内容却空着的栏目，读者读到的是"这一栏没东西可看"。
    label: '影响判读一条都没有也渲染（页面上留下一个只有标题的空壳）',
    file: 'impactDisplay',
    from: '  return rendered.length > 0 ? rendered : null;',
    to: '  return rendered;',
    pattern: '一条判读都没有',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // issue #47 的两种读者可见投影，各钉一条（失效方式不同）：
    // 撤掉「已改」那一支 ⇒ 退回渲染**原文**，而"原文不出现"正是并存语义的全部意义；
    // 撤掉「剔除」那一行 ⇒ 被判负的那一条照旧推给读者（门形同虚设）。
    // pattern 都取那一条用例独有的词：撤掉之后只有它翻红，别的用例本来就不走这一支。
    label: '审读的「已改」被撤（退回渲染原文，"原文不出现"静默失效）',
    file: 'impactDisplay',
    from: "    if (review.status === 'revised') {",
    to: '    if (false) {',
    pattern: '已改',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    label: '审读的「剔除」被撤（被判负的判读照旧推给读者）',
    file: 'impactDisplay',
    from: "    if (review.status === 'rejected') continue;",
    to: '',
    pattern: '剔除',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // 决定 19 的那一行：两个指纹**都**全等才算这份记录属于这条判读。
    // 放宽成 `||` 的后果是"生成侧重跑改了 text 之后，旧结论照旧生效" ——
    // 页面上看不出来（那段文本确实存在过一份结论），而它护的正是这一整层。
    label: '审读记录按单个指纹配对（生成侧重跑后旧结论照旧生效）',
    file: 'impactReview',
    from: '    if (record.quoteFingerprint === quote && record.textFingerprint === text) return record;',
    to: '    if (record.quoteFingerprint === quote || record.textFingerprint === text) return record;',
    pattern: '指纹对不上',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // 硬约束 8（只减不加）的落地点：结论按**逐字回显的那一对 (quote, text)** 配对，
    // 而不是按位置/顺序。改成按下标取之后，一条"想换引用"的结论也会被采信 ——
    // 于是库里会出现一份挂在旧引用上的新结论，而读者读到的推断与它依据的原文对不上号。
    label: '审读结论按位置配对（想换引用的结论也被接受：只减不加失守）',
    file: 'impactReview',
    from: '    const verdict = byKey.get(impactReviewKey(impact.quote, impact.text));',
    to: '    const verdict = input.verdicts[records.length] ?? null;',
    pattern: '想换 quote',
    test: 'tests/unit/impact-review.test.mjs',
  },
  // ── 2026-10-02 两栏版式这一刀：摘要卡的段落顺序与「影响谁」的门控 ──────────────
  // 这三条里有两条的靶点在 `src/app/_lib/summary-view.tsx`（页面 .tsx）。为什么不配 e2e：
  // e2e 跑的是 `.next` 构建产物，撤 SSR 侧源码不会红（本脚本的规则 1）——
  // 所以判据钉在 `impact-display.ts`（另有用例），而**接线与删除**按**源码**钉
  // （与 `tests/unit/feed-intake-note.test.mjs` 同一手法）。
  {
    // 撤掉判据的实现（只剩一个恒真的出口）= 回到"公众广域也渲染「影响谁」"，
    // 而那正是实测出来"基本是标题复述"的那一段。
    //
    // pattern 为什么指**公众广域那条**（本轮实测踩到的坑，两次）：撤的是"受众面"这一半，
    // 而 `sector + 非空` 与 `sector + 空串` 两条**都不看受众面也照样绿** ——
    // 撤掉之后前者仍 true、后者仍 false（空串由最后那一行拦住），脚本于是报
    // "这条断言没钉住任何东西"。真正会翻红的是"不该渲染却渲染了"的那些：
    // public / unknown / null 各一条，取公众广域那条（它正是这个门控要挡的那一档）。
    label: '「影响谁」的门控被撤（公众广域条目又渲染一段标题复述）',
    file: 'impactDisplay',
    from: '  if (input.audience !== \'sector\') return false;',
    to: '  if (false) return false;',
    pattern: '公众广域 ⇒ 不渲染',
    test: 'tests/unit/who-display.test.mjs',
  },
  {
    // 撤掉渲染 = 判据还在、页面不再用它。这一条与上一条必须分开：判据对而页面没接上，
    // 是这一类改动最常见的断线，而它在 e2e 里看不见（构建产物照旧）。
    // 靶点取**那一行调用**，不是 `shouldRenderWho` 这个名字 —— 名字在头注与 import 里也有，
    // 撤一个名字等于什么都没撤（本脚本的规则 4：`from` 首次出现处必须就是要撤的那一处）。
    label: '页面不再用 shouldRenderWho 判「影响谁」（判据对、页面没接上）',
    file: 'summaryView',
    from: '        {shouldRenderWho({ audience: notice.audience, who: summary.who }) ? (',
    to: '        {true ? (',
    pattern: '页面真的用了 shouldRenderWho',
    test: 'tests/unit/who-display.test.mjs',
  },
  // ── 2026-10-02 收尾：这里原本有一条「「谁能提」那一段被加回去」的钉子 ────────────
  // 它随 `whoCanSubmit` **整体删除**一起失效了：那条 `to` 注入的
  // `section={summary.whoCanSubmit}` 指向已删字段，`pattern: '谁能提'` 也已经选不中任何
  // 用例名 —— 脚本会判"名字模式没匹配到任何测试"，pretest 直接 exit 1。
  // 按本仓库的口径（"留一条钉不住的 pin，下一轮就会以为它被验证过"）**删掉它**，
  // 活的守卫换成**形状那一侧**：下面这一条（把删掉的键塞回去必须变红）。
  {
    // 删东西的钉子长这样：**把删掉的那一行加回去，必须有人当场解释为什么**。
    // 靶点取 `parseQuotedSummary` 里 `who` 那一行：它在 `summary-content.ts` 里只出现
    // 一次（`buildQuotedSummary` 里那行写法不同），所以 `from` 的首次命中就是要撤的那处
    // （本脚本的规则 4）。`to` 里插回去的键让 `tsc` 报"多余属性"没关系 —— 本脚本只跑
    // `node --test`（类型剥离，不看类型）。
    label: '`whoCanSubmit` 被塞回落库形状（一个永不显示的字段又回来了）',
    file: 'summaryContent',
    from: '    who: optionalSection(record.who),',
    to: '    who: optionalSection(record.who),\n    whoCanSubmit: optionalSection(record.whoCanSubmit),',
    pattern: '摘要形状里不再有',
    test: 'tests/unit/who-display.test.mjs',
  },
  {
    label: '诊断不数影响判读的条数（"模型吐了几条判读"这件事又变得查不到）',
    file: 'summarize',
    from: '      impacts: quoted.impacts.length,',
    to: '          impacts: 0,',
    pattern: '诊断里数得出',
    test: 'tests/e2e/summary-genre-and-explanations.test.mjs',
  },
  {
    // issue #86 第 2 刀：这一条钉的是**与旧实现相反**的那处地基。旧实现的逐字反查池排除
    // 编制说明（`draftSide = filter(role !== 'explanation')`），而实测显示两类文件的对照句
    // 落在不同侧（法律修正草案在正文、住建部那批在说明）—— 只认一侧白丢一半。
    label: '改动点的反查池退回"只认条文侧"（依据写在编制说明里的那一半全被丢掉）',
    file: 'summaryContent',
    from: '  const changes = buildChanges(summary, draftSources ?? [], tally);',
    to: "  const changes = buildChanges(summary, (draftSources ?? []).filter((source) => source.role !== 'explanation'), tally);",
    pattern: '引用只在编制说明里命中',
    test: 'tests/unit/summary-changes.test.mjs',
  },
  {
    label: '改动点不再落库（模型吐了也丢掉，页面那一段永远是空的）',
    file: 'llmAdapter',
    from: '  const changes = normalizeChanges(record.changes, tally);',
    to: '  const changes = [];',
    // 靶点在**适配器的归一化**里，所以判据必须走单测：e2e 用的是 stub LLM，
    // 它直接返回 StructuredSummary、根本不经过 normalizeModelSummary ——
    // 指到 e2e 上就是一条"撤掉实现也不红"的假绿灯（本轮实测踩到，靠"必须真变红"当场抓出）。
    pattern: '超过 40 处',
    test: 'tests/unit/summary-changes.test.mjs',
  },
  {
    label: '覆盖度分母不落库（页面那行"检测到几处"永远说不出来）',
    file: 'summarize',
    from: '      changeMarkerCount,',
    to: '          null,',
    pattern: '覆盖度分母数的是全文',
    test: 'tests/e2e/summary-genre-and-explanations.test.mjs',
  },
  {
    label: '诊断不数改动点的条数（"模型吐了几处改动"这件事又变得查不到）',
    file: 'summarize',
    from: '      changes: quoted.changes.length,',
    to: '          changes: 0,',
    pattern: '诊断写下来了',
    test: 'tests/e2e/summary-genre-and-explanations.test.mjs',
  },
  {
    // 下面两条与 #85 搬到说明侧的那三条同构（列得少要照实说少 / 一个都没数到不许说成"全部"）：
    // 判据同构，两侧都要有。#85 删功能时把改动点那两条一起删了，这一轮按同一条规矩装回来。
    label: '改动覆盖度永远说"已列出全部"（窗口截掉的改动被藏起来）',
    file: 'changeCoverage',
    from: '  if (listed >= markers.total) {',
    to: '  if (true) {',
    pattern: '列得比数到的少 ⇒ 照实说少',
    test: 'tests/unit/summary-changes.test.mjs',
  },
  {
    label: '一处都数不到也写成"已列出全部 0 处"（把"本站没读到"说成一种结果）',
    file: 'changeCoverage',
    from: '  if (markers.total === 0) {',
    to: '  if (false) {',
    pattern: '一处在正文里也数不到 ⇒ 不说',
    test: 'tests/unit/summary-changes.test.mjs',
  },
  {
    // 2026-09-28：这句话原先**替差额认领了一个我们不知道的原因**（"其余的不在本站读到的那一截
    // 文本里"），而公路法那条实测里正文整份都在窗口内、同一输入四遍列出 8/2/3/8 行 —— 主因是
    // 模型没写。
    //
    // **2026-09-30 搬了家**：这一句随"读者侧接上 FeedReport"那一刀挪进了两处共用的
    // `coverageGapAttribution`（explanation-coverage.ts），于是靶点从 change-coverage.ts 换成
    // 那个"清单报过缺口吗"的判据 —— 它恒真，就等于又回到"把差额推给我们没读到的那一截"。
    label: '覆盖度又替差额认领原因（不管清单怎么说，都把差额推给"没喂进去的那一截"）',
    file: 'explanationCoverage',
    from: '  return starved.length > 0 || sources.some((item) => item.truncated);',
    to: '  return true;',
    pattern: '不许再提',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    // 同一条规矩的另一半（2026-09-30）：**没有喂入清单时要说"给不出可核对的答案"**，
    // 而不是退回去说一句读起来像交代、其实我们并不知道的话。存量 v1 行（生产里是多数）
    // 与人工录入摘要都走这一支。
    label: '没有喂入记录时又替差额认领原因（页面照常渲染，读者以为那是一句可核对的交代）',
    file: 'explanationCoverage',
    from: "    return '这条摘要没有留下本轮的喂入记录，差额出在哪一环本站给不出可核对的答案。';",
    to: "    return '其余的不在本站读到的那一截里';",
    pattern: '没有喂入清单',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    // 2026-09-30：清单**报了**截断却不说 —— 那就把"我们没读到"这一种可能藏了起来，
    // 而它是真的（这一支正是该说它的地方）。
    label: '被截了也不说（"我们没读到"这一种可能被藏起来）',
    file: 'explanationCoverage',
    from: '  const cut = sources.filter((item) => item.truncated).length;',
    to: '  const cut = 0;',
    pattern: '说清读到几份',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    // 2026-09-30：编制说明那一栏按 role 过滤，防的是"某份**条文**被截"被读成"说明被截"。
    label: '编制说明那一栏拿整次调用的数字说话（某份条文被截被读成说明被截）',
    file: 'explanationCoverage',
    from: '  if (role === undefined) return { sources: feed.sources, starved: feed.starved };',
    to: '  if (true) return { sources: feed.sources, starved: feed.starved };',
    pattern: '被截的是条文类附件',
    test: 'tests/unit/explanation-points.test.mjs',
  },
  {
    label: '详情页不把喂入清单传给摘要卡（读者侧又拿不到"这一轮喂了什么"）',
    file: 'noticePage',
    from: '            feedReport={feedReport}',
    to: '            feedReport={null}',
    pattern: '详情页读出 feed',
    test: 'tests/unit/feed-intake-note.test.mjs',
  },
  {
    // 页面是 `.tsx`：e2e 跑的是构建产物，撤源码不会红，所以这一条钉的是**接线**
    // （判据本身在 explanation-coverage.ts 里，由上面几条钉）。判据与接线分开钉，
    // 才不会出现"判据对、页面没接上"这种看不见的断线。
    label: '摘要卡把清单交给了改动那一栏、却没给编制说明那一栏（两栏说法又不一致）',
    file: 'summaryView',
    from: '                    feedReport,',
    to: '',
    pattern: '摘要卡把清单交给两处覆盖度判据',
    test: 'tests/unit/feed-intake-note.test.mjs',
  },
  {
    label: '摘要卡读了清单却不用（覆盖度那两句又退回"凭猜"）',
    file: 'summaryView',
    from: '                ? changeCoverageVerdict(changes.length, summary.changeMarkers, feedReport).detail',
    to: '                ? changeCoverageVerdict(changes.length, summary.changeMarkers).detail',
    pattern: '摘要卡把清单交给两处覆盖度判据',
    test: 'tests/unit/feed-intake-note.test.mjs',
  },
  {
    label: '仓储层不再查诊断那一列（读者侧永远只有"没有喂入记录"）',
    file: 'summariesRepo',
    from: '      summaryDiagnosticsJson: notices.summaryDiagnosticsJson,',
    to: '      summaryDiagnosticsJson: null,',
    pattern: '仓储层把诊断那一列查出来',
    test: 'tests/unit/feed-intake-note.test.mjs',
  },
  {
    label: '验收门不再从落库诊断取清单（门印的与读者看到的又不同源）',
    file: 'summaryGate',
    from: '  const feed = diagnostics?.feed ?? null;',
    to: '  const feed = null;',
    pattern: '验收门',
    test: 'tests/unit/feed-intake-note.test.mjs',
  },
  {
    label: '"缺说明的那几行"不再交代能归给谁（缺口又变得看不见）',
    file: 'changeCoverage',
    from: "  if (factOnly > 0) parts.push(coverageGapAttribution(feed, '改动字眼'));",
    to: '  // 撤掉实现：不交代缺说明的那几行能归给谁',
    pattern: '清单说有一份被截',
    test: 'tests/unit/change-table.test.mjs',
  },
  // 2026-09-30：点名补摘要那条通道（`scripts/summarize-now.mjs`）。它绕开两道门
  // （队列排除已截止条目、重跑工具拒绝已截止条目），所以它的**闸门本身**必须有钉子：
  // 撤掉之后的表现都不是崩溃，而是"悄悄地多写了一条生产摘要"。
  {
    label: '点名补摘要：落库时把摘要正文扔掉（退出码照样 0，库里多一行空壳）',
    file: 'summarize',
    from: '      summaryJson: JSON.stringify({ ...quoted, changeTable }),',
    to: '      summaryJson: JSON.stringify({}),',
    pattern: '的那条产出摘要',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  {
    label: '正文自带条文的条目不再当作一份来源（那两条已截止草案白跑一次调用）',
    file: 'summarize',
    from: "  if (!planned.some((item) => item.role !== 'explanation') && bodyLooksLikeDraft(bodyText)) {",
    to: '  if (false) {',
    pattern: '默认只读',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  {
    label: '点名的工具改成默认写库（"先看清会发生什么"这一步不再无害）',
    file: 'summarizeNow',
    from: "const apply = argv.includes('--apply');",
    to: 'const apply = true;',
    pattern: '默认只读',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  {
    label: '已有摘要不再默认拒绝（一次点名就盖掉可能经过人工复核的摘要）',
    file: 'summarizeNow',
    from: 'if (wouldOverwrite.length > 0 && !replace) {',
    to: 'if (false) {',
    pattern: '已有摘要的条目',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  {
    label: '覆盖前的备份行不带旧摘要（旧值再也找不回来）',
    file: 'summarizeNow',
    from: '        previousSummaryJson: raw.summaryJson,',
    to: '        previousSummaryJson: null,',
    pattern: '已有摘要的条目',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  {
    label: '缺省的调用上限不再生效（一次能点出任意多条境外调用）',
    file: 'summarizeNow',
    from: 'if (idArgs.length > limit) {',
    to: 'if (false) {',
    pattern: '缺省不让一次点超过 5 条',
    test: 'tests/e2e/summarize-now.test.mjs',
  },
  // 2026-09-30：引号字形归一（生产实测：附件原文是中文引号、模型某几遍吐 ASCII 直引号，
  // 词句逐字一致却整行被判"对不上" —— 那一遍 9 行全丢，页面上「改了哪几处」只剩事实行）。
  // 这是**放宽**一条核对口径，所以它比别的钉子更要紧：放松过头的表现是"编造的引用也能落库"，
  // 而反向那几条（改实词 / 少一段 / 短于 8 字 / 顺序颠倒）已经在单测里钉住了。
  {
    label: '引号字形不再归一（模型吐 ASCII 直引号 ⇒ 整行被判对不上；生产上那一遍 9 行全丢）',
    file: 'summaryContent',
    from: "  return stripQuoteWhitespace(normalizeQuoteMarks(text)).replace(/^[\"'“「『]|[\"'”」』]$/g, '');",
    to: "  return stripQuoteWhitespace(text).replace(/^[\"'“「『]|[\"'”」』]$/g, '');",
    pattern: '只差引号字形',
    test: 'tests/unit/summary-draft-points.test.mjs',
  },
  {
    // 归句那一侧必须与落库反查共用同一份口径：只有一边归一的话，表里的行会归不到它引用的
    // 那一句上，最后被挪到表尾 —— 读者看到的是"顺序莫名其妙"，看起来像模型写错了。
    label: '归句的 haystack 不归一引号字形（表里的行与它引用的原文对不上，被挪到表尾）',
    file: 'changeTable',
    from: '  const normalized = normalizeQuoteMarks(source);',
    to: '  const normalized = source;',
    pattern: '引用只差引号字形',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    // 2026-09-30：只报事实那一行的措辞。**它替文件下过一个我们没核过的结论** ——
    // 生产实测 58 处删除类命中里 48 处是条文里的动词（"采取删除、屏蔽…"）或对照表单元格
    // （"本标准 删除 删除"）。撤掉这一句，页面就会重新对读者说"这里检测到一处改动"。
    label: '只报事实那一行又写成"检测到这一处改动表述"（数到的是字眼，不是改动）',
    file: 'changeCoverage',
    from: '  return `本站在这一句里数到了${subject}，但没能给出可核对的说明`;',
    to: "  return '本站检测到这一处改动表述，但没能给出可核对的说明';",
    pattern: '数到的是字眼',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    // §20：逐处找出来的顺序是**按位置**的，探针与（将来的）按条目列表都靠它把"处"归到句上。
    // 撤掉排序，返回的就成了"按正则表的顺序"（add 在 delete 前面），而每处的字面都对 ——
    // 于是谁都没注意到这份清单已经不是正文顺序了。
    label: '逐处找出的改动表述不按正文顺序（按处归句会错位）',
    file: 'changeCoverage',
    from: '  return found.sort((a, b) => a.index - b.index);',
    to: '  return found;',
    pattern: '逐处找出来的位置与字面',
    test: 'tests/unit/summary-changes.test.mjs',
  },
  {
    // issue #86 第 3 刀：档位判反了就是"每一个没归好类的条目都按重档跑一遍" ——
    // 花钱、变慢，而且不会有任何报错。判据就是那条 fail-safe 本尊。
    label: '受众面判不出来也走重档（未判定 ⇒ 每次调用都加倍）',
    file: 'attachmentFeed',
    from: "  return audience === 'public' ? 'deep' : 'standard';",
    to: "  return audience !== 'sector' ? 'deep' : 'standard';",
    pattern: '判不出来就当标准档',
    test: 'tests/unit/attachment-feed.test.mjs',
  },
  {
    label: '保底份额取消（装不下时最后那一份又只剩几百字）',
    file: 'attachmentFeed',
    from: '  const reserve = rest.reduce((sum, cjk) => sum + Math.min(state.budget.minShare, cjk), 0);',
    to: '  const reserve = 0;',
    pattern: '最后一份仍然拿得到保底',
    test: 'tests/unit/attachment-feed.test.mjs',
  },
  {
    label: '"全都装得下"永远判成装不下（明明吃得下也要按保底切一刀）',
    file: 'attachmentFeed',
    from: '  return windowCjk.reduce((sum, cjk) => sum + cjk, 0) <= total;',
    to: '  return false;',
    pattern: '全都装得下',
    test: 'tests/unit/attachment-feed.test.mjs',
  },
  {
    // 靶点在 worker 组装输入的那一行，判据在跨进程的 e2e（stub 的调用日志里记着档位）——
    // 两处在同一条执行路径上：撤掉这一行，端口收到的就是标准档。
    label: '档位不传给端口（重档的预算被适配器的标准档上限静默切掉）',
    file: 'summarize',
    from: '    tier,',
    to: "    tier: 'standard',",
    pattern: '档位真的传到了端口',
    test: 'tests/e2e/summary-feed-tier.test.mjs',
  },
  {
    label: '喂入清单不落库（"模型没读到"与"我们没喂"又变得分不出来）',
    file: 'summarize',
    from: '      feed: feedReport,',
    to: '          feed: undefined,',
    pattern: '公众广域走重档',
    test: 'tests/e2e/summary-feed-tier.test.mjs',
  },
  {
    label: '两段正文的上限不随档位（重档喂到 16,000 字符，被标准档的 10,000 切掉尾巴）',
    file: 'llmAdapter',
    from: '    explanationBlock(input.draftSources, budget.explanationBlockChars),',
    to: '    explanationBlock(input.draftSources),',
    pattern: '重档放得下那份 20,000 字符的说明',
    test: 'tests/unit/summary-draft-points.test.mjs',
  },
  {
    label: '一句话摘要不再说档位与喂入量（后台与日志里看不出这条走了哪一档）',
    file: 'summaryDiagnostics',
    from: '  if (feed) {',
    to: '  if (false) {',
    pattern: '一句话摘要里说得出档位',
    test: 'tests/unit/summary-diagnostics.test.mjs',
  },
  {
    // issue #86 第十四节：「…法（征求意见稿）」里的法多半是**方法**（色谱法/测定法/分析法）。
    // 放宽回"征求意见稿"就等于让每一份方法标准冒充立法 —— 而受众面现在决定喂入档位与成本。
    label: '方法是立法：法（征求意见稿）又算法律草案（方法标准被按重档白跑一遍）',
    file: 'audience',
    from: '(?<![办方做想用说合])法\\s*[（(][^）)]{0,20}草案|',
    to: '(?<![办方做想用说合])法\\s*[（(][^）)]{0,20}(草案|征求意见稿)|',
    pattern: '里的法多半是',
    test: 'tests/unit/audience.test.mjs',
  },
  {
    // 提示词（issue #86 第十四节）：删掉这一句，模型就会继续"挂着一句正确原文、说一句
    // 放之四海皆准的话"（2026-09-27 实测的真实产出）。stub 的测试路径不经过提示词，
    // 所以这两条只能配单测 —— 靶点与判据都在同一份文件上。
    label: '判读的引用不必是依据（套话判读重新合法）',
    file: 'llmAdapter',
    from: '**quote 必须是这条结论的依据**',
    to: '**quote 随便**',
    pattern: '引用必须是',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    label: '判读只看一个方向（"可能被滥用 / 执行不到"那一类不再被要求去找）',
    file: 'llmAdapter',
    from: '找的时候**两个方向都要看**',
    to: '找的时候**随便看看**',
    pattern: '两个方向都要找',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // issue #86 第十六节：门槛塌了之后，公告壳（220 字符、0 处条号）也会被当成"正文就是条文"，
    // 而那正是 #55/#56 花了两轮才关掉的那类编造（从壳里概括条文）。
    label: '公告壳也算"正文就是条文"（又回到从壳里概括条文）',
    file: 'attachmentFeed',
    from: '  return text.length >= BODY_DRAFT_MIN_CHARS && countArticleAnchors(text) >= BODY_DRAFT_MIN_ANCHORS;',
    to: '  return text.length >= 0 && countArticleAnchors(text) >= 0;',
    pattern: '公告壳不是条文',
    test: 'tests/unit/attachment-feed.test.mjs',
  },
  {
    label: '"正文就是条文"那一档被附件分支吃掉（页面一边说没有随文附件一边印着条文要点）',
    file: 'summaryDisplay',
    from: "  if (report.bodyDraft === true) return { kind: 'body-draft', files: report.total };",
    to: "  if (false) return { kind: 'body-draft', files: report.total };",
    pattern: '条文就在本页正文里',
    test: 'tests/unit/summary-display.test.mjs',
  },
  {
    label: '出处行把"本页正文"写成附件（读者会去找一份不存在的附件）',
    file: 'summaryDisplay',
    from: '  return source === BODY_DRAFT_LABEL',
    to: '  return false',
    pattern: '出处那一行按来路分开写',
    test: 'tests/unit/summary-display.test.mjs',
  },
  {
    // issue #86 第十八节。撤掉这一行 = 开关关着也去问 /fjxx/ 并声明附件，
    // 而后果是"每轮多打几十 MB 的请求"——**恰恰是**"部署"与"开始拉文件"要分开的那件事。
    label: 'npc 草案电子文档：开关关着也照样声明（部署即开始拉文件）',
    file: 'npcAdapter',
    from: '    if (!npcDraftAttachmentsEnabled()) return null;',
    to: '    if (false) return null;',
    pattern: '缺省关：一个请求都不发',
    test: 'tests/unit/npc-draft-attachments.test.mjs',
  },
  {
    // 撤掉文件名判据 = 接口给个空名字也照样声明，页面的「出处」那一行会出现一个空书名号，
    // 或者一个从标题猜出来的名字（#14 当初拒绝的正是这个）。
    label: 'npc 草案电子文档：没有文件名也照样声明（页面上出现猜出来的出处）',
    file: 'npcAdapter',
    from: '    if (name.length === 0) return [];',
    to: '    if (false) return [];',
    pattern: '没有文件名',
    test: 'tests/unit/npc-draft-attachments.test.mjs',
  },
  {
    // 按源预算塌回全局：那份 41 MB 的草案会以 too_large 收场，而页面上看不出区别
    // （附件照旧列出，只是我们从来没读过它）。
    label: 'npc 草案电子文档：附件上限塌回全站值（41 MB 那份永远读不到）',
    file: 'attachmentBudget',
    from: '    maxBytes: declared?.maxBytes ?? input.globalMaxBytes,',
    to: '    maxBytes: input.globalMaxBytes,',
    pattern: '41 MB 草案',
    test: 'tests/unit/attachment-budget.test.mjs',
  },
  {
    label: 'npc 草案电子文档：下载超时不按源放宽（41 MB 会在 15 秒上被掐断，像"文件坏了"）',
    file: 'attachmentBudget',
    from: '    timeoutMs: declared?.timeoutMs ?? input.globalTimeoutMs,',
    to: '    timeoutMs: input.globalTimeoutMs,',
    pattern: '两条预算成对出现',
    test: 'tests/unit/attachment-budget.test.mjs',
  },
  {
    // 抽取任务真的用了按源预算（而不是解析出来放着不用）。靶点是**下载那一处**，不是上面
    // 那句"声明大小超限"的判断 —— 后者在 e2e 里够不着：fixture 源站是 chunked、没有
    // content-length，`declaredTotalBytes` 返回 null，那条分支根本不执行。**2026-09-28
    // 实测踩到**：第一版就钉在那里，撤掉实现**照样绿**（假绿灯），真正被证伪的是"这条断言
    // 钉住了按源上限"这个说法本身。这一版把**全站**上限收到 4 KB（夹具 133 KB）：
    // 撤掉按源取值，正文会被截成 4 KB，解析必然落 error / no_draft_text ⇒ 断言当场红。
    label: '抽取任务不按源取上限（解析出来的预算没人用）',
    file: 'extract',
    from: '    body = await readCappedBuffer(full, budget.maxBytes);',
    to: '    body = await readCappedBuffer(full, MAX_BYTES);',
    pattern: '抽取任务把那份 PDF 下下来',
    test: 'tests/e2e/npc-draft-attachments.test.mjs',
  },
  {
    // 附件清单那一跳失败时沿用已入库的清单。撤掉它，`syncAttachmentManifest` 会把行删掉
    // （连带抽出来的条文正文），于是"源站今天抖了一下"变成"这份草案我们从来没读过"。
    // 按 describe 名匹配（三个 describe 共用前缀），让三轮单轮运行按顺序跑完。
    label: '附件清单取不到就把已抽到的条文清掉（一次抖动 = 这份草案白读了）',
    file: 'crawl',
    from: '            enriched.detailLoaded && !enriched.attachmentListFailed',
    to: '            enriched.detailLoaded,',
    pattern: 'npc 草案电子文档',
    test: 'tests/e2e/npc-draft-attachments.test.mjs',
  },
  {
    // 2026-09-28 生产验收门量出来的第一号毛病：9 条判读里 2–3 条是"复述罚则"
    // （引用一句罚则/禁令，text 写「可能面临处罚 / 可能被查处」）。撤掉这条判据，
    // 提示词就退回"挂一句正确原文 + 说一句放之四海皆准的话"，而**页面照常渲染** ——
    // 读者看到的是看着像判读、其实什么也没说的句子。
    label: '复述条文也算影响（提示词里那条反问被删掉）',
    file: 'llmAdapter',
    from: '   - **复述条文不是影响**（2026-09-28',
    to: '   - **复述条文也算影响**（2026-09-28',
    pattern: '复述条文不算影响',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  // issue #86 第二十节第 3 小节：那张表**行由程序定**。这一族改动全都有一个共同点 ——
  // 撤掉之后页面照常渲染、日志一个字不报，只是表又退回"只有模型写出来的行"，
  // 而那种缺**读者看不出来**（这正是要改它的原因）。所以下面五条一条都不能少。
  {
    label: '缺口不落库（模型没写说明的那几句从表里消失，读者看不出少了）',
    file: 'changeTable',
    from: "        type: 'fact',",
    to: "        type: 'described',",
    pattern: '每一句一行',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    label: '标题句也印成一行（把分母里混着的那个小标题摆到读者面前）',
    file: 'changeTable',
    from: '    if (isHeaderSentence(sentence, [nextInDocument, nextWithMarkers])) {',
    to: '    if (false) {',
    pattern: '每一句一行',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    label: '归句退化回"取它起始的那一句"（附件里一换行，那一行说明就被挪到表尾）',
    file: 'changeTable',
    from: '    return withMarkers.length > 0 ? withMarkers[0] : touched[0];',
    to: '    return touched[0];',
    pattern: '换行压成一行',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    label: '表尾不再兜底未归属的行（一行说明可以整个从页面上消失）',
    file: 'changeTable',
    from: '    if (!used.has(index)) entries.push({ type: \'described\', change: index });',
    to: '    if (false) entries.push({ type: \'described\', change: index });',
    pattern: '一行都不许丢',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    label: '没有表的老行不再退回旧形状（存量摘要那一段会变成空白）',
    file: 'changeTable',
    from: '  if (table !== null && table.entries.length > 0) return table.entries;',
    to: '  if (true) return table?.entries ?? [];',
    pattern: '没有表就走旧形状',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    label: '表不落库（页面永远拿不到"行由程序定"，这一版改动等于没做）',
    file: 'summarize',
    from: '      summaryJson: JSON.stringify({ ...quoted, changeTable }),',
    to: '          summaryJson: JSON.stringify(quoted),',
    pattern: '改动表连同',
    test: 'tests/e2e/summary-genre-and-explanations.test.mjs',
  },
  {
    label: '读侧不再解析这张表（落库了也读不回来，页面照旧只列模型写出的行）',
    file: 'summaryContent',
    from: '  if (!Array.isArray(raw.entries)) return null;',
    to: '  if (true) return null;',
    pattern: 'build → parse 等价',
    test: 'tests/unit/change-table.test.mjs',
  },
  {
    label: '那句交代不再提"有几行只报事实"（缺说明这件事又变得看不见）',
    file: 'changeCoverage',
    from: '    return { rows, factOnly, detail: \'附件正文里没有数到成文的修改表述，这一栏给不出「共几处」\' };',
    to: '    return { rows, factOnly, detail: `已列出全部 ${rows} 行` };',
    pattern: '数不到改动表述',
    test: 'tests/unit/change-table.test.mjs',
  },
  // ── 2026-10-02 第二刀「影响点」三件（issue #88 第七节 7.5 / 7.6）──────────────
  // 这一刀加的每一件都属于"撤掉之后页面上少一句话、而没有任何东西会报错"：
  // 概览行少一支判空 ⇒ 多印一行光秃秃的「影响：」；impactLine 丢了 point 的拼接 ⇒
  // 新加的"方面"整半句静默消失；解析层把 point 当必填 ⇒ 存量 39 条判读一起消失；
  // 提示词删掉 point 的约束 ⇒ 下一轮生成全都不守 12 字，而 stub 路径根本不经过提示词。
  // 两条接线（页面 .tsx）另配源码断言：e2e 跑的是 `.next` 构建产物，撤源码不红（规则 1）。
  {
    // 靶点：`whoLine` 的判空那一支（`topWho.length === 0 ? null : …`）。
    // 撤掉它 ⇒ 一条主体都没写出来时也印一行「影响：」—— 那是空壳，不是信息。
    // 取这个片段的第一处出现是安全的：`countsLine` 判的是 `impacts.length === 0`，
    // 与它不是同一个表达式（本脚本规则 4）。
    //
    // pattern 为什么指**全部 who 为空**那条：撤掉判空之后，"有主体"的那些用例照样绿
    // （它们本来就不走这一支），只有"一条主体都写不出来"的那条会翻红。
    label: '概览的主体行不再判空（一条主体都没写出来也印一行「影响：」）',
    file: 'impactDisplay',
    from: '      topWho.length === 0',
    to: '      false',
    pattern: '全部 who 为空',
    test: 'tests/unit/impact-overview.test.mjs',
  },
  {
    // 靶点：`impactLine` 里把 point 拼进去的那一行。撤掉它 ⇒ 退回"只显示 who"，
    // 而这一刀新加的正是"方面" —— 页面上看不出少了什么（那一行本来就有内容）。
    //
    // pattern 指**两半都有**那条：只有 point / 都空那几条在撤掉后照样绿（它们不走这一支）。
    label: '每条的「影响」行不再拼 point（新加的"方面"整半句静默消失）',
    file: 'impactDisplay',
    from: 'return `影响：${who} · ${point}`;',
    to: 'return `影响：${who}`;',
    pattern: '两半都有',
    test: 'tests/unit/impact-overview.test.mjs',
  },
  {
    // 靶点：解析影响判读时那一行 `const impact = item as Record<string, unknown>;`
    // （本文件里只此一处）。在它后面插一句"point 必须是字符串"= 把可缺的键变成必填。
    //
    // 为什么不直接撤 `point:` 那一行：`buildImpacts` 与 `parseStoredImpacts` 里那两行
    // **逐字相同**，而 `String#replace` 只换第一处 —— 撤到的是 buildImpacts 那一份，
    // 用例照样绿（规则 4 的坑）。所以靶点取它上一行那个唯一的锚点。
    label: '解析层把 point 当必填（旧行没有这个键就整条判读丢掉，存量 39 条一起消失）',
    file: 'summaryContent',
    from: '    const impact = item as Record<string, unknown>;',
    to: '    const impact = item as Record<string, unknown>;\n    if (typeof impact.point !== \'string\') continue;',
    pattern: '旧行没有 point 键',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // 靶点：要求里 point 那一条 bullet 的**实质约束**（12 字上限、是"方面"不是主体）。
    // 撤掉它 ⇒ 提示词只剩字段示例里那句"这个字段放什么"，而"不许怎么写"没了 ——
    // 模型守不守长度再没有判据，而 stub 路径不经过提示词，没有任何别的门看得见。
    //
    // pattern 指**要求那一条**：字段示例（那一行 JSON）里也有"12 字以内"，
    // 所以判据按"要求那一段的 bullet"取（测试里也是这么写的），否则撤了也不红。
    label: '提示词里 point 的实质约束被删（下一轮生成不守 12 字，测试路径根本看不见）',
    file: 'llmAdapter',
    from: '；**12 字以内**、一个名词短语，不写句子、不写主体、不把 who 换个说法再写一遍；',
    to: '；一个名词短语就行；',
    pattern: 'point 的要求里写着 12 字上限',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  {
    // 接线：判据对而页面没接上，是这一类改动最常见的断线，而它在 e2e 里看不见
    // （详情页 `.tsx` 跑的是 `.next` 构建产物，撤源码不重建、页面照旧）。
    // 靶点取**那一行调用**，不是 `impactLine` 这个名字 —— 名字在 import 与注释里也有，
    // 撤一个名字等于什么都没撤（规则 4）。
    label: '页面不再用 impactLine（每条判读那一行退回页面自己拼）',
    file: 'summaryView',
    from: 'const line = impactLine(impact);',
    to: 'const line = impact.who ? `影响：${impact.who}` : null;',
    pattern: '页面真的用了 impactLine 与 impactOverview',
    test: 'tests/unit/who-display.test.mjs',
  },
  {
    // 同上，第二处接线：块首概览那两行**没有模型兜底**，页面里算错就是错的。
    label: '页面不再用 impactOverview（块首概览退回页面自己算）',
    file: 'summaryView',
    from: 'const overview = impactOverview(impacts);',
    to: 'const overview = { countsLine: null, whoLine: null };',
    pattern: '页面真的用了 impactLine 与 impactOverview',
    test: 'tests/unit/who-display.test.mjs',
  },
  {
    // issue #47：详情页不再经由**门**取判读（直接读 `summary.impacts`）⇒ 审读层被整层绕开，
    // 页面与列表又会各说各话。e2e 跑的是构建产物、撤 SSR 侧源码不红，所以由
    // `tests/unit/summary-impacts.test.mjs` 的接线组按源码钉（与上面两条同一手法）。
    label: '详情页不再经由渲染门取判读（审读层被整层绕开）',
    file: 'summaryView',
    from: '  const impacts = impactsToRender({',
    to: '  const impacts = summary.impacts;',
    pattern: '详情页经同一道门取判读',
    test: 'tests/unit/summary-impacts.test.mjs',
  },
  // ── 2026-10-02 收尾：概览的主体索引 + 两处版式宽度 + 列表页两栏 ──────────────
  {
    // 概览把主体用顿号连成一行，而旧行的 `who` 自己就带顿号（契约之前产的）：线上
    // `0b00deff17dfa050` 那条 6 个主体就读成一句没有边界的长句。判据是**顿号＝枚举，
    // 一串枚举不是一个主体类别**，不进索引（每条判读自己那行照旧完整显示，「等 N 类」照实数）。
    // 两条分开钉，因为失效方式不同：少筛是"又连写"，少报是"等 N 类数少了"（缺口看不见）。
    label: '概览不再筛掉带顿号的主体（旧行又连成一句没有边界的长句）',
    file: 'impactDisplay',
    from: "  const listable = whoAll.filter((who) => !who.includes('、'));",
    to: '  const listable = whoAll;',
    pattern: '带顿号的主体不进 topWho',
    test: 'tests/unit/impact-overview.test.mjs',
  },
  {
    label: '概览的「等 N 类」少报（被筛掉的主体既没列出来、也不计数）',
    file: 'impactDisplay',
    from: '  const whoOverflow = whoAll.length - topWho.length;',
    to: '  const whoOverflow = listable.length - topWho.length;',
    pattern: '带顿号的主体不进 topWho',
    test: 'tests/unit/impact-overview.test.mjs',
  },
  {
    // 容器宽度：写死 px 就回到"视口跨过 1000px 时从 760 一步跳到 952"。
    // 靶子是 CSS，而断言在 `tests/e2e/detail-layout.test.mjs` 里 —— 那条用例用
    // `readSource()` **直读源码文件**（该文件头的原话：断点这类东西没有浏览器就断言不了），
    // 所以撤源码能让它变红，不算破"e2e 跑构建产物"那条规则。
    label: '详情页容器宽度退回写死的 px（断点处又开始跳一次）',
    file: 'pageCss',
    from: '  max-width: min(1120px, max(760px, 100vw - 48px));',
    to: '  max-width: 1120px;',
    pattern: '窄屏保持 760px 居中',
    test: 'tests/e2e/detail-layout.test.mjs',
  },
  {
    label: '列表页容器宽度退回写死的 px（断点处跳变回归）',
    file: 'pageCss',
    from: '.page:has(.list-page) { max-width: min(1120px, max(760px, 100vw - 48px)); }',
    to: '.page:has(.list-page) { max-width: 1120px; }',
    pattern: '容器宽度是连续式',
    test: 'tests/e2e/list-layout.test.mjs',
  },
  {
    // 第一版靠栅格自动放置，结果**筛选条占掉主栏、列表被塞进 320px 的右栏** ——
    // 与详情页那一刀同族：结构看着对、渲染出来是错的，而 e2e 没有浏览器照样看不出来。
    // 要的方向是"列表在左、筛选在右"，与 DOM 顺序相反 ⇒ 列位只能写死。
    label: '列表页的列位退回「靠自动放置」（列表被塞进 320px 的右栏）',
    file: 'pageCss',
    from: '  .page:has(.list-page) .list-layout > .filter-bar { grid-column: 2; grid-row: 1; }',
    to: '  .page:has(.list-page) .list-layout > .filter-bar { grid-column: auto; grid-row: 1; }',
    pattern: '宽屏的列位写死了',
    test: 'tests/e2e/list-layout.test.mjs',
  },
  {
    label: '列表页的主栏不再显式落在第 1 列（同上，另一头）',
    file: 'pageCss',
    from: '  .page:has(.list-page) .list-main { grid-column: 1; grid-row: 1; }',
    to: '  .page:has(.list-page) .list-main { grid-column: 2; grid-row: 1; }',
    pattern: '宽屏的列位写死了',
    test: 'tests/e2e/list-layout.test.mjs',
  },
  // ── 2026-10-03：列表页「这条里有什么」的标记（issue #87）──────────────────────
  {
    // 这一条是整刀的风险所在：生产库里有一批 `sector` 条目**存着判读但详情页一个字都不渲染**
    // （受众面门控）。列表页若照库里的数组打标记，读者点进去会发现什么都没有 ——
    // 列表在承诺详情页不存在的东西，那比没有标记坏得多。所以靶点就是那道门本身。
    // issue #47 起门多了**审读**这一维：审读剔除掉唯一一条之后，同样的缺口会以新形状出现
    // （列表按库里的数组打标、详情页已剔除），而靶点仍然是这一次调用。
    label: '列表标记不再经由渲染门（列表承诺详情页不存在的东西）',
    file: 'noticeMarks',
    from: '  if (impactsToRender({ audience, impacts, reviews }) !== null) {',
    to: '  if (impacts.length > 0) {',
    pattern: '行业专业',
    test: 'tests/unit/notice-marks.test.mjs',
  },
  {
    // 失效方式不同（不是"多打标"而是"少打标"）：`changeTable` 是 worker 在 `changes` 定下
    // 之后**补写**的，历史行可能只有一半 —— 收缩成 `&&` 就会漏掉那些行，而且与详情页那个
    // 提前返回（`changes.length === 0 && table === null`）不再逐字对齐。
    label: '改动对照的判据收缩成"两半都要有"（只有一半的历史行漏掉标记）',
    file: 'noticeMarks',
    from: '  const hasChanges = changes.length > 0 || table !== null;',
    to: '  const hasChanges = changes.length > 0 && table !== null;',
    pattern: '改动对照：',
    test: 'tests/unit/notice-marks.test.mjs',
  },
  {
    // 接线：判据对了、组件没接上 —— 这一类改动最常见的断线，而它在 e2e 里**看不见**
    // （e2e 跑 `.next` 构建产物）。所以由单测那一组按**源码**钉，这里撤的是接线本身。
    // issue #47 之后这一处多了一维输入（审读记录）：不喂的话，列表会按"库里存着判读"打标，
    // 而详情页可能已经把那条剔除了 —— 正是这条接线要挡的事。
    label: '组件不再把摘要与审读记录喂给 noticeMarks（判据对、页面没接上）',
    file: 'noticeItem',
    from: '        reviews: notice.impactReviews,',
    to: '        // 撤掉实现：不喂审读记录',
    pattern: '组件真的用了 noticeMarks',
    test: 'tests/unit/notice-marks.test.mjs',
  },
];

let red = 0;
const problems = [];

/**
 * 正在被改写、尚未还原的文件。
 *
 * 这个脚本会**动工作区里的源码**，所以"崩了要把源码放回去"不是可选项：
 * 2026-09-24 就出现过一次——Windows 上写回时撞上 `EBUSY`（子进程还持着文件句柄），
 * 异常直接掀掉整个循环，工作区里留下一处"撤掉实现"后的假代码。
 * 那种状态如果被顺手 commit 掉，就是把一个已知缺陷提交进主干，而测试全绿。
 */
let pending = null;

/**
 * 强杀留痕与自愈。
 *
 * 为什么 `process.on('exit')` 不够：Windows 上终止进程走 TerminateProcess，退出钩子
 * 一个都不会跑（2026-09-24 实测：这个脚本被中途终止，工作区留下 `registered: true`
 * 的假实现）。留痕文件在改写源码**之前**落盘，还原成功后删掉；下次启动若看到残留，
 * 说明上一次是异常结束。
 *
 * 还原条件刻意收紧成「当前内容与当时写入的假代码逐字节相同」：中途文件又被改过
 * （人工编辑、切分支）时**不动它**，只报出来让人核对 —— 自动写回一份过期原文，
 * 会把别人的改动一起抹掉，那比留一处假代码严重。
 */
const INFLIGHT_FILE = '.pins-inflight.json';

function saveInflight(record) {
  writeFileSync(INFLIGHT_FILE, JSON.stringify(record));
}

function clearInflight() {
  rmSync(INFLIGHT_FILE, { force: true });
}

function recoverInflight() {
  let record = null;
  try {
    record = JSON.parse(readFileSync(INFLIGHT_FILE, 'utf8'));
  } catch {
    return; // 没有留痕：上一次正常结束
  }
  const current = readFileSync(record.file, 'utf8');
  if (current === record.original) {
    console.log(`（上次运行异常结束，但 ${record.file} 已是原样，无需还原）`);
  } else if (current === record.mutated) {
    writeFileSync(record.file, record.original);
    console.log(
      `!! 上次运行在「${record.label}」被强杀，工作区留着撤掉实现后的假代码 —— 已还原 ${record.file}`,
    );
  } else {
    console.error(
      `!! 上次运行在「${record.label}」被强杀，而 ${record.file} 之后又被改过，` +
        `不敢自动还原。请人工核对这一处：git diff ${record.file}`,
    );
    process.exitCode = 1;
  }
  clearInflight();
}

function restorePending() {
  if (pending === null) return;
  const { file, original } = pending;
  pending = null;
  if (readFileSync(file, 'utf8') === original) {
    clearInflight();
    return;
  }
  // EBUSY / EMFILE 在这台机器上是瞬时的：等一下再写就好
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      writeFileSync(file, original);
      if (readFileSync(file, 'utf8') === original) {
        clearInflight();
        return;
      }
    } catch {
      // 交给下一次重试
    }
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)),
      0,
      0,
      attempt * 250,
    );
  }
  console.error(
    `\n!! 无法还原 ${file}（多次写回都失败）。工作区现在留着"撤掉实现"后的假代码，`
    + '先执行 `git checkout -- ' + file + '` 再继续，别把这个状态提交掉。',
  );
  process.exitCode = 1;
}

process.on('exit', restorePending);

recoverInflight();

// 只做崩溃自愈那一步就退出（给 tests/unit/pins-self-heal.test.mjs 用：它要的正是
// 「上一次被强杀之后」这个状态，跑完整用例既慢又会真的改写工作区源码）
if (process.argv.includes('--recover-only')) process.exit(process.exitCode ?? 0);

/**
 * `--only <子串>`：只跑 label 里含这个子串的用例。
 *
 * 加它的理由是本刀自己的教训：第一次跑它时外层只给了 120s，而全套**实测约 120 秒**
 * —— 超时正好卡在边界上，于是它被杀在半路，工作区留下假代码（issue #77）。
 * 有了这条，改判据时只跑自己那几条，不必每次赌整轮跑得完
 * （`scripts/check-pins-clean.mjs` 只能事后拦，拦不住白跑的那一轮）。
 *
 * 说清它的分量：全套**只有约两分钟**，所以它的价值不在"省很多时间"，而在"不必赌整轮"。
 * 它不改判据、也不改执行方式（仍然串行、仍然逐条还原），只是少跑几条 ——
 * **所以它不能替代全套**：报出来的永远是"这几条成立"，不是"N/N 全绿"。
 */
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt < 0 ? null : (process.argv[onlyAt + 1] ?? '');
if (onlyAt >= 0 && (only === '' || only.startsWith('--'))) {
  console.error('--only 后面要跟一个用来筛选用例的子串，例如：--only 竖线');
  process.exit(2);
}
const selected = only === null ? CASES : CASES.filter((c) => c.label.includes(only));
if (selected.length === 0) {
  console.error(`--only ${only} 没有匹配到任何用例（label 是逐条比对的，换个更短的子串试试）`);
  process.exit(2);
}
if (only !== null) console.log(`[--only ${only}] 只跑 ${selected.length}/${CASES.length} 条\n`);

for (const testCase of selected) {
  const file = TARGETS[testCase.file];
  const original = readFileSync(file, 'utf8');
  if (!original.includes(testCase.from)) {
    problems.push(`${testCase.label} —— 源码里找不到要撤的那段，用例已过期（改了实现要同步改这里）`);
    console.log(`?? ${problems[problems.length - 1]}`);
    continue;
  }
  const mutated = original.replace(testCase.from, testCase.to);
  saveInflight({ label: testCase.label, file, original, mutated });
  writeFileSync(file, mutated);
  pending = { file, original };
  let out = '';
  try {
    const run = spawnSync(
      process.execPath,
      ['--test', '--test-name-pattern', testCase.pattern, testCase.test],
      { encoding: 'utf8', timeout: 300_000 },
    );
    out = `${run.stdout}\n${run.stderr}`;
    if (run.error) throw run.error;
  } catch (error) {
    problems.push(`${testCase.label} —— 跑测试时出错：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    restorePending();
  }

  /**
   * 判据：**有没有一条"非文件路径"的用例结果行**。
   *
   * 这一条是 2026-09-27（issue #86 第 0 刀）实测补上的，两版错判据都踩过：
   * - `ℹ tests ≥ 1`（原判据）**恒真**：名字模式一条都没选中时，Node 会把**测试文件本身**
   *   当成一条通过的用例打出来（`✔ tests\unit\xx.test.mjs (141ms)`）且 `ℹ tests` 仍是 1
   *   ⇒ "模式写错了"被读成"撤掉实现后仍然通过"，报出来的是一条**假绿灯**。当天就抓到一条
   *   真的（我的 pattern 里 `计数 +1` 的 `+` 被当正则量词，0 条用例被选中）。
   * - `ℹ suites ≥ 1`（我当时的第一版修法）**会误报**：全仓 e2e 里有整个文件都是顶层
   *   `test()` 的（`migrations-integrity.test.mjs` 七个用例全顶层），它们配对成功时
   *   `ℹ suites` 就是 0 ⇒ 把两条**活着**的用例报成"空的"。同一天第二次踩到，这次是假警。
   * 真正的区别在结果行的**名字**：没选中时那唯一一行就是文件路径本身。
   */
  const realResults = out
    .split('\n')
    .filter((line) => /^\s*[✔✖]\s/.test(line))
    .filter((line) => !/^\s*[✔✖]\s+\S*\.mjs\s*\(/.test(line));
  const fileLevelFailure = /^\s*✖\s+\S*\.mjs\s*\(/m.test(out);
  if (fileLevelFailure) {
    problems.push(
      `${testCase.label} —— 撤掉实现后测试文件本身跑不起来（多半是撤出了语法错误），这条用例不成立`,
    );
  } else if (realResults.length === 0) {
    problems.push(
      `${testCase.label} —— 名字模式没匹配到任何测试（只跑到了测试文件本身），这条用例本身是空的`,
    );
  } else if (/\nℹ fail ([1-9]\d*)/.test(out)) {
    red += 1;
    console.log(`红 ✓ ${testCase.label}`);
  } else {
    problems.push(`${testCase.label} —— 撤掉实现后测试仍然通过，这条断言没钉住任何东西`);
  }
}

console.log(
  only === null
    ? `\n撤掉实现后变红 ${red}/${CASES.length}`
    : `\n撤掉实现后变红 ${red}/${selected.length}（--only 子集，**不是**全套的 ${CASES.length} 条）`,
);
if (problems.length > 0) {
  console.log(`有问题 ${problems.length} 条：`);
  for (const problem of problems) console.log(`  · ${problem}`);
  process.exitCode = 1;
}
