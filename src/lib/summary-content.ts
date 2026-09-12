import type { LlmPort, StructuredSummary } from './ports.ts';

/**
 * AI 摘要的领域形状（issue #4）—— worker 落库（notices.ai_summary_json /
 * summary_status）与详情页渲染共用；与具体 LLM 服务商解耦。
 *
 * 设计说明：`LlmPort.summarize()` 的返回类型保持 ports.ts 里的扁平
 * `StructuredSummary`（该文件是并行切片共享的接缝，不做结构改动）；
 * 原文引用片段（PRD：每个字段附原文引用）由适配器以可选的 `quotes`
 * 扩展属性携带（见 `QuotedStructuredSummary`），摘要任务统一归一化为
 * `QuotedSummary` 落库 —— 不返回 quotes 的适配器（或某字段缺引用）落库为
 * quote = null，详情页对该段隐藏引用块。
 */

/** 摘要状态（notices.summary_status） */
export type SummaryStatus = 'pending' | 'done' | 'failed_review';

/** 详情页占位文案：done 渲染摘要本体，pending / failed_review 显示占位 */
export const SUMMARY_STATUS_LABELS: Record<SummaryStatus, string> = {
  pending: '摘要生成中',
  done: '摘要已生成',
  failed_review: '摘要生成中（待人工复核）',
};

/** 单个摘要段落：摘要文本 + 原文引用片段（quote 为官方原文中的原句摘录） */
export interface SummarySection {
  text: string;
  quote: string | null;
}

/** 截止日期段落：原文未提及时 text 为 null */
export interface SummaryDeadlineSection {
  text: string | null;
  quote: string | null;
}

/**
 * ai_summary_json 的落库形状：五段式（这是什么 / 影响谁 / 关键条款 /
 * 截止日期 / 如何提意见），每段附原文引用片段。
 */
export interface QuotedSummary {
  what: SummarySection;
  who: SummarySection;
  keyPoints: SummarySection[];
  /** deadline.text 为 ISO 日期（YYYY-MM-DD）或 null */
  deadline: SummaryDeadlineSection;
  howToComment: SummarySection;
}

/** 适配器可选携带的各字段原文引用片段（与 StructuredSummary 字段一一对应） */
export interface SummaryQuotes {
  what?: string | null;
  who?: string | null;
  keyPoints?: (string | null)[];
  deadline?: string | null;
  howToComment?: string | null;
}

/** LLM 适配器可返回的扩展形状：在 StructuredSummary 之上附带原文引用 */
export interface QuotedStructuredSummary extends StructuredSummary {
  quotes?: SummaryQuotes;
}

/** 单段引用片段的长度上限：超过视为异常输出，丢弃（引用应是短摘录）。 */
const MAX_QUOTE_LENGTH = 300;

/** 清洗引用片段：去首尾空白与包裹引号；空串或超长返回 null。 */
function cleanQuote(quote: string | null | undefined): string | null {
  if (typeof quote !== 'string') return null;
  const trimmed = quote.trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (trimmed.length === 0 || trimmed.length > MAX_QUOTE_LENGTH) return null;
  return trimmed;
}

/**
 * 把 LLM 返回的扁平摘要 + 可选引用归一化为落库形状。
 * 字段缺失 / 类型异常时保守兜底，保证落库 JSON 永远符合 QuotedSummary 形状。
 */
export function buildQuotedSummary(
  summary: StructuredSummary,
  quotes?: SummaryQuotes,
): QuotedSummary {
  const keyPoints = Array.isArray(summary.keyPoints) ? summary.keyPoints : [];
  const quotePoints = Array.isArray(quotes?.keyPoints) ? (quotes.keyPoints as (string | null)[]) : [];
  const text = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

  return {
    what: { text: text(summary.what), quote: cleanQuote(quotes?.what) },
    who: { text: text(summary.who), quote: cleanQuote(quotes?.who) },
    keyPoints: keyPoints.map((point, index) => ({
      text: text(point),
      quote: cleanQuote(quotePoints[index]),
    })),
    deadline: {
      text:
        summary.deadline === null || summary.deadline === undefined
          ? null
          : text(summary.deadline) || null,
      quote: cleanQuote(quotes?.deadline),
    },
    howToComment: { text: text(summary.howToComment), quote: cleanQuote(quotes?.howToComment) },
  };
}

/**
 * 安全校验 ai_summary_json（详情页渲染前的防御性解析）：
 * 形状不符合 QuotedSummary 时返回 null，页面回退到占位文案，绝不让
 * 脏数据抛错打断渲染。
 */
export function parseQuotedSummary(value: unknown): QuotedSummary | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  const section = (raw: unknown): SummarySection | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.text !== 'string') return null;
    return {
      text: item.text,
      quote: typeof item.quote === 'string' && item.quote.length > 0 ? item.quote : null,
    };
  };

  // 截止日期段落的 text 允许为 null（原文未提及时）
  const deadlineSection = (raw: unknown): SummaryDeadlineSection | null => {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (item.text !== null && typeof item.text !== 'string') return null;
    return {
      text: typeof item.text === 'string' ? item.text : null,
      quote: typeof item.quote === 'string' && item.quote.length > 0 ? item.quote : null,
    };
  };

  const what = section(record.what);
  const who = section(record.who);
  const deadline = deadlineSection(record.deadline);
  const howToComment = section(record.howToComment);
  if (!what || !who || !deadline || !howToComment) return null;
  if (!Array.isArray(record.keyPoints)) return null;
  const keyPoints: SummarySection[] = [];
  for (const raw of record.keyPoints) {
    const point = section(raw);
    if (!point) return null;
    keyPoints.push(point);
  }

  return { what, who, keyPoints, deadline, howToComment };
}

/**
 * 摘要模型名（notices.summary_model）：适配器可用 `model` 扩展属性上报
 * 具体模型（如 GLM_MODEL 的值），未上报时退回 provider 名（stub → 'stub'）。
 */
export function llmModelName(llm: LlmPort): string {
  const candidate = (llm as { model?: unknown }).model;
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    return candidate.trim();
  }
  return llm.provider;
}
