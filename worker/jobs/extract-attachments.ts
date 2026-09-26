import { createHash } from 'node:crypto';
import {
  listEligibleAttachments,
  listNoticesForAttachmentExtraction,
  markAttachmentResult,
  refreshNoticeGenreFromAttachments,
  syncAttachmentManifest,
} from '../../src/db/repo/attachments.ts';
import type {
  AttachmentExtractStatus,
  AttachmentKind,
  NoticeAttachmentRecord,
} from '../../src/db/types.ts';
import { parseAttachment } from '../../src/lib/attachments/parse.ts';
import { detectAttachmentKind, looksLikeHtml } from '../../src/lib/file-magic.ts';
import { attachmentExtractionEnabled, attachmentMode } from '../../src/lib/attachment-mode.ts';
import {
  MAX_FILES_PER_NOTICE,
  countCjk,
  hasDraftText,
  selectAttachmentCandidates,
} from '../../src/lib/attachment-select.ts';
import { envInt } from '../../src/lib/env-int.ts';
import { errorMessage } from '../../src/lib/errors.ts';
import { attachmentUrlCandidates } from '../../src/lib/attachment-url.ts';
import { crawlFetch, readCappedBuffer } from './crawl-notices.ts';
import type { Job, JobContext } from '../registry.ts';

/**
 * 附件条文抽取任务（issue #57）—— 把「草案在附件里」变成摘要能用的第二路输入。
 *
 * 为什么不塞进 crawl：crawl 已有 per-source 健康度与告警身份，混进上百个文件下载会让
 * `sources.last_error_message` 失去意义（附件 403 不代表这个源抓不动），且抓取重试会
 * 重复下载。独立任务换来四样东西：独立墙钟预算、独立失败告警、独立开关、可以单跑。
 *
 * 为什么不塞进 summarize：那个任务的重试阶梯（4 × 300s）是为 LLM 调的，下载失败如果
 * 走那条路会白烧 LLM 重试，并把条目打成 failed_review。
 *
 * 与 #35 的既有决定相调和：#35 定下「不在抓取期探测附件可达性」，理由是（i）每轮多出
 * 上百请求不礼貌、（ii）我们机房的 403 不该让附件链接对用户消失。这里 (i) 由「解耦 +
 * 每主机 3s 间隔 + 每轮限量 + 内容哈希命中就不再解析」回答；(ii) 保留为**硬规则** ——
 * `blocked` 只改我们自己的文案，绝不影响页面渲染（详情页那条断言在 #57 的 e2e 里）。
 */

/** 一轮最多下载几个文件（先到先停，与下面的墙钟预算成对）。 */
const MAX_FILES_PER_ROUND = envInt('ATTACHMENT_MAX_FILES_PER_ROUND', 120, { min: 1 });
/** 单轮墙钟预算：超过就收尾，未处理的行留在 pending 等下一轮。 */
const ROUND_BUDGET_MS = envInt('ATTACHMENT_ROUND_BUDGET_MS', 20 * 60_000, { min: 1000 });
/** 单个文件的下载上限（真实分布里 mee 的标准文本有几十 MB，靠这条诚实降级）。 */
const MAX_BYTES = envInt('ATTACHMENT_MAX_BYTES', 4 * 1024 * 1024, { min: 1024 });
/** 探测只读前这么多字节就够判类型与总大小。 */
const PROBE_BYTES = envInt('ATTACHMENT_PROBE_BYTES', 64 * 1024, { min: 16 });
/**
 * 同一主机两次请求的最小间隔。比页面抓取的 400ms 高近一个量级：附件是大文件、
 * 且一条公示的附件全部指向同一台主机。
 */
const HOST_INTERVAL_MS = envInt('ATTACHMENT_HOST_INTERVAL_MS', 3000, { min: 0 });
/** 一轮内同一主机连续被拒几次就不再碰它（miit 那种整站 403 的主机不该每天吃 16 个请求）。 */
const HOST_BLOCK_TRIP = envInt('ATTACHMENT_HOST_BLOCK_TRIP', 3, { min: 1 });
/** `blocked` 的退避天数：每周探一次，而不是每天。 */
const BLOCKED_RETRY_DAYS = envInt('ATTACHMENT_BLOCKED_RETRY_DAYS', 7, { min: 1 });
/** `ok` 的刷新周期：官方可能在同一 URL 上换稿，但不会天天换。 */
const REFRESH_DAYS = envInt('ATTACHMENT_REFRESH_DAYS', 30, { min: 1 });
/** `error` 的重试上限，超过就停在 error 不再消耗请求。 */
const MAX_ATTEMPTS = envInt('ATTACHMENT_MAX_ATTEMPTS', 3, { min: 1 });
/** 一轮扫多少条公示（通常文件数上限先到）。 */
const NOTICES_PER_ROUND = envInt('ATTACHMENT_NOTICES_PER_ROUND', 60, { min: 1 });
/**
 * 逗号分隔的源 ID 黑名单。缺省排 npc：它的详情是 JSON 接口、根本不产附件
 * （README「数据源清单」那行），所以这更多是把「不服务 npc」这件事写明而不是过滤掉什么。
 */
const EXCLUDED_SOURCES = (process.env.ATTACHMENT_EXCLUDE_SOURCES ?? 'npc')
  .split(',')
  .map((id) => id.trim())
  .filter((id) => id !== '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 401 / 403 / 404 同类：这台主机现在不给这个文件。 */
function isRefusal(status: number): boolean {
  return status === 401 || status === 403 || status === 404;
}

/**
 * 读响应体前缀，够 maxBytes 就取消连接。
 *
 * 为什么不复用 `readCappedBuffer`：那个函数的语义是「超过上限就报错」，会把几十 MB 的
 * 标准文本整档读完；探测要的是「读这么多就停，后面还有」。
 */
async function readPrefix(
  response: Response,
  maxBytes: number,
): Promise<{ head: Uint8Array; truncated: boolean }> {
  if (response.body === null) return { head: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { head: Buffer.concat(chunks), truncated: false };
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { head: Buffer.concat(chunks).subarray(0, maxBytes), truncated: true };
    }
  }
}

/** `Content-Range: bytes 0-65535/1234567` → 1234567；服务器不理 Range 时退回 content-length。 */
function declaredTotalBytes(response: Response, rangeHonored: boolean): number | null {
  if (rangeHonored) {
    const match = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
    if (match !== null) return Number(match[1]);
  }
  const length = Number(response.headers.get('content-length') ?? '');
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * 每主机节流 + 连续被拒熔断。只在**一轮之内**记忆 ——
 * 跨轮的退避由 `blocked` 状态与天数承担，那才是能活过重启的部分。
 */
class HostPolicy {
  private readonly lastAt = new Map<string, number>();
  private readonly refusals = new Map<string, number>();
  private readonly intervalMs: number;
  private readonly tripCount: number;

  // 刻意不用构造器参数属性（`constructor(private readonly x: number)`）：worker 是以
  // Node 的 strip-only 模式直接跑 .ts 的，那种写法会在**导入时**就 SyntaxError，
  // 而 `tsc --noEmit` 完全看不出来。
  constructor(intervalMs: number, tripCount: number) {
    this.intervalMs = intervalMs;
    this.tripCount = tripCount;
  }

  tripped(host: string): boolean {
    return (this.refusals.get(host) ?? 0) >= this.tripCount;
  }

  async wait(host: string): Promise<void> {
    const last = this.lastAt.get(host);
    if (last === undefined) return;
    const waiting = this.intervalMs - (Date.now() - last);
    if (waiting > 0) await sleep(waiting);
  }

  /** @returns 本次失败是否刚好触发熔断（调用方据此打一条日志，不重复刷） */
  record(host: string, refused: boolean): boolean {
    this.lastAt.set(host, Date.now());
    if (!refused) {
      this.refusals.delete(host);
      return false;
    }
    const next = (this.refusals.get(host) ?? 0) + 1;
    this.refusals.set(host, next);
    return next === this.tripCount;
  }
}

interface RoundTally {
  downloaded: number;
  parsed: number;
  byStatus: Map<AttachmentExtractStatus, number>;
  cjkChars: number;
}

/** 要写库的一行结论。 */
interface Outcome {
  status: AttachmentExtractStatus;
  kind?: AttachmentKind | null;
  bytes?: number | null;
  contentHash?: string | null;
  charCount?: number | null;
  extractedText?: string | null;
  error?: string | null;
  /** null = 这一轮根本没发请求（熔断跳过），不能刷新 last_fetch_at / 重试计数 */
  fetchedAt: Date | null;
}

async function record(
  noticeId: string,
  url: string,
  outcome: Outcome,
  tally: RoundTally,
): Promise<void> {
  await markAttachmentResult(noticeId, url, {
    status: outcome.status,
    kind: outcome.kind ?? null,
    bytes: outcome.bytes ?? null,
    contentHash: outcome.contentHash ?? null,
    charCount: outcome.charCount ?? null,
    extractedText: outcome.extractedText ?? null,
    error: outcome.error ?? null,
    fetchedAt: outcome.fetchedAt,
  });
  tally.byStatus.set(outcome.status, (tally.byStatus.get(outcome.status) ?? 0) + 1);
  tally.cjkChars += outcome.charCount ?? 0;
}

/** 附件请求的公共头。referer 是 #57 唯一没被试过的一手：现有抓取从不发 referer。 */
function attachmentHeaders(noticeUrl: string, range?: string): Record<string, string> {
  const headers: Record<string, string> = { referer: noticeUrl, accept: '*/*' };
  if (range !== undefined) headers.range = range;
  return headers;
}

/** 探测的两种停步：拿到可读响应（带**实际取回它的地址**），或者这一行本轮已有结论。 */
type ProbeResult =
  | { readonly probed: true; readonly response: Response; readonly servedUrl: string }
  | { readonly probed: false; readonly outcome: Outcome };

/**
 * 依次试候选地址，读到文件前缀就停。
 *
 * 与改动前的差别只有一处，但那条决定 miit 能不能读到条文：**被拒不再立刻定性**，
 * 先把同一条路径送到详情页主机上再试一次，两次都不行才写 blocked。
 */
async function probeAttachment(
  urls: readonly string[],
  noticeUrl: string,
  policy: HostPolicy,
  logger: (message: string) => void,
): Promise<ProbeResult> {
  let refusal: string | null = null;
  for (const url of urls) {
    const host = hostOf(url);
    if (policy.tripped(host)) continue;
    await policy.wait(host);
    let response: Response;
    try {
      response = await crawlFetch(url, {
        headers: attachmentHeaders(noticeUrl, `bytes=0-${PROBE_BYTES - 1}`),
        returnForStatus: isRefusal,
      });
    } catch (error) {
      // 守卫拒绝 / 超时 / 重定向环：这些是「还不知道结论」，留 error 让下轮重试
      policy.record(host, false);
      return {
        probed: false,
        outcome: { status: 'error', error: `探测失败：${errorMessage(error)}`, fetchedAt: new Date() },
      };
    }
    if (isRefusal(response.status)) {
      const tripped = policy.record(host, true);
      if (tripped) logger(`  主机 ${host} 连续被拒 ${HOST_BLOCK_TRIP} 次，本轮不再请求它的附件`);
      refusal = `HTTP ${response.status}（${host}）`;
      continue;
    }
    policy.record(host, false);
    return { probed: true, response, servedUrl: url };
  }
  if (refusal !== null) {
    return { probed: false, outcome: { status: 'blocked', bytes: 0, error: refusal, fetchedAt: new Date() } };
  }
  // 候选全被本轮熔断挡住：一个请求都没发，所以 fetchedAt 留 null。写成时间戳会把
  // blocked 的退避窗口重置，于是这台主机每天重新排队、熔断永远解不开。
  return {
    probed: false,
    outcome: {
      status: 'blocked',
      error: `主机 ${urls.map(hostOf).join(' / ')} 本轮已连续被拒，跳过（未发请求）`,
      fetchedAt: null,
    },
  };
}

/**
 * 处理一个附件：探 → 判型 → 整档 → 解析 → 写终态。
 *
 * 不抛异常：任何一步失败都翻译成 `AttachmentExtractStatus`，好让「失败面」在生产上是
 * 一组可统计的数字，而不是一条被 try/catch 吞掉的日志。
 */
async function extractOne(
  notice: { id: string; url: string },
  attachment: { name: string; url: string },
  existing: NoticeAttachmentRecord | undefined,
  policy: HostPolicy,
  tally: RoundTally,
  logger: (message: string) => void,
): Promise<void> {
  /**
   * 刷新失败时**保留上一轮已经抽到的条文**。
   *
   * 为什么：一行 `ok` 到期重取（默认 30 天）时源站今天 403 / 超时是常事，如果把结论
   * 直接写成 blocked，就会连带清掉文本 —— 摘要于是从「读过条文」退化成「只有公告壳」，
   * 而且是**因为我们的机房今天不顺利**而退化。失败照实在 error 里写清，状态仍为 ok。
   *
   * 这只适用于「本来就有文本」的行；从没读到的行照常记 blocked，审计脚本才看得见失败面。
   * 判据看的是**本轮结论是不是失败**：内容没变时本轮也是 ok，那时候要写的是「取到了、
   * 没变」，不是「未能刷新」。
   */
  const keepStale = (outcome: Outcome): Outcome => {
    if (outcome.status === 'ok') return outcome;
    if (existing?.status !== 'ok' || (existing.extractedText ?? '') === '') return outcome;
    return {
      status: 'ok',
      kind: outcome.kind ?? existing.kind,
      bytes: existing.bytes,
      contentHash: existing.contentHash,
      charCount: existing.charCount,
      extractedText: existing.extractedText,
      error: `本轮未能刷新（${outcome.status}${outcome.error ? `：${outcome.error}` : ''}），沿用上一轮文本`,
      fetchedAt: outcome.fetchedAt,
    };
  };
  /**
   * 直连被拒、换同站主机才取到时要留痕：这一行的 `url` 仍是页面里写的那个地址，
   * 不留痕就事后看不出文本其实取自另一台主机。只补 error 的空缺 —— 失败行自己的
   * 原因优先，那个字段是审计脚本的读数列。
   */
  let viaNote: string | null = null;
  const settle = (outcome: Outcome): Promise<void> => record(
    notice.id,
    attachment.url,
    keepStale(viaNote === null || outcome.error != null ? outcome : { ...outcome, error: viaNote }),
    tally,
  );

  const probed = await probeAttachment(
    attachmentUrlCandidates(attachment.url, notice.url),
    notice.url,
    policy,
    logger,
  );
  if (!probed.probed) {
    await settle(probed.outcome);
    return;
  }
  const { response: probe, servedUrl } = probed;
  const host = hostOf(servedUrl);
  viaNote = servedUrl === attachment.url
    ? null
    : `直连 ${hostOf(attachment.url)} 未取到，改由 ${host} 取回同一路径`;

  const { head, truncated } = await readPrefix(probe, PROBE_BYTES);
  const total = declaredTotalBytes(probe, truncated);
  policy.record(host, false);

  // HTML 与「不支持的二进制」要分开：前者换 IP / 换时间可能就好（not_a_file 仍按
  // 退避重试），后者重下多少次都一样，直接落终态不再消耗请求。
  if (looksLikeHtml(head)) {
    await settle({
      status: 'not_a_file',
      kind: 'other',
      bytes: head.byteLength,
      error: '响应体是 HTML 页面而不是文件',
      fetchedAt: new Date(),
    });
    return;
  }
  const kind = detectAttachmentKind(head);
  if (kind === 'other') {
    await settle({
      status: 'unsupported_container',
      kind,
      bytes: head.byteLength,
      error: `文件头不是 pdf / docx / doc（前 4 字节：${[...head.subarray(0, 4)].join(' ')}）`,
      fetchedAt: new Date(),
    });
    return;
  }
  if (total !== null && total > MAX_BYTES) {
    await settle({
      status: 'too_large',
      kind,
      bytes: total,
      error: `声明 ${total} 字节，超过单个附件 ${MAX_BYTES} 字节上限`,
      fetchedAt: new Date(),
    });
    return;
  }

  let body: Uint8Array;
  try {
    const full = await crawlFetch(servedUrl, {
      headers: attachmentHeaders(notice.url),
      returnForStatus: isRefusal,
    });
    if (!full.ok) {
      const tripped = policy.record(host, true);
      if (tripped) logger(`  主机 ${host} 连续被拒 ${HOST_BLOCK_TRIP} 次，本轮不再请求它的附件`);
      await settle({
        status: 'blocked',
        kind,
        error: `整档请求 HTTP ${full.status}`,
        fetchedAt: new Date(),
      });
      return;
    }
    body = await readCappedBuffer(full, MAX_BYTES);
    tally.downloaded += 1;
  } catch (error) {
    policy.record(host, false);
    await settle({
      status: 'error',
      kind,
      error: `下载失败：${errorMessage(error)}`,
      fetchedAt: new Date(),
    });
    return;
  }

  // 哈希先算：一来解析器可能吃掉缓冲（parse.ts 里 pdfjs 那条就是），二来下面要用它判缓存。
  const contentHash = createHash('sha256').update(body).digest('hex');
  if (existing !== undefined && existing.status === 'ok' && existing.contentHash === contentHash) {
    // 刷新周期到了但文件没变：只续时间戳，不重解析、不改文本。这是「稳定附件实际约只取
    // 一次」与「每轮重下一遍」之间的分水岭。
    await settle({
      status: 'ok',
      kind,
      bytes: body.byteLength,
      contentHash,
      charCount: existing.charCount,
      extractedText: existing.extractedText,
      fetchedAt: new Date(),
    });
    return;
  }

  const parsed = await parseAttachment({ kind, body });
  tally.parsed += 1;
  if (parsed.status !== 'ok') {
    await settle({
      status: parsed.status,
      kind,
      bytes: body.byteLength,
      contentHash,
      error: parsed.error ?? '解析未产出文本',
      fetchedAt: new Date(),
    });
    return;
  }

  const cjk = countCjk(parsed.text);
  if (!hasDraftText(parsed.text)) {
    // 文本照样存：判据只是汉字数，留下原文才能让审计脚本复核这个判断对不对。
    await settle({
      status: 'no_draft_text',
      kind,
      bytes: body.byteLength,
      contentHash,
      charCount: cjk,
      extractedText: parsed.text,
      error: `抽出 ${cjk} 个汉字，低于条文阈值`,
      fetchedAt: new Date(),
    });
    return;
  }

  await settle({
    status: 'ok',
    kind,
    bytes: body.byteLength,
    contentHash,
    charCount: cjk,
    extractedText: parsed.text,
    fetchedAt: new Date(),
  });
}

export const extractAttachmentsJob: Job = {
  name: 'extract-attachments',
  description: '下载并解析随文附件，把条文文本存进 notice_attachments 供摘要使用（issue #57）',
  async run(ctx: JobContext): Promise<void> {
    if (!attachmentExtractionEnabled()) {
      ctx.logger(`ATTACHMENT_TEXT=${attachmentMode()}，本轮跳过附件抽取`);
      return;
    }
    const startedAt = ctx.now().getTime();
    const manifests = await listNoticesForAttachmentExtraction({ limit: NOTICES_PER_ROUND });
    const policy = new HostPolicy(HOST_INTERVAL_MS, HOST_BLOCK_TRIP);
    const tally: RoundTally = { downloaded: 0, parsed: 0, byStatus: new Map(), cjkChars: 0 };
    const eligibility = {
      now: ctx.now(),
      blockedRetryAfterDays: BLOCKED_RETRY_DAYS,
      maxAttempts: MAX_ATTEMPTS,
      refreshAfterDays: REFRESH_DAYS,
    };
    let noticesTouched = 0;

    outer: for (const manifest of manifests) {
      if (EXCLUDED_SOURCES.includes(manifest.sourceId) || manifest.attachments.length === 0) continue;
      // 清单每轮被 attachments_json 整体覆盖，所以先对齐表（新行 pending、撤下的删除），
      // 再决定哪些行本轮要处理。顺序不能反：反了会把刚撤下的附件当待处理项下一次。
      await syncAttachmentManifest({
        noticeId: manifest.id,
        attachments: manifest.attachments,
        now: ctx.now(),
      });
      const eligible = await listEligibleAttachments(manifest.id, eligibility);
      if (eligible.length === 0) continue;
      noticesTouched += 1;

      const wanted = selectAttachmentCandidates(manifest.attachments, MAX_FILES_PER_NOTICE).filter((candidate) =>
        eligible.some((row) => row.url === candidate.url),
      );
      for (const candidate of wanted) {
        if (tally.downloaded >= MAX_FILES_PER_ROUND) {
          ctx.logger(`本轮附件下载达到上限 ${MAX_FILES_PER_ROUND} 个，剩余留到下一轮`);
          break outer;
        }
        if (ctx.now().getTime() - startedAt > ROUND_BUDGET_MS) {
          ctx.logger(`本轮附件墙钟预算 ${Math.round(ROUND_BUDGET_MS / 60_000)} 分钟用完，剩余留到下一轮`);
          break outer;
        }
        const existing = eligible.find((row) => row.url === candidate.url);
        try {
          await extractOne(
            { id: manifest.id, url: manifest.url },
            { name: candidate.name, url: candidate.url },
            existing,
            policy,
            tally,
            ctx.logger,
          );
        } catch (error) {
          /**
           * 单个文件的处理失败**不能带走整轮**。
           *
           * 影子轮实测：一份 mee 的 PDF 抽出 8 个 U+0000，PostgreSQL 的 text 不收 NUL，
           * 那条 UPDATE 抛错 —— 当时没有这层隔离，任务直接中断，剩下几十条公示一轮白跑。
           * 写库失败连状态都记不上，但至少下一个文件还有机会；根因在 parse 侧清洗，
           * 这里是兜住「根因之外的第三种意外」。
           */
          tally.byStatus.set('error', (tally.byStatus.get('error') ?? 0) + 1);
          ctx.logger(`  附件处理异常（跳过该文件）：${candidate.url.slice(0, 90)} —— ${errorMessage(error)}`);
        }
      }
      // 本轮抽过正文的条目顺带重算体裁（issue #76）：修正案与新案要走不同的摘要模板，
      // 而"改了哪几处"这条判据只在正文里。失败不带走整轮 —— 判定晚了下一轮还会再来。
      try {
        await refreshNoticeGenreFromAttachments(manifest.id);
      } catch (error) {
        ctx.logger(`  体裁重算失败（留到下轮）：${manifest.id} —— ${errorMessage(error)}`);
      }
    }

    const statuses = [...tally.byStatus].map(([status, count]) => `${status}=${count}`).join(' ');
    ctx.logger(
      `附件抽取（${attachmentMode()}）本轮：处理 ${noticesTouched} 条公示 / 下载 ${tally.downloaded} 个` +
        ` / 解析 ${tally.parsed} 个 / 存 ${tally.cjkChars} 汉字` +
        `${statuses === '' ? '' : ` / ${statuses}`}` +
        ` / 用时 ${Math.round((ctx.now().getTime() - startedAt) / 1000)}s`,
    );
  },
};
