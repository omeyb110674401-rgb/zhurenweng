import type { LlmPort, LlmSummarizeInput, StructuredSummary } from '../../ports.ts';

/**
 * stub LLM：LLMPort 的测试实现（ADR-0001 第 5 条）。
 * 返回固定结构化摘要 JSON，记录调用入参供测试断言；绝不发起网络请求。
 */

/** stub 返回的固定摘要，是 E2E 场景断言的基准值。 */
export const STUB_SUMMARY: StructuredSummary = {
  what: '【stub】这是一份政府公示征求意见稿（固定测试摘要）。',
  who: '【stub】受该草案影响的公众与相关主体（固定测试文案）。',
  keyPoints: ['【stub】关键条款一', '【stub】关键条款二'],
  deadline: '2026-12-31',
  howToComment: '【stub】请前往官方原文页面按指引提交意见。',
};

export class StubLlm implements LlmPort {
  readonly provider = 'stub';

  private readonly calls: LlmSummarizeInput[] = [];

  get callCount(): number {
    return this.calls.length;
  }

  /** 已收到的调用入参快照，供测试断言。 */
  receivedCalls(): LlmSummarizeInput[] {
    return this.calls.map((call) => ({ ...call }));
  }

  async summarize(input: LlmSummarizeInput): Promise<StructuredSummary> {
    this.calls.push({ ...input });
    return { ...STUB_SUMMARY };
  }
}
