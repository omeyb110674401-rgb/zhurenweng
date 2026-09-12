import type { LlmPort, LlmSummarizeInput } from '../ports.ts';
import type { QuotedStructuredSummary, SummaryQuotes } from '../summary-content.ts';

/**
 * GLM 系列大模型适配器（issue #4）—— LlmPort 的生产实现，通过智谱开放平台
 * OpenAI 兼容的 chat/completions 端点生成五段式结构化摘要。
 *
 * 环境变量（均可在构造参数中覆盖，便于测试注入）：
 * - GLM_API_KEY   ：API 密钥（必填，缺失时构造即报错，快速暴露配置问题）；
 * - GLM_API_BASE  ：API 基址，默认 https://open.bigmodel.cn/api/paas/v4；
 * - GLM_MODEL     ：模型名，默认 glm-4-flash；
 * - GLM_TIMEOUT_MS：单次请求超时，默认 60000。
 *
 * 服务商切换：LLM_PROVIDER=glm 时由 src/lib/ports.ts 的 createLlmPort() 装配。
 * 模型被要求只输出 JSON；解析做防御性处理（剥离代码围栏、截取 JSON 主体），
 * 形状不合法一律抛错，由摘要任务按重试策略处理，绝不把脏数据落库。
 */

const DEFAULT_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_MODEL = 'glm-4-flash';
const DEFAULT_TIMEOUT_MS = 60_000;
/** 正文超过部分截断（国家级公示原文一般在数 KB 量级，上限防异常超大页面）。 */
const MAX_BODY_CHARS = 12_000;

const SYSTEM_PROMPT = [
  '你是政府公示信息解读助手。用户会给出一份政府公示/征求意见稿的标题与正文纯文本。',
  '请只输出一个 JSON 对象（不要输出任何解释、markdown 代码围栏或其他文字），字段如下：',
  '{"what":"这是什么：一句话概括这份公示是什么","who":"影响谁：受影响的公众/主体","keyPoints":["关键条款：2-5 条，每条概括一个关键条款"],"deadline":"截止日期：YYYY-MM-DD，原文未明确则为 null","howToComment":"如何提意见：指引用户到官方渠道提交意见","quotes":{"what":"what 对应的原文引用片段（逐字摘录原文，不超过100字）","who":"who 对应的原文引用片段","keyPoints":["每条关键条款对应的原文引用片段，顺序与 keyPoints 一致"],"deadline":"截止日期对应的原文引用片段","howToComment":"提意见方式对应的原文引用片段"}}',
  '要求：只依据给定原文，不编造；引用必须是原文的逐字连续片段；原文未提及的信息用空字符串或 null 表达，不得猜测。',
].join('\n');

export interface GlmLlmOptions {
  apiKey?: string;
  apiBase?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 解析模型输出的 JSON 文本（剥离 markdown 围栏、截取最外层 JSON 主体）。 */
export function parseModelJson(content: string): unknown {
  let text = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`GLM 输出中未找到 JSON 对象：${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new Error(
      `GLM 输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 校验并归一化模型输出的摘要 JSON；形状不合法抛错（由重试策略兜底）。 */
export function normalizeModelSummary(raw: unknown): QuotedStructuredSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('GLM 摘要输出不是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') {
      throw new Error(`GLM 摘要输出缺少字符串字段 "${key}"`);
    }
    return value.trim();
  };
  const keyPoints = record.keyPoints;
  if (!Array.isArray(keyPoints) || keyPoints.length === 0) {
    throw new Error('GLM 摘要输出缺少非空数组字段 "keyPoints"');
  }
  const points = keyPoints.map((point) => {
    if (typeof point !== 'string' || point.trim().length === 0) {
      throw new Error('GLM 摘要输出的 keyPoints 含空项');
    }
    return point.trim();
  });

  const deadlineRaw = record.deadline;
  let deadline: string | null = null;
  if (typeof deadlineRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw.trim())) {
    deadline = deadlineRaw.trim();
  }

  const quotes = readQuotes(record.quotes, points.length);
  return {
    what: text('what'),
    who: text('who'),
    keyPoints: points,
    deadline,
    howToComment: text('howToComment'),
    ...(quotes ? { quotes } : {}),
  };
}

function readQuotes(raw: unknown, pointCount: number): SummaryQuotes | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const quote = (key: string): string | null =>
    typeof record[key] === 'string' && (record[key] as string).trim().length > 0
      ? (record[key] as string).trim()
      : null;
  const keyPointQuotes = Array.isArray(record.keyPoints)
    ? record.keyPoints.map((item) => (typeof item === 'string' && item.trim().length > 0 ? item.trim() : null))
    : [];
  // 引用条数与关键条款对齐，缺省补 null
  while (keyPointQuotes.length < pointCount) keyPointQuotes.push(null);
  return {
    what: quote('what'),
    who: quote('who'),
    keyPoints: keyPointQuotes.slice(0, pointCount),
    deadline: quote('deadline'),
    howToComment: quote('howToComment'),
  };
}

function userPrompt(input: LlmSummarizeInput): string {
  const body =
    input.bodyText.length > MAX_BODY_CHARS
      ? `${input.bodyText.slice(0, MAX_BODY_CHARS)}…（正文过长已截断）`
      : input.bodyText;
  return [
    `标题：${input.title}`,
    `官方原文链接：${input.url}`,
    '正文纯文本：',
    body.length > 0 ? body : '（未抓取到正文，仅能基于标题判断）',
  ].join('\n');
}

export class GlmLlm implements LlmPort {
  readonly provider = 'glm';
  readonly model: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GlmLlmOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GLM_API_KEY ?? '';
    this.apiBase = (
      options.apiBase ?? process.env.GLM_API_BASE ?? DEFAULT_API_BASE
    ).replace(/\/+$/, '');
    this.model = options.model ?? process.env.GLM_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.GLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (this.apiKey.length === 0) {
      throw new Error(
        'GLM_API_KEY 未配置：LLM_PROVIDER=glm 需要在环境变量提供智谱开放平台 API Key（测试请用 LLM_PROVIDER=stub）',
      );
    }
  }

  async summarize(input: LlmSummarizeInput): Promise<QuotedStructuredSummary> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt(input) },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(
        `GLM API 请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GLM API HTTP ${response.status}：${body.slice(0, 200)}`);
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('GLM API 响应缺少 choices[0].message.content 文本');
    }
    return normalizeModelSummary(parseModelJson(content));
  }
}
