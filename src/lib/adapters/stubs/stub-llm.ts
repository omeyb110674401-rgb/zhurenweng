import fs from 'node:fs';
import path from 'node:path';
import type { LlmPort, LlmSummarizeInput, StructuredSummary } from '../../ports.ts';
import type { QuotedStructuredSummary, SummaryQuotes } from '../../summary-content.ts';

/**
 * stub LLM：LlmPort 的测试实现（ADR-0001 第 5 条）。
 * 返回固定结构化摘要 JSON（含原文引用片段），记录调用入参供测试断言；
 * 绝不发起网络请求。
 *
 * issue #4 扩展（向后兼容：不注入任何环境变量时行为与此前完全一致）：
 * - LLM_STUB_FAILURES=<n>：前 n 次调用抛错（验证重试）；LLM_STUB_FAILURES=always：
 *   每次调用都抛错（验证重试耗尽 → 待人工复核）；
 * - LLM_STUB_CALLS_FILE=<path>：每次调用追加一行 JSON（JSONL，含全局序号），
 *   供跨进程（worker 子进程）断言真实调用次数。
 */

/** stub 返回的固定摘要，是 E2E 场景断言的基准值。 */
export const STUB_SUMMARY: StructuredSummary = {
  what: '【stub】这是一份政府公示征求意见稿（固定测试摘要）。',
  who: '【stub】受该草案影响的公众与相关主体（固定测试文案）。',
  keyPoints: ['【stub】关键条款一', '【stub】关键条款二'],
  deadline: '2026-12-31',
  howToComment: '【stub】请前往官方原文页面按指引提交意见。',
};

/** stub 返回的各字段原文引用片段（issue #4；内容对应 fixtures/npc 快照原文）。 */
export const STUB_SUMMARY_QUOTES: SummaryQuotes = {
  what: '社会公开征求意见。',
  who: '国家建立基本医疗保险制度，保障公民在患病时获得基本医疗服务和物质帮助。',
  keyPoints: [
    '第一条　为了规范医疗保障关系，健全多层次医疗保障体系',
    '第二条　国家建立基本医疗保险制度',
  ],
  deadline: '征求意见截止日期：',
  howToComment: '登录中国人大网（www.npc.gov.cn）进入征求意见页面提交意见',
};

export interface StubLlmOptions {
  /** 注入失败：前 n 次调用抛错；'always' = 全部失败；0 / 缺省 = 永不失败。 */
  failures?: number | 'always';
  /** 每次调用追加一行 JSON 的文件路径；缺省仅记录在内存。 */
  callsFile?: string;
}

function failuresFromEnv(raw: string | undefined): number | 'always' {
  if (raw === undefined || raw === '') return 0;
  if (raw === 'always') return 'always';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`非法的 LLM_STUB_FAILURES "${raw}"（应为非负整数或 always）`);
  }
  return parsed;
}

export class StubLlm implements LlmPort {
  readonly provider = 'stub';

  private readonly calls: LlmSummarizeInput[] = [];
  private readonly failures: number | 'always';
  private readonly callsFile?: string;
  private callSeq = 0;

  constructor(options: StubLlmOptions = {}) {
    this.failures = options.failures ?? failuresFromEnv(process.env.LLM_STUB_FAILURES);
    this.callsFile = options.callsFile ?? (process.env.LLM_STUB_CALLS_FILE || undefined);
  }

  get callCount(): number {
    return this.calls.length;
  }

  /** 已收到的调用入参快照，供测试断言。 */
  receivedCalls(): LlmSummarizeInput[] {
    return this.calls.map((call) => ({ ...call }));
  }

  async summarize(input: LlmSummarizeInput): Promise<StructuredSummary> {
    this.calls.push({ ...input });
    this.callSeq += 1;
    this.appendCallLog(input);

    if (this.failures === 'always' || this.callSeq <= this.failures) {
      throw new Error(`【stub】注入的 LLM 调用失败（第 ${this.callSeq} 次，LLM_STUB_FAILURES=${this.failures}）`);
    }

    const summary: QuotedStructuredSummary = { ...STUB_SUMMARY, quotes: { ...STUB_SUMMARY_QUOTES } };
    return summary;
  }

  private appendCallLog(input: LlmSummarizeInput): void {
    if (!this.callsFile) return;
    fs.mkdirSync(path.dirname(path.resolve(this.callsFile)), { recursive: true });
    fs.appendFileSync(
      this.callsFile,
      `${JSON.stringify({ seq: this.callSeq, title: input.title, url: input.url })}\n`,
      'utf8',
    );
  }
}
