/**
 * 只读探针（issue #86 §19.3 的后续）：那 14 处改动表述**落在哪几句上**、
 * 其中几句被落库的改动表覆盖了。
 *
 * 为什么先量这个再动手：`countChangeMarkers().total` 是**覆盖度的分母**，不是"改了几条"
 * （同一句可以被数出三处）。"把数到的每一处都列成行"这个方案（§19.3-③）成不成立，
 * 全看这个数：如果 14 处落在 6 句上，那按 14 行渲染就是把一句话印三遍 —— 又一个"量具自己说谎"。
 *
 * 只读：SELECT notices / notice_attachments / ai_summary_json，一条都不写。
 * 用法（服务器上）：
 *   docker compose run --rm -T worker node scripts/probe-change-markers.mjs --id 9bd57185
 */
import { getDb } from '../src/db/client.ts';
import { notices } from '../src/db/schema/sqlite.ts';
import { listNoticeAttachmentTexts } from '../src/db/repo/attachments.ts';
import { attachmentRole, countArticleAnchors } from '../src/lib/attachment-select.ts';
import { BODY_DRAFT_LABEL, bodyLooksLikeDraft } from '../src/lib/attachment-feed.ts';
import { countChangeMarkers, findChangeMarkers } from '../src/lib/change-coverage.ts';
import { parseQuotedSummary, quoteSegments } from '../src/lib/summary-content.ts';

const argv = process.argv.slice(2);
const idIndex = argv.indexOf('--id');
const prefix = idIndex === -1 ? null : (argv[idIndex + 1] ?? null);
const limitIndex = argv.indexOf('--limit');
const limit = limitIndex === -1 ? 3 : Number(argv[limitIndex + 1]) || 3;

/** 读侧容错与页面同源：解析失败当成"没有摘要"，不让一行脏数据打断整轮。 */
function safeParseJson(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const db = await getDb();
const rows = await db
  .select({
    id: notices.id,
    title: notices.title,
    bodyText: notices.bodyText,
    audience: notices.audience,
    summaryJson: notices.aiSummaryJson,
  })
  .from(notices)
  .orderBy(notices.id)
  .limit(400);

const targets = rows
  .filter((row) => (prefix === null ? row.summaryJson !== null : row.id.startsWith(prefix)))
  .slice(0, limit);

/** 一句话的边界：中文句读与换行。用它把"处"归并成"句"。 */
function sentenceSpans(text) {
  const spans = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ('。；！？\n'.includes(text[i])) {
      spans.push({ start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

for (const row of targets) {
  const attachments = await listNoticeAttachmentTexts(row.id);
  const bodyAsDraft =
    attachments.every((item) => attachmentRole(item.name) !== 'draft') &&
    bodyLooksLikeDraft(row.bodyText ?? '');
  const fullText = [
    ...attachments.map((item) => item.text),
    ...(bodyAsDraft ? [row.bodyText ?? ''] : []),
  ].join('\n');

  const markers = findChangeMarkers(fullText);
  const spans = sentenceSpans(fullText);
  const sentencesWithMarkers = spans.filter((span) =>
    markers.some((marker) => marker.index >= span.start && marker.index < span.end),
  );

  const stored = parseQuotedSummary(safeParseJson(row.summaryJson));
  const listed = stored.changes;

  console.log('='.repeat(100));
  console.log(`${row.id}  受众面 ${row.audience ?? '未判定'}`);
  console.log(`  ${row.title}`);
  console.log(
    `  附件 ${attachments.length} 份 ｜ 正文作为条文 ${bodyAsDraft ? '是' : '否'}` +
      ` ｜ 全文 ${fullText.length} 字符 ｜ 条号 ${countArticleAnchors(fullText)} 处`,
  );
  console.log(
    `  分母：改动表述 ${markers.length} 处` +
      `（modify=${countChangeMarkers(fullText).byKind.modify} add=${countChangeMarkers(fullText).byKind.add}` +
      ` delete=${countChangeMarkers(fullText).byKind.delete} renumber=${countChangeMarkers(fullText).byKind.renumber}）` +
      ` ｜ **落在 ${sentencesWithMarkers.length} 句上** ｜ 落库的改动表 ${listed.length} 行`,
  );

  /**
   * 覆盖判据（前三版都写错了，三版都留在这里 —— 它们是同一类错误的三个样子，
   * 而每一次报出来的都是一个**看起来像"发现了大问题"的假数**，比假绿灯更容易骗过复核）：
   *
   * - 第一版：整条 quote 与整句话**互相包含** ⇒ `二、将第五十八条第二款修改为：“……”` 这种
   *   只差前缀序号与引号的情形全判成没覆盖，打出 2/11。
   * - 第二版：改成"逐段包含"（去空白后 segment ⊆ sentence）⇒ **还是 2/11**：句子按 `。` 切，
   *   而那个句号在**引号里面**，引用末尾还多一个 `”` ⇒ 仍然不包含。
   * - 第三版：以表述为中心取 `index-12 .. index+18` 的窗口 ⇒ **0/14**：窗口往前伸进了上一句的
   *   尾巴，于是它永远不可能落在任何一行的引用里。
   * - 第四版（本版）：窗口**从表述开始往后取**，但长度依次试 8 / 12 / 16 —— 太长的窗口会在
   *   短句子上越过那一行引用的结尾（`（二）将第五条中的…修改为“欠发达地区”。` 就栽在这里），
   *   太短又容易撞词。三种长度里命中任一即算覆盖。
   *
   * 于是这个数的语义是：**这一句里的改动表述，有没有被表里某一行逐字引到**。
   * 它不是"表里够不够全"的完整答案（说明文字写得好不好看它不出来），别把它当那个用。
   */
  const normalized = (value) => value.replace(/\s+/g, '');
  const rowSegments = listed.map((item) => quoteSegments(item.quote).map(normalized));
  const WINDOW_LENGTHS = [8, 12, 16];
  const rowCoversMarker = (index) =>
    rowSegments.some((segments) =>
      WINDOW_LENGTHS.some((length) => {
        const window = normalized(
          fullText.slice(index, Math.min(fullText.length, index + length)),
        );
        return window.length >= 8 && segments.some((segment) => segment.includes(window));
      }),
    );

  let coveredMarkers = 0;
  let coveredSentences = 0;
  for (const span of sentencesWithMarkers) {
    const sentence = fullText.slice(span.start, span.end).trim();
    const hits = markers.filter(
      (marker) => marker.index >= span.start && marker.index < span.end,
    );
    const coveredHits = hits.filter((hit) => rowCoversMarker(hit.index));
    coveredMarkers += coveredHits.length;
    const sentenceCovered = coveredHits.length > 0;
    if (sentenceCovered) coveredSentences += 1;
    console.log(
      `   ${sentenceCovered ? '✓' : '✗'} [${hits.map((hit) => hit.kind).join('+')}]` +
        `（${coveredHits.length}/${hits.length} 处被覆盖） ` +
        `${sentence.slice(0, 66)}${sentence.length > 66 ? '…' : ''}`,
    );
  }
  console.log(
    `  ⇒ 三个数不是一个数：**按处** ${coveredMarkers}/${markers.length} 处被覆盖 ｜ ` +
      `**按句**（官方那一串"一、二、三…"的条目）${coveredSentences}/${sentencesWithMarkers.length} 句被覆盖 ｜ ` +
      `落库的改动表 ${listed.length} 行`,
  );
  if (bodyAsDraft) console.log(`  （正文那一份按 ${BODY_DRAFT_LABEL} 计入分母）`);
}
console.log('\n（本探针只读：一个字都没写库）');
