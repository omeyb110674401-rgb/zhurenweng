import fs from 'node:fs';
import path from 'node:path';
import type {
  AmendmentExplanationDraft,
  AmendmentImpactDraft,
  LlmPort,
  LlmSummarizeInput,
  StructuredSummary,
} from '../../ports.ts';
import { explanationSectionLines } from '../../explanation-coverage.ts';
import { countChangeMarkers } from '../../change-coverage.ts';
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

/**
 * stub 返回的固定摘要，是 E2E 场景断言的基准值。
 * issue #55 起为「参与导引」形状：没有 keyPoints（公告壳里本来就没有条款），
 * 多出来的是谁能提 / 逾期会怎样 / 可操作的渠道清单。
 */
export const STUB_SUMMARY: StructuredSummary = {
  what: '【stub】这是一份政府公示征求意见稿（固定测试摘要）。',
  who: '【stub】受该草案影响的公众与相关主体（固定测试文案）。',
  whoCanSubmit: '【stub】社会各界均可就草案提出意见（固定测试文案）。',
  afterDeadline: '【stub】逾期未反馈将视为无意见（固定测试文案）。',
  deadline: '2026-12-31',
  howToComment: '【stub】请前往官方原文页面按指引提交意见。',
  channels: [
    { kind: 'online', value: 'www.npc.gov.cn' },
    { kind: 'email', value: 'yjzj@npc.gov.cn' },
  ],
};

/** stub 返回的各字段原文引用片段（issue #4；内容对应 fixtures/npc 快照原文）。 */
export const STUB_SUMMARY_QUOTES: SummaryQuotes = {
  what: '社会公开征求意见。',
  who: '国家建立基本医疗保险制度，保障公民在患病时获得基本医疗服务和物质帮助。',
  whoCanSubmit: '征求社会各界意见',
  afterDeadline: '意见反馈截止日期为',
  deadline: '征求意见截止日期：',
  howToComment: '登录中国人大网（www.npc.gov.cn）进入征求意见页面提交意见',
  channels: [
    '登录中国人大网（www.npc.gov.cn）进入征求意见页面提交意见',
    '或通过电子邮件寄送',
  ],
};

export interface StubLlmOptions {
  /** 注入失败：前 n 次调用抛错；'always' = 全部失败；0 / 缺省 = 永不失败。 */
  failures?: number | 'always';
  /** 每次调用追加一行 JSON 的文件路径；缺省仅记录在内存。 */
  callsFile?: string;
}

function failuresFromEnv(raw: string | undefined): number | 'always' {  if (raw === undefined || raw === '') return 0;
  if (raw === 'always') return 'always';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`非法的 LLM_STUB_FAILURES "${raw}"（应为非负整数或 always）`);
  }
  return parsed;
}

/** 该份条文里第一个非空行 —— stub 的「逐字引用」取值，保证引用一定能在条文里找到。 */
function firstLineOf(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line ?? '';
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
    // 附件条文决定 stub 是否产出条文要点（issue #57 第 5 步）—— 这不是为了模仿模型行为，
    // 而是让「同一份夹具、档位不同 ⇒ 摘要内容不同」这件事可被 e2e 断言。
    // 没有这条回响，`shadow` 与 `on` 在两档下会得到逐字相同的摘要，档位就还是个幽灵旋钮。
    // 引用的取值刻意**逐字来自条文本身**（取该份条文的首个非空行），这样详情页的
    // 出处反查（哪条要点来自哪个附件）在测试里走的是真实路径。
    const draft = input.draftSources ?? [];
    if (draft.length > 0) {
      const quotes = draft.map((source) => firstLineOf(source.text));
      summary.keyPoints = draft.map(
        (source, index) => `【stub】条文要点 ${index + 1}：${quotes[index]}`,
      );
      summary.quotes = { ...summary.quotes, keyPoints: quotes };
    }
    // 说明小节（issue #76 第 3 刀）：只从 role=explanation 的附件里取，quote 直接用该小节
    // 标题那一行（逐字）—— 于是"说明要点必须能在说明里反查到"这条不变量在测试里走真路径。
    const explained = draft.filter((source) => source.role === 'explanation');
    if (explained.length > 0) {
      const points: AmendmentExplanationDraft[] = [];
      for (const source of explained) {
        for (const heading of explanationSectionLines(source.text).slice(0, 6)) {
          points.push({
            heading,
            text: `【stub】小节「${heading}」的主要内容（固定测试文案）。`,
            quote: heading,
          });
        }
      }
      if (points.length > 0) summary.explanationPoints = points;
    }
    // 影响判读（issue #86 第 1 刀）：与条文要点同一套路 —— quote **逐字**取附件里的整行
    // （挑第一行够长的，短行过不了反查的 8 字下限），于是"每条判读都要能反查到出处"
    // 这条不变量在测试里走的是真路径。每份附件最多一条，免得 stub 硬造出一屏判读。
    if (draft.length > 0) {
      const impacts: AmendmentImpactDraft[] = [];
      for (const source of draft) {
        const line = source.text
          .split('\n')
          .map((item) => item.trim())
          .find((item) => item.length >= 12);
        if (line === undefined) continue;
        impacts.push({
          quote: line,
          who: `【stub】受《${source.name.slice(0, 12)}》影响的从业者与公众（固定测试文案）`,
          text: `【stub】这一处可能带来的影响（固定测试文案）：${line.slice(0, 16)}…`,
          kind: impacts.length === 0 ? 'risk' : 'loophole',
        });
      }
      if (impacts.length > 0) summary.impacts = impacts;
    }
    // 改动点（issue #86 第 2 刀）：只在附件里真的出现**可计数的**改动表述时才回响
    // （`countChangeMarkers` —— 与页面那行覆盖度用的是同一个判据，所以 stub 回响的行数
    // 与分母同源，不会出现"分母数不到、表里却有"的假象）。quote 逐字取那一整行，
    // 于是"表格里每一行都能反查到原文"在测试里走的是真路径。
    if (draft.length > 0) {
      const lines = draft
        .flatMap((source) => source.text.split('\n').map((line) => line.trim()))
        .filter((line) => line.length > 8 && countChangeMarkers(line).total > 0)
        .slice(0, 3);
      if (lines.length > 0) {
        summary.changes = lines.map((line, index) => ({
          clause: `【stub】第 ${index + 1} 处`,
          kind: line.includes('删去') ? 'delete' : line.includes('增加一条') ? 'add' : 'modify',
          text: `【stub】改动 ${index + 1}：${line.slice(0, 18)}…`,
          quote: line,
        }));
      }
    }
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
