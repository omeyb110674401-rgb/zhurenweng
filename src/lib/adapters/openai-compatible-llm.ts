import type { LlmPort, LlmSummarizeInput } from '../ports.ts';
import type { QuotedStructuredSummary, SummaryQuotes } from '../summary-content.ts';

/**
 * OpenAI 兼容 chat/completions 适配器（issue #25）—— LlmPort 的生产实现。
 *
 * 国内主流大模型平台（智谱 GLM、DeepSeek、通义、Kimi、多数聚合服务）都提供
 * OpenAI 兼容端点，差异只在「基址 + 密钥 + 模型名 + 少量请求头」。PRD 要求
 * 「调用已备案的国产大模型 API（默认 GLM 系列，**通过环境变量可切换服务商**）」，
 * 所以这里只实现一次协议，服务商由配置决定：
 *
 * - `LLM_PROVIDER=glm`（默认服务商，见 adapters/glm-llm.ts 预设）：
 *   `GLM_API_KEY` / `GLM_API_BASE` / `GLM_MODEL`，智谱默认基址与 glm-4-flash；
 * - `LLM_PROVIDER=openai`（通用）：`LLM_API_KEY` / `LLM_API_BASE` / `LLM_MODEL`
 *   —— 任何 OpenAI 兼容端点都能接，换模型不改代码；
 * - 两者都支持 `*_TIMEOUT_MS` 与通用 `LLM_EXTRA_HEADERS`（JSON 对象，额外请求头，
 *   用于要求客户端带会话头的网关，如 `{"x-session-id":"…"}`）。
 *
 * 配置解析只走 `resolveOpenAiLlmConfig` / `resolveGlmConfig` 两个**纯函数**：
 * 工厂（ports.ts）与可用性门控（lib/llm-availability.ts）调用同一个函数，
 * 于是「门控说可用 ⟺ 端口能构造」由结构保证，而不是靠两处手写口径保持一致
 * （issue #23 的教训：口径分家就会出现「界面在撒谎」或「功能被无谓隐藏」）。
 *
 * 模型被要求只输出 JSON；解析做防御性处理（剥离代码围栏、截取 JSON 主体），
 * 形状不合法一律抛错，由摘要任务按重试策略处理，绝不把脏数据落库。
 */

const DEFAULT_TIMEOUT_MS = 60_000;
/** 正文超过部分截断（国家级公示原文一般在数 KB 量级，上限防异常超大页面）。 */
const MAX_BODY_CHARS = 12_000;

/** 智谱开放平台默认基址与模型（glm 预设用）。 */
export const GLM_DEFAULT_API_BASE = 'https://open.bigmodel.cn/api/paas/v4';
export const GLM_DEFAULT_MODEL = 'glm-4-flash';

const SYSTEM_PROMPT = [
  '你是政府公示信息解读助手。用户会给出一份政府公示/征求意见稿的标题与正文纯文本。',
  '请只输出一个 JSON 对象（不要输出任何解释、markdown 代码围栏或其他文字），字段如下：',
  '{"what":"这是什么：一句话概括这份公示是什么","who":"影响谁：受影响的公众/主体","keyPoints":["关键条款：2-5 条，每条概括一个关键条款"],"deadline":"截止日期：YYYY-MM-DD，原文未明确则为 null","howToComment":"如何提意见：指引用户到官方渠道提交意见","quotes":{"what":"what 对应的原文引用片段（逐字摘录原文，不超过100字）","who":"who 对应的原文引用片段","keyPoints":["每条关键条款对应的原文引用片段，顺序与 keyPoints 一致"],"deadline":"截止日期对应的原文引用片段","howToComment":"提意见方式对应的原文引用片段"}}',
  '要求：只依据给定原文，不编造；引用必须是原文的逐字连续片段；原文未提及的信息用空字符串或 null 表达，不得猜测。',
].join('\n');

/** 已解析并校验通过的模型配置（工厂与门控共用）。 */
export interface ResolvedLlmConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
  /** 额外请求头（可为空对象）。 */
  headers: Record<string, string>;
  /** 上报名（notices.summary_model 与错误信息里用的服务商标识）。 */
  providerLabel: string;
}

export interface OpenAiCompatibleLlmOptions extends ResolvedLlmConfig {
  fetchImpl?: typeof fetch;
}

/** 按 `LLM_PROVIDER=glm`（智谱预设）从环境变量构造适配器。 */
export function createGlmLlmFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiCompatibleLlm {
  return new OpenAiCompatibleLlm(resolveGlmConfig(env));
}

/** 按 `LLM_PROVIDER=openai`（通用 OpenAI 兼容端点）从环境变量构造适配器。 */
export function createOpenAiLlmFromEnv(env: NodeJS.ProcessEnv = process.env): OpenAiCompatibleLlm {
  return new OpenAiCompatibleLlm(resolveOpenAiLlmConfig(env));
}

/**
 * 解析「通用 OpenAI 兼容」配置（`LLM_PROVIDER=openai`）：三项都必填 —— 通用端点
 * 没有可用的默认基址或默认模型，缺一项就说不清要调谁，因此缺失即抛错（快速暴露
 * 配置问题），而不是拿一个猜出来的默认值去发请求。
 */
export function resolveOpenAiLlmConfig(env: NodeJS.ProcessEnv = process.env): ResolvedLlmConfig {
  return {
    apiKey: required(env.LLM_API_KEY, 'LLM_API_KEY', 'openai'),
    apiBase: required(env.LLM_API_BASE, 'LLM_API_BASE', 'openai'),
    model: required(env.LLM_MODEL, 'LLM_MODEL', 'openai'),
    timeoutMs: timeoutOf(env.LLM_TIMEOUT_MS),
    headers: extraHeaders(env.LLM_EXTRA_HEADERS),
    providerLabel: 'openai',
  };
}

/** 解析智谱 GLM 预设配置（`LLM_PROVIDER=glm`，PRD 默认服务商）：只有 Key 必填。 */
export function resolveGlmConfig(env: NodeJS.ProcessEnv = process.env): ResolvedLlmConfig {
  return {
    apiKey: required(env.GLM_API_KEY, 'GLM_API_KEY', 'glm'),
    apiBase: optional(env.GLM_API_BASE) ?? GLM_DEFAULT_API_BASE,
    model: optional(env.GLM_MODEL) ?? GLM_DEFAULT_MODEL,
    timeoutMs: timeoutOf(env.GLM_TIMEOUT_MS),
    headers: {},
    providerLabel: 'glm',
  };
}

/** trim 后必须非空；缺失时报明确错误（含该服务商要设哪个变量）。 */
function required(value: string | undefined, name: string, provider: string): string {
  const trimmed = optional(value);
  if (trimmed === undefined) {
    throw new Error(
      `${name} 未配置：LLM_PROVIDER=${provider} 需要在环境变量提供该项（测试请用 LLM_PROVIDER=stub）`,
    );
  }
  return trimmed;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function timeoutOf(raw: string | undefined): number {
  const value = optional(raw);
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`LLM 超时不是正数毫秒值：「${value}」`);
  }
  return parsed;
}

/** `LLM_EXTRA_HEADERS`：JSON 对象（字符串值），非法即抛错（宁可构造期失败）。 */
export function extraHeaders(raw: string | undefined): Record<string, string> {
  const value = optional(raw);
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `LLM_EXTRA_HEADERS 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('LLM_EXTRA_HEADERS 应为 JSON 对象，如 {"x-session-id":"abc"}');
  }
  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof headerValue !== 'string') {
      throw new Error(`LLM_EXTRA_HEADERS 的 "${key}" 必须是字符串值`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

/** 解析模型输出的 JSON 文本（剥离 markdown 围栏、截取最外层 JSON 主体）。 */
export function parseModelJson(content: string): unknown {
  let text = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`模型输出中未找到 JSON 对象：${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new Error(
      `模型输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 校验并归一化模型输出的摘要 JSON；形状不合法抛错（由重试策略兜底）。 */
export function normalizeModelSummary(raw: unknown): QuotedStructuredSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('摘要输出不是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = record[key];
    if (typeof value !== 'string') {
      throw new Error(`摘要输出缺少字符串字段 "${key}"`);
    }
    return value.trim();
  };
  const keyPoints = record.keyPoints;
  if (!Array.isArray(keyPoints) || keyPoints.length === 0) {
    throw new Error('摘要输出缺少非空数组字段 "keyPoints"');
  }
  const points = keyPoints.map((point) => {
    if (typeof point !== 'string' || point.trim().length === 0) {
      throw new Error('摘要输出的 keyPoints 含空项');
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
    ? record.keyPoints.map((item) =>
        typeof item === 'string' && item.trim().length > 0 ? item.trim() : null,
      )
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

export class OpenAiCompatibleLlm implements LlmPort {
  readonly provider: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleLlmOptions) {
    // 配置一律在 resolve*Config 里 trim 并校验过；这里只做最后的兜底断言
    this.provider = options.providerLabel;
    this.apiKey = options.apiKey;
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.headers = options.headers;
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (this.apiKey.length === 0) {
      throw new Error('LLM API Key 为空：请配置密钥，或改用 LLM_PROVIDER=stub 跑测试');
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
          ...this.headers,
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
        `${this.provider} API 请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`${this.provider} API HTTP ${response.status}：${body.slice(0, 200)}`);
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error(`${this.provider} API 响应缺少 choices[0].message.content 文本`);
    }
    return normalizeModelSummary(parseModelJson(content));
  }
}
