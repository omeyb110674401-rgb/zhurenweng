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
  journalPg: 'drizzle/postgres/meta/_journal.json',
  journalSqlite: 'drizzle/sqlite/meta/_journal.json',
  // 本脚本自己：它改写工作区源码，所以"崩了能不能自愈"和任何一处实现同样需要钉住
  pinsScript: 'scripts/check-test-pins.mjs',
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
    from: '    if (source === null) return;',
    to: '    if (false) return;',
    pattern: '核对不上出处的条文要点不落库',
    test: 'tests/unit/summary-draft-points.test.mjs',
  },
  {
    label: '出处比对退化成逐字符比对（PDF 换行让真引用永远对不上）',
    file: 'summaryContent',
    from: "  return text.replace(/[\\s\\u3000]+/g, '').replace(/^[\"'“「『]|[\"'”」』]$/g, '');",
    to: '  return text;',
    pattern: '引用必须逐字落在喂给模型的条文里',
    test: 'tests/unit/summary-draft-points.test.mjs',
  },
  {
    label: '影子档也喂条文（shadow 与 on 不再有任何区别）',
    file: 'summarize',
    from: '  if (!attachmentTextFeedsSummary()) return [];',
    to: '  if (false) return [];',
    pattern: '附件条文进摘要',
    test: 'tests/e2e/summary-draft-input.test.mjs',
  },
  {
    label: '用到条文也不标「已喂」（详情页那句「本站读到的条文」失去依据）',
    file: 'summarize',
    from: '        if (draftSources.length > 0) {',
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
    from: "  if (!hasAnyRule({ keywords, categories, agencies })) return { ok: false, reason: 'no_rules' };",
    to: "  if (false) return { ok: false, reason: 'no_rules' };",
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
    from: "  return ORDERS[sort ?? 'deadline'];",
    to: '  return AGGREGATION_ORDER;',
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
    from: '        openCount: sql<number>`sum(case when ${openCondition()} then 1 else 0 end)`,',
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
    from: "    .set({ aiSummaryJson: null, summaryModel: null, summaryStatus: 'pending' })",
    to: '    .set({ aiSummaryJson: null, summaryModel: null })',
    pattern: 'issue #67：clearSummaryForRedraft',
    test: 'tests/e2e/summary-redraft.test.mjs',
  },
  {
    label: '放回队列时漏清模型名（恢复核对时对不上旧值）',
    file: 'summariesRepo',
    from: "    .set({ aiSummaryJson: null, summaryModel: null, summaryStatus: 'pending' })",
    to: "    .set({ aiSummaryJson: null, summaryStatus: 'pending' })",
    pattern: 'issue #67：clearSummaryForRedraft',
    test: 'tests/e2e/summary-redraft.test.mjs',
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

for (const testCase of CASES) {
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

  if (!/\nℹ tests ([1-9]\d*)/.test(out)) {
    problems.push(`${testCase.label} —— 名字模式没匹配到任何测试，这条用例本身是空的`);
  } else if (/\nℹ fail ([1-9]\d*)/.test(out)) {
    red += 1;
    console.log(`红 ✓ ${testCase.label}`);
  } else {
    problems.push(`${testCase.label} —— 撤掉实现后测试仍然通过，这条断言没钉住任何东西`);
  }
}

console.log(`\n撤掉实现后变红 ${red}/${CASES.length}`);
if (problems.length > 0) {
  console.log(`有问题 ${problems.length} 条：`);
  for (const problem of problems) console.log(`  · ${problem}`);
  process.exitCode = 1;
}
