/**
 * 实验探针（issue #86 第五节）：用 **git 里那份旧提示词**（`37ae7fa^`）重跑一条修正草案，
 * 回答一个挂了两轮的问题 —— 「改动点」当年到底是
 * **(a) 模型返回了空数组**，还是 **(b) 引用没通过逐字反查被丢掉**？
 *
 * 为什么必须专门跑一次：#79 写下了"两种可能从库里区分不了，定位要拿模型原始输出来看，
 * 不该猜"，然后就停在那里；#85 只好按"从未产出过"把功能整个删掉。这个问题的答案决定
 * 第 2 刀怎么做（若模型根本不吐"原→改"，那么"改问法"没用，得先换依据来源）。
 *
 * **只读**：仅 SELECT；不改库、不改文件、不碰线上摘要。模型调用走**当轮环境变量**里的
 * 服务商（生产容器里的那一份），提示词用嵌入的旧版原文。
 *
 * 用法（生产容器内，脚本挂进去跑）：
 *   docker compose run --rm -v /tmp/probe-amendment-changes.mjs:/app/scripts/probe-amendment-changes.mjs \
 *     worker node scripts/probe-amendment-changes.mjs --id 9bd57185
 *
 * 输入窗口刻意**复用生产那一份**（`draftSourcesForSummary`）：自己另拼一份"差不多的输入"
 * 会让结论只对这份探针成立 —— 而那正是要避免的事。
 */
import { Client } from 'pg';
import {
  draftBlock,
  explanationBlock,
  parseModelJson,
  resolveGlmConfig,
  resolveOpenAiLlmConfig,
} from '../src/lib/adapters/openai-compatible-llm.ts';
import { draftSourcesForSummary } from '../worker/jobs/summarize-notices.ts';

const argv = process.argv.slice(2);
const idIndex = argv.indexOf('--id');
const idPrefix = idIndex === -1 ? '9bd57185' : (argv[idIndex + 1] ?? '9bd57185');
const showInput = !argv.includes('--no-input');

/**
 * 旧提示词（`37ae7fa^:src/lib/adapters/openai-compatible-llm.ts` 的第 69–90 行）**逐字**抄来。
 * 差一个字都可能改变模型的行为，而这次实验的全部意义就在于"复现当年那一跑"。
 *
 * 因此它**故意**还带着 `whoCanSubmit`（「谁能提」）这个键 —— 那是当年那一跑的输入的一部分，
 * 不是漏改。该字段已于 2026-10-02 从线上提示词里删除，模型今天多吐这个键也没人读
 * （`normalizeModelSummary` 只认自己列出的键）。
 */
const OLD_SYSTEM_PROMPT = [
  '你是政府公示的「参与导引」助手。用户会给出一份公示的标题与网页正文纯文本，可能还会附上本站从该公示官方文档里提取的「附件条文」。',
  '重要背景：网页正文通常只是公告本身；草案条文、标准文本、名单在**附件**里，只有给了「附件条文」段落时你才真的看得到它们。',
  '因此：没有「附件条文」段落时，不要编写、推测或概括任何「条款内容」，只回答公告里真实存在的参与信息。',
  '请只输出一个 JSON 对象（不要输出任何解释、markdown 代码围栏或其他文字），字段如下：',
  '{"what":"这是什么：一句话概括这份公示在做什么，40 字以内","who":"影响谁：只有原文明确写出受这份文件影响的主体时才写（如运输机场运营人、医疗器械注册人、标准起草单位）；原文只写「社会公众」「有关单位和个人」这类泛称时**留空字符串** —— 那是「谁能提」，不是「影响谁」。这类页面的正文通常不含受影响主体（它在附件的草案里），宁可留空也不要推断","whoCanSubmit":"谁能提：原文写明的可提出意见的主体或范围；原文未提及则留空字符串","afterDeadline":"逾期会怎样：原文写明超过截止日期后如何处理（如逾期视为无意见、不再受理）；原文未提及则留空字符串","keyPoints":["草案条文要点：仅当给出「附件条文」时填写，2-4 条从条文中读到的实质规定，每条一句话、40 字以内；没有附件条文段落时必须为空数组"],"explanationPoints":[{"heading":"照抄说明里的小节标题（如 一、项目概况）","text":"这一节说了什么：一句话，60 字以内","quote":"这一节的逐字原文，200 字以内"}],"changes":[{"clause":"被改条款标识，照抄原文写法（如 第三条 / 附录A）","kind":"modify|add|delete|renumber|other","text":"这一处改了什么：一句话，40 字以内","quote":"描述这处改动的逐字原文，160 字以内"}],"deadline":"截止日期：YYYY-MM-DD，原文未明确则为 null","howToComment":"如何提意见：一句话概述提交途径，40 字以内","channels":[{"kind":"email|phone|mail|online|other","value":"可直接使用的具体值"}],"quotes":{"what":"what 对应的原文引用片段（逐字摘录，不超过100字）","who":"who 对应的原文引用片段，留空时空字符串","whoCanSubmit":"谁能提对应的原文片段，没有则空字符串","afterDeadline":"逾期会怎样对应的原文片段，没有则空字符串","keyPoints":["与 keyPoints 一一对应的逐字条文原文，顺序严格一致，没有则为 null"],"deadline":"截止日期对应的原文引用片段","howToComment":"如何提意见对应的原文引用片段","channels":["每条渠道对应的原文片段，顺序与 channels 严格一致"]}}',
  '要求：',
  '1. 只依据给定原文，不编造、不猜测；原文没有的字段留空字符串或 null，宁可留空也不要凑。',
  '2. 引用必须是原文中的逐字连续片段。',
  '3. channels 的 value 只放地址本身（如 xxx@yyy.gov.cn、010-6601xxxx、含邮编的邮寄地址、网址），说明性文字放 howToComment；一份公示常同时给邮件、信函、传真、网址几种渠道，应全部列出。',
  '4. channels 没有可列的渠道时输出空数组。',
  '5. keyPoints 是这份计划里**唯一**允许写条文内容的段落，它的依据只能是「附件条文」段落：',
  '   - 每条要点都要在 quotes.keyPoints 给出对应的逐字条文原句（同一下标配对，错配比留空更糟）；',
  '   - 附件条文可能只是草案的一部分（本站按字数预算截取），因此只写你确实在文本里读到的规定，不要用「规定了」「明确了」去概括看不到的部分；',
  '   - 受影响主体（who）往往写在条文里（如「中华人民共和国境内的某某企业从事下列活动…」），给了条文时 who 可以据实填写，其引用取自条文。',
  '6. changes 只在这份文件是「修改现行法律、法规、规章或标准」时填写，其余情况输出空数组：',
  '    每项都要带 quote，且 quote 必须是「附件条文」里的**逐字连续片段**：本站拿它反查出处，反查不到的整条丢弃（错配比留空更糟）；',
  '    官方通常把新旧写法写在同一句里（如「第三条修改为：……」「删去第七条」「增加一条，作为第X条」），照原句摘出来，不要重述成你自己的话；',
  '    只列你真在文本里看到的改动。附件可能被本站按字数预算截断，看不到的部分就**不要列**，也不要写「等」「主要修改内容如下」来掩盖缺口 ——',
  '     面会另给一行「正文里检测到 N 处修改表述，本页列出 M 处」，那个差值是本站读得不够，不是你漏写。',
  '7. explanationPoints 只依据「编制说明」段落（说明讲为什么制定、依据什么、主要改了什么、向谁征求意见，不是规定本身）：heading 照抄该小节自己的标题，引用只能取自说明段落；keyPoints / changes 的引用只能取自条文段落 —— 本站按段落分别反查，串了整条丢弃。说明里没有分层小标题时输出空数组，不要自己造小节名。',
].join('\n');

/** 旧实现的「逐字反查」规则（`37ae7fa^:src/lib/summary-content.ts`，行为逐条抄来）。 */
function quoteFingerprint(text) {
  return text.replace(/[\s\u3000]+/g, '').replace(/^["'“「『]|["'”」』]$/g, '');
}
const MIN_VERIFIABLE_QUOTE_CHARS = 8;
function findSourceForQuote(quote, sources) {
  if (!quote) return null;
  const normalized = quoteFingerprint(quote);
  if (normalized.length < MIN_VERIFIABLE_QUOTE_CHARS) return null;
  for (const source of sources) {
    if (quoteFingerprint(source.text).includes(normalized)) return source;
  }
  return null;
}

/** 旧实现的改动表述计数（`37ae7fa^:src/lib/amendment-coverage.ts`）—— 覆盖度那行的分母。 */
const KIND_PATTERNS = {
  modify: /修改为|修改如下|作.{0,4}修改/g,
  add: /增加一条|新增.{0,8}条/g,
  delete: /删去|删除/g,
  renumber: /作为第[一二三四五六七八九十百零两]{1,6}条|顺序作.{0,4}调整/g,
};
function countChangeMarkers(text) {
  const byKind = { modify: 0, add: 0, delete: 0, renumber: 0 };
  for (const [kind, pattern] of Object.entries(KIND_PATTERNS)) {
    byKind[kind] = [...text.matchAll(new RegExp(pattern.source, 'g'))].length;
  }
  return { total: Object.values(byKind).reduce((a, b) => a + b, 0), byKind };
}

const provider = process.env.LLM_PROVIDER ?? 'stub';
if (provider === 'stub') {
  console.error('当前 LLM_PROVIDER=stub（本地/未配密钥），这个探针要验的是真实模型，退出。');
  process.exit(1);
}
const config = provider === 'glm' ? resolveGlmConfig() : resolveOpenAiLlmConfig();
console.log(`端口 ${config.providerLabel} 模型 ${config.model} 基址 ${config.apiBase}`);

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const noticeResult = await client.query(
  `select id, title, url, source_id, body_text, genre, audience, status, deadline_at
     from notices where id like $1 || '%' limit 2`,
  [idPrefix],
);
if (noticeResult.rows.length === 0) {
  console.error(`找不到条目 ${idPrefix}`);
  await client.end();
  process.exit(1);
}
const row = noticeResult.rows[0];
const attachmentResult = await client.query(
  `select url, name, status, char_count, extracted_text
     from notice_attachments where notice_id = $1 order by char_count desc nulls last`,
  [row.id],
);
await client.end();

const target = {
  id: row.id,
  title: row.title,
  url: row.url,
  bodyText: row.body_text,
  sourceId: row.source_id,
  genre: row.genre,
  audience: row.audience,
};
// 与生产同一份窗口：条数/字数预算/结构感知截取/角色判定全走 worker 自己那份实现
const draftSources = await draftSourcesForSummary(target);

console.log(`\n=== 条目 ${row.id}  ${row.title.slice(0, 46)}`);
console.log(`    体裁 ${row.genre} 状态 ${row.status} 截止 ${row.deadline_at}`);
console.log(`    正文 ${(row.body_text ?? '').length} 字；附件 ${attachmentResult.rows.length} 份，其中喂进提示词 ${draftSources.length} 份`);
for (const attachment of attachmentResult.rows) {
  const fed = draftSources.find((source) => source.url === attachment.url);
  console.log(
    `      ${attachment.status.padEnd(12)} ${String(attachment.char_count ?? '-').padStart(7)} 字  ` +
      `${fed ? `喂入 ${fed.text.length} 字（role=${fed.role ?? 'draft'}）` : '未喂入'}  ${attachment.name}`,
  );
}

const fullText = attachmentResult.rows.map((a) => a.extracted_text ?? '').join(' ');
const markers = countChangeMarkers(fullText);
const draftOnlyMarkers = countChangeMarkers(
  draftSources.filter((s) => s.role !== 'explanation').map((s) => s.text).join(' '),
);
console.log(`\n    旧覆盖度分母（全文）：共 ${markers.total} 处 ${JSON.stringify(markers.byKind)}`);
console.log(`    旧反查池（条文侧，排除说明）：共 ${draftOnlyMarkers.total} 处 ${JSON.stringify(draftOnlyMarkers.byKind)}`);

if (showInput) {
  console.log('\n=== 喂进提示词的内容（逐字） ===');
  for (const source of draftSources) {
    console.log(`\n──── ${source.name}（role=${source.role ?? 'draft'}，${source.text.length} 字）────`);
    console.log(source.text);
  }
}

const userPrompt = [
  `标题：${target.title}`,
  `官方原文链接：${target.url}`,
  '正文纯文本：',
  (target.bodyText ?? '').length > 0 ? target.bodyText : '（未抓取到正文，仅能基于标题判断）',
  draftBlock(draftSources),
  explanationBlock(draftSources),
]
  .filter((part) => part.length > 0)
  .join('\n');

const started = Date.now();
const response = await fetch(`${config.apiBase.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  },
  body: JSON.stringify({
    model: config.model,
    messages: [
      { role: 'system', content: OLD_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  }),
  signal: AbortSignal.timeout(config.timeoutMs),
});
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
if (!response.ok) {
  console.error(`HTTP ${response.status}：${(await response.text()).slice(0, 300)}`);
  process.exit(1);
}
const payload = await response.json();
const choice = payload?.choices?.[0];
const content = choice?.message?.content ?? '';
console.log(`\n=== 模型原始输出（${elapsed}s，finish_reason=${choice?.finish_reason}，${content.length} 字） ===`);
console.log(content);

let parsed = null;
try {
  parsed = parseModelJson(content);
} catch (error) {
  console.log(`\n!! 输出解析不了：${error instanceof Error ? error.message : String(error)}`);
}
if (parsed !== null) {
  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes : null;
  console.log(`\n=== 把旧实现的判据套上去 ===`);
  console.log(`    parsed.changes 是数组吗：${rawChanges === null ? '否（缺键或不是数组）' : `是，${rawChanges.length} 条`}`);
  const draftSide = draftSources.filter((source) => source.role !== 'explanation');
  const explanationSide = draftSources.filter((source) => source.role === 'explanation');
  let keptByOldCode = 0;
  for (const [index, item] of (rawChanges ?? []).entries()) {
    const quote = typeof item?.quote === 'string' ? item.quote.trim() : '';
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const inDraft = findSourceForQuote(quote, draftSide);
    const inExplanation = findSourceForQuote(quote, explanationSide);
    const survives = quote !== '' && text !== '' && inDraft !== null;
    if (survives) keptByOldCode += 1;
    console.log(
      `    ${index + 1}. [${item?.kind ?? '?'}] ${item?.clause ?? '?'} —— ${survives ? '会落库' : '会被丢弃'}` +
        `（条文侧${inDraft ? `命中《${inDraft.name}》` : '未命中'}；说明侧${inExplanation ? `命中《${inExplanation.name}》` : '未命中'}）`,
    );
    console.log(`       说明：${text.slice(0, 60)}`);
    console.log(`       引用：${quote.slice(0, 120)}`);
  }
  console.log(`\n    旧实现最终会落库的改动点：${keptByOldCode} 条`);
  console.log(`    keyPoints：${Array.isArray(parsed.keyPoints) ? parsed.keyPoints.length : '缺键'} 条`);
  console.log(`    explanationPoints：${Array.isArray(parsed.explanationPoints) ? parsed.explanationPoints.length : '缺键'} 条`);
}
