/**
 * 只读探针（issue #86 第十八节）：npc 的草案电子文档**走一遍真链路**要多久、读到什么。
 *
 * 走的是生产那三段实现，一段都不另写：
 *   适配器声明地址（`npcLawDraftsAdapter.attachmentListUrl` / `parseAttachmentList`）
 *   → 抓取层的传输与守卫（`crawlFetch` / `readCappedBuffer`，带**按源**预算）
 *   → 仓库自己的解析器（`parseAttachment`）。
 *
 * 回答的是"如果这一条现在被正常抓到，我们会读到什么、花多久、会不会被上限挡住"，
 * **一条都不写库**（不 upsertNotice、不写 notice_attachments）。
 *
 * 用法（服务器上，一次性 worker 容器里）：
 *   docker compose run --rm -T worker node scripts/probe-npc-attachment.mjs --lid <lid>
 * 不带 --lid 时用库里第一条 npc 条目的 lid。
 */
import { crawlFetch, readCappedBuffer, DEFAULT_CRAWL_TIMEOUT_MS } from '../worker/jobs/crawl-notices.ts';
import { attachmentBudgetFor } from '../src/sources/attachment-budget.ts';
import { sourceAdapters } from '../src/sources/registry.ts';
import { parseAttachment, MAX_STORED_TEXT_CHARS } from '../src/lib/attachments/parse.ts';
import { countArticleAnchors, countCjk } from '../src/lib/attachment-select.ts';
import { envInt } from '../src/lib/env-int.ts';

const args = process.argv.slice(2);
const lidArg = args.indexOf('--lid');
const lid =
  lidArg >= 0 && args[lidArg + 1] !== undefined
    ? args[lidArg + 1]
    : (process.env.NPC_PROBE_LID ?? 'ff8081819ff54ab801a03d624f823cc3');

// 探针自己把开关打开：它的用途就是量"开关打开时会发生什么"，但**要说清**这一点
process.env.NPC_DRAFT_ATTACHMENTS = 'on';
const adapter = sourceAdapters.find((item) => item.id === 'npc');
if (!adapter) throw new Error('注册表里没有 npc 适配器');

const notice = {
  title: `（探针）lid=${lid}`,
  agency: '全国人大常委会法制工作委员会',
  url: `http://www.npc.gov.cn/flcaw/userIndex.html?lid=${lid}`,
  publishedAt: null,
  deadlineAt: null,
  bodyText: null,
  attachments: [],
};

const globalMaxBytes = envInt('ATTACHMENT_MAX_BYTES', 4 * 1024 * 1024, { min: 1024 });
const budget = attachmentBudgetFor({
  sourceId: 'npc',
  adapters: sourceAdapters,
  globalMaxBytes,
  globalTimeoutMs: DEFAULT_CRAWL_TIMEOUT_MS,
});
console.log(
  `预算：单个附件 ${(budget.maxBytes / 1024 / 1024).toFixed(0)} MB / ${budget.timeoutMs} ms` +
    `（按源声明=${budget.maxBytesPerSource}；全站缺省 ${(globalMaxBytes / 1024 / 1024).toFixed(0)} MB / ${DEFAULT_CRAWL_TIMEOUT_MS} ms）`,
);

const listUrl = adapter.attachmentListUrl(notice);
console.log(`\n① 附件清单接口：${listUrl}`);
const startedList = Date.now();
const payload = await crawlFetch(listUrl, { timeoutMs: adapter.fetch?.timeoutMs }).then((response) =>
  response.text(),
);
console.log(`   ${((Date.now() - startedList) / 1000).toFixed(1)}s ｜ ${payload.length} 字符`);
const declared = await adapter.parseAttachmentList(payload, notice.url);
console.log(`   声明 ${declared.length} 个附件：${declared.map((item) => item.name).join(' / ')}`);
if (declared.length === 0) {
  console.log('   接口没给文件名 —— 按判据一个附件都不声明（不臆造）');
  process.exit(0);
}

for (const attachment of declared) {
  console.log(`\n② 下载：${attachment.url}`);
  const started = Date.now();
  const response = await crawlFetch(attachment.url, {
    headers: { referer: notice.url, accept: '*/*' },
    timeoutMs: budget.timeoutMs,
  });
  if (!response.ok) {
    console.log(`   HTTP ${response.status}（这一条这一轮取不到）`);
    continue;
  }
  const body = await readCappedBuffer(response, budget.maxBytes);
  const seconds = (Date.now() - started) / 1000;
  const mb = body.byteLength / 1024 / 1024;
  console.log(
    `   ${seconds.toFixed(1)}s ｜ ${body.byteLength} 字节（${mb.toFixed(1)} MB）｜ ${(mb / seconds).toFixed(2)} MB/s`,
  );
  console.log(
    body.byteLength > budget.maxBytes
      ? `   ⚠️ 超过按源上限 ${budget.maxBytes} 字节（抽取任务会判 too_large）`
      : `   未超上限（抽取任务会走解析）`,
  );

  console.log(`\n③ 解析（生产那份 parseAttachment）：`);
  const parsed = await parseAttachment({ kind: 'pdf', body });
  console.log(
    `   status=${parsed.status} ｜ ${parsed.pages ?? '-'} 页 ｜ ${parsed.charCount} 字符 ｜ ` +
      `${countCjk(parsed.text)} 汉字 ｜ 「第X条」${countArticleAnchors(parsed.text)} 处`,
  );
  console.log(`   入库会截断到 ${MAX_STORED_TEXT_CHARS} 字符`);
  if (parsed.error) console.log(`   error: ${parsed.error}`);
  console.log(`   开头 200 字：${parsed.text.replace(/\s+/g, ' ').slice(0, 200)}`);
}
console.log('\n（本探针只读：一个字都没写库）');
