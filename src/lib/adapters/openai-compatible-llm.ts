import type { LlmPort, LlmSummarizeInput, SummaryChannel, SummaryChannelKind } from '../ports.ts';
import {
  SUMMARY_CHANNEL_KINDS,
  type QuotedStructuredSummary,
  type SummaryQuotes,
} from '../summary-content.ts';

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

/**
 * 提示词（issue #55 重构为「参与导引」口径）。
 *
 * 为什么不再要「关键条款」：生产实测抓取到的正文均值 443 字，是「谁、就哪个文件、
 * 征求到什么时候、通过什么方式反馈」的公告壳，草案条文与标准文本在**附件**里
 * （77 条未截止条目中 65 条带附件清单）。让模型从壳里「概括 2-5 条关键条款」，
 * 它只能把「公示期 30 日」「可邮件反馈」重排成看着像条款的句子 —— 输入里没有的东西，
 * 再怎么收口措辞都变不出来，反而会诱导编造。所以这一段删掉，改为只问公告里真实存在的
 * 参与信息，并明确禁止条文式输出。
 *
 * 逐字引用的要求原样保留（PRD：引用可核对），渠道清单同样每项配一段原文。
 */
const SYSTEM_PROMPT = [
  '你是政府公示的「参与导引」助手。用户会给出一份公示的标题与网页正文纯文本。',
  '重要背景：这类页面的正文通常只是公告本身，真正的草案条文、标准文本、名单在附件里，不在给你的文本中。',
  '因此：不要编写、推测或概括任何「条款内容」，只回答公告里真实存在的参与信息。',
  '请只输出一个 JSON 对象（不要输出任何解释、markdown 代码围栏或其他文字），字段如下：',
  '{"what":"这是什么：一句话概括这份公示在做什么，40 字以内","who":"影响谁：受这份文件影响的具体主体（如运输机场运营人、医疗器械注册人、标准起草单位），不要只写社会公众","whoCanSubmit":"谁能提：原文写明的可提出意见的主体或范围；原文未提及则留空字符串","afterDeadline":"逾期会怎样：原文写明超过截止日期后如何处理（如逾期视为无意见、不再受理）；原文未提及则留空字符串","deadline":"截止日期：YYYY-MM-DD，原文未明确则为 null","howToComment":"如何提意见：一句话概述提交途径，40 字以内","channels":[{"kind":"email|phone|mail|online|other","value":"可直接使用的具体值"}],"quotes":{"what":"what 对应的原文引用片段（逐字摘录，不超过100字）","who":"who 对应的原文引用片段","whoCanSubmit":"谁能提对应的原文片段，没有则空字符串","afterDeadline":"逾期会怎样对应的原文片段，没有则空字符串","deadline":"截止日期对应的原文引用片段","howToComment":"如何提意见对应的原文引用片段","channels":["每条渠道对应的原文片段，顺序与 channels 严格一致"]}}',
  '要求：',
  '1. 只依据给定原文，不编造、不猜测；原文没有的字段留空字符串或 null，宁可留空也不要凑。',
  '2. 引用必须是原文中的逐字连续片段。',
  '3. channels 的 value 只放地址本身（如 xxx@yyy.gov.cn、010-6601xxxx、含邮编的邮寄地址、网址），说明性文字放 howToComment；一份公示常同时给邮件、信函、传真、网址几种渠道，应全部列出。',
  '4. channels 没有可列的渠道时输出空数组。',
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

/**
 * 校验并归一化模型输出的摘要 JSON；形状不合法抛错（由摘要任务的重试策略兜底）。
 *
 * 三条有意的规则：
 * 1. **必填三段必须非空** —— 此前只校验「是不是字符串」，于是 `"who": ""` 也能落库，
 *    页面上「影响谁」标题下面空无一物（生产实测 mimo-v2.5 有 1 条这样，glm 0 条）。
 *    答不上就抛错，交给重试 / 转人工复核，比留一个空段落诚实。
 *    不合格时**一次报全三段**并分开写清是缺字段、值不是字符串还是空串：三者的成因
 *    与处置完全不同，合成一句就会把「校验器按顺序先撞上哪个」误读成「只有那个字段
 *    有问题」（issue #56 的 30% 失败率就是这么被误判成模型抖动的）。
 * 2. 原文可能确实没有的段（谁能提 / 逾期会怎样）缺省为空串，不算形状异常 ——
 *    把它们变成必填只会逼模型编一句。
 * 3. 渠道数组**一项都不删**：`quotes.channels` 按原始下标与渠道配对，这里删一项
 *    就会让后面的渠道挂上前面的引用。去空 / 去重 / 截断统一由 buildQuotedSummary
 *    里的 normalizeChannels 在配好引用之后做。
 */
export function normalizeModelSummary(raw: unknown): QuotedStructuredSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('摘要输出不是 JSON 对象');
  }
  const record = raw as Record<string, unknown>;

  /** 值不合格的原因；合格（非空字符串）时返回 null。三种故障分开说。 */
  const shapeProblem = (value: unknown): string | null => {
    if (value === undefined) return '缺字段';
    if (value === null) return '值是 null';
    if (typeof value !== 'string') {
      return `值不是字符串（${Array.isArray(value) ? 'array' : typeof value}）`;
    }
    return value.trim() === '' ? '空串' : null;
  };

  const problems: string[] = [];
  const take = (key: 'what' | 'who' | 'howToComment'): string => {
    const value = record[key];
    const problem = shapeProblem(value);
    if (problem !== null) {
      problems.push(`"${key}" ${problem}`);
      return '';
    }
    return (value as string).trim();
  };
  const what = take('what');
  const who = take('who');
  const howToComment = take('howToComment');
  if (problems.length > 0) {
    throw new Error(`摘要输出的必填段不合格：${problems.join('、')}`);
  }

  const optionalText = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
  };

  const deadlineRaw = record.deadline;
  let deadline: string | null = null;
  if (typeof deadlineRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw.trim())) {
    deadline = deadlineRaw.trim();
  }

  const rawChannels = Array.isArray(record.channels) ? record.channels : [];
  const channels: SummaryChannel[] = rawChannels.map((raw) => {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const kind = typeof item.kind === 'string' ? item.kind.trim() : '';
    return {
      kind: (SUMMARY_CHANNEL_KINDS as readonly string[]).includes(kind)
        ? (kind as SummaryChannelKind)
        : 'other',
      value: typeof item.value === 'string' ? item.value.trim() : '',
    };
  });

  const quotes = readQuotes(record.quotes);
  return {
    what,
    who,
    whoCanSubmit: optionalText('whoCanSubmit'),
    afterDeadline: optionalText('afterDeadline'),
    deadline,
    howToComment,
    channels,
    ...(quotes ? { quotes } : {}),
  };
}

/** 读取模型输出的 quotes 扩展；不是对象则返回 undefined（该适配器不提供引用时同样成立） */
function readQuotes(raw: unknown): SummaryQuotes | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const quote = (key: string): string | null =>
    typeof record[key] === 'string' && (record[key] as string).trim().length > 0
      ? (record[key] as string).trim()
      : null;
  const channelQuotes = Array.isArray(record.channels)
    ? record.channels.map((item) =>
        typeof item === 'string' && item.trim().length > 0 ? item.trim() : null,
      )
    : undefined;
  return {
    what: quote('what'),
    who: quote('who'),
    whoCanSubmit: quote('whoCanSubmit'),
    afterDeadline: quote('afterDeadline'),
    deadline: quote('deadline'),
    howToComment: quote('howToComment'),
    ...(channelQuotes ? { channels: channelQuotes } : {}),
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
