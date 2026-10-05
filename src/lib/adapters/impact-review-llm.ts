import type { ImpactReviewInput, ImpactReviewPort } from '../ports.ts';
import {
  ImpactReviewConfigError,
  ImpactReviewShapeError,
  ImpactReviewTransportError,
  isImpactReviewStatus,
  type ImpactReviewVerdict,
} from '../impact-review.ts';
import { IMPACT_REVIEW_SYSTEM_PROMPT, impactReviewUserPrompt } from '../impact-review-prompt.ts';
import { extraHeaders, stripJsonFence } from './openai-compatible-llm.ts';

/**
 * 审读端口接真实模型（issue #50）—— 走 OpenAI 兼容的 `/chat/completions`。
 *
 * ## 环境变量族是审读侧自己的
 *
 * `IMPACT_REVIEW_API_KEY` / `IMPACT_REVIEW_API_BASE` / `IMPACT_REVIEW_MODEL` /
 * `IMPACT_REVIEW_TIMEOUT_MS` / `IMPACT_REVIEW_EXTRA_HEADERS` —— **一个都不与生成侧的
 * `LLM_*` / `GLM_*` 共用**。"独立模型"这件事必须能从配置上看出来；共用变量的话，
 * 库里那条记录的 `model` 字段也说不清这一次是谁判的。独立性由
 * `ports.ts` 的 `impactReviewIndependence()` 核对（同端点/同 key 一律打回）。
 *
 * 境内厂商的兼容端点直接填 `IMPACT_REVIEW_API_BASE`（智谱 `https://open.bigmodel.cn/api/paas/v4`、
 * DeepSeek `https://api.deepseek.com/v1`、通义 `https://dashscope.aliyuncs.com/compatible-mode/v1`）。
 * **代码不猜厂商、也不猜默认模型**：三项缺一就抛配置错（与生成侧 `resolveOpenAiLlmConfig` 同规矩）。
 *
 * ## 失败分三类，因为处置完全不同
 *
 * - `ImpactReviewConfigError`：缺 key / base / model，或 base 不是合法 URL ⇒ **配置事故**；
 * - `ImpactReviewTransportError`：超时 / HTTP 非 2xx / 网络不通 ⇒ **不是模型的错**（重试、换端点）；
 * - `ImpactReviewShapeError`：回来了但读不出形状 ⇒ **提示词的活**（诊断里要看得到原始输出）。
 *
 * 三类都由 `reviewOutcomeOfError` 归成一格写进诊断 —— #50 的验收要求正是
 * "诊断里能区分'端口没跑'与'跑了但形状非法'"。
 */

/**
 * 缺省超时（毫秒）。
 *
 * **2026-10-05 按真实读数两次调整**：先是 60 秒 → 180 秒（审读侧这一档是**推理模型**），
 * 生产回填 11 条时 180 秒又不够了 —— 10 条通过、**1 条被超时掐断**
 * （`71738d1c`，报出来的是"读到一半就断了"，归 timeout 而不是形状错），
 * 换 300 秒重跑当场通过。推理长度一跑一变（实测 5.5k–12.8k token），
 * 所以缺省给到 300 秒；单条更慢的用 `IMPACT_REVIEW_TIMEOUT_MS` 再放宽。
 *
 * 为什么宁可等：审读不成 ⇒ 门 fail-closed ⇒ 这一条判读**不上页面**。等 5 分钟与丢一条
 * 读者本来就该看到的推断，代价不在一个量级。
 */
export const IMPACT_REVIEW_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * 审读请求的输出上限（token）。
 *
 * 为什么必须显式给一个：推理 token **计入同一个预算**。实测同一条请求
 * `deepseek-v4-pro` 花掉 12,824 个推理 token（合计 13,380），`deepseek-flash` 花掉 4,185–5,523 个；
 * 不给上限时（金丝雀第一跑）出现过"预算全被推理吃掉、`content` 是空串"的失败，
 * 而它报出来只是一个形状错。给 8192 之后同一条请求 61 秒、`finish_reason=stop`、正文完整。
 *
 * 它同时是**成本与延迟的闸**：上限就是最坏情况下的开销（推理模型会一直想到预算用完）。
 */
/**
 * 审读请求的**缺省**输出上限（token）。可经 `IMPACT_REVIEW_MAX_TOKENS` 覆盖。
 *
 * 为什么必须显式给一个：推理 token **与正文共用同一个预算**。2026-10-05 的真实金丝雀实测
 * 同一条请求（6 条判读）：
 *   · `deepseek-v4-pro` 12,824 个推理 token（合计 13,380）／`deepseek-flash` 3,387–5,523 个；
 *   · 给 8192 ⇒ `finish_reason=length`、推理正文吃掉全部预算、**`content` 是空串**（一跑一败）；
 *   · 给 16384 ⇒ 两次都 `stop`，正文完整（v4-pro 79 秒 / flash 17 秒）。
 * 推理长度**一跑一变**（5.5k–12.8k 都见过），所以这个数不能贴着实测最小值给 —— 而按
 * 缺省（不给上限）走时它会一路想到 13k+ token，又慢又贵。
 *
 * 它同时是**成本与延迟的闸**：上限就是最坏情况下的开销。撞上它的表现是自描述的
 * （`finish_reason=length，推理正文 N 字`），看到就把这个值调大。
 */
export const IMPACT_REVIEW_DEFAULT_MAX_TOKENS = 16_384;

/** 解析后的审读侧配置（构造端口与独立性核对共用一份口径）。 */
export interface ResolvedImpactReviewConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  headers: Record<string, string>;
  providerLabel: string;
}

function required(value: string | undefined, name: string, hint: string): string {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') {
    throw new ImpactReviewConfigError(`${name} 未配置：${hint}`);
  }
  return trimmed;
}

function timeoutOf(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return IMPACT_REVIEW_DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ImpactReviewConfigError(`IMPACT_REVIEW_TIMEOUT_MS 不是正数毫秒值：「${value}」`);
  }
  return parsed;
}

/**
 * 输出上限。可调的理由是实测出来的：推理长度一跑一变（5.5k–12.8k token），
 * 贴着下限给会随机丢掉整条审读 —— 那意味着这一条判读**不上页面**（门是 fail-closed 的）。
 */
function maxTokensOf(raw: string | undefined): number {
  const value = (raw ?? '').trim();
  if (value === '') return IMPACT_REVIEW_DEFAULT_MAX_TOKENS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ImpactReviewConfigError(`IMPACT_REVIEW_MAX_TOKENS 不是正整数：「${value}」`);
  }
  return parsed;
}

/** 解析审读侧配置（三项必填、缺一即抛；`apiBase` 必须是合法 URL）。 */
export function resolveImpactReviewConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedImpactReviewConfig {
  const apiBase = required(
    env.IMPACT_REVIEW_API_BASE,
    'IMPACT_REVIEW_API_BASE',
    '审读侧是独立的一路，必须显式给出端点（生成侧的 LLM_API_BASE 不许顶替）',
  );
  try {
    // 只校验形状：真正的网络问题由调用期报（这里提前失败能省下一轮摘要任务）
    new URL(apiBase);
  } catch {
    throw new ImpactReviewConfigError(`IMPACT_REVIEW_API_BASE 不是合法 URL：「${apiBase}」`);
  }
  return {
    apiKey: required(
      env.IMPACT_REVIEW_API_KEY,
      'IMPACT_REVIEW_API_KEY',
      '凭据经密钥脚本落 .env，不进仓库、不进对话',
    ),
    apiBase: apiBase.replace(/\/+$/, ''),
    model: required(env.IMPACT_REVIEW_MODEL, 'IMPACT_REVIEW_MODEL', '审读模型名（如 glm-4.5）'),
    timeoutMs: timeoutOf(env.IMPACT_REVIEW_TIMEOUT_MS),
    maxTokens: maxTokensOf(env.IMPACT_REVIEW_MAX_TOKENS),
    headers: extraHeaders(env.IMPACT_REVIEW_EXTRA_HEADERS),
    providerLabel: 'openai-compatible',
  };
}

export interface ImpactReviewLlmOptions extends ResolvedImpactReviewConfig {
  fetchImpl?: typeof fetch;
}

/**
 * 把模型输出解析成结论数组（**不发请求**，所以这一半可以单独测）。
 *
 * 三条判据，各对应一种真实故障：
 * 1. 没有 JSON 数组 / 不是合法 JSON ⇒ 抛形状错（诊断里带着原始输出）；
 * 2. 元素缺 `quote` 或 `text`（没有逐字回显）⇒ **丢掉那一条**：没有回显就无法与本仓手里的
 *    判读配对，留着它只会变成"挂不上的结论"；
 * 3. `status` 认不出 ⇒ **整份作废**。这一条是刻意的严格：状态是结论的核心，认不出它就等于
 *    不知道模型想说什么，而"部分采信"的后果是把它的一句话读成另一句 ——
 *    宁可这一轮没有记录（门翻转后 = 不渲染），也不要一句读错的合规结论。
 */
export function parseImpactReviewVerdicts(content: string): ImpactReviewVerdict[] {
  const text = stripJsonFence(content);
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end < start) {
    throw new ImpactReviewShapeError('审读响应里没有 JSON 数组', content);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new ImpactReviewShapeError(
      `审读响应不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      content,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ImpactReviewShapeError('审读响应不是数组', content);
  }

  const verdicts: ImpactReviewVerdict[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const quote = typeof row.quote === 'string' ? row.quote : '';
    const impactText = typeof row.text === 'string' ? row.text : '';
    if (quote === '' || impactText === '') continue;
    if (!isImpactReviewStatus(row.status)) {
      throw new ImpactReviewShapeError(
        `审读结论的状态认不出：「${String(row.status)}」（可选：passed | revised | rejected）`,
        content,
      );
    }
    verdicts.push({
      quote,
      text: impactText,
      status: row.status,
      revisedText: typeof row.revisedText === 'string' ? row.revisedText : null,
    });
  }
  return verdicts;
}

/** 兼容端点响应里我们用得上的那几格（其余一律不看）。 */
interface ChatCompletionPayload {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: { completion_tokens?: unknown };
}

/** 真实审读端口（OpenAI 兼容端点）。 */
export class OpenAiCompatibleImpactReview implements ImpactReviewPort {
  readonly provider: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ImpactReviewLlmOptions) {
    this.provider = options.providerLabel;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.apiBase = options.apiBase;
    this.timeoutMs = options.timeoutMs;
    this.maxTokens = options.maxTokens;
    this.headers = options.headers;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async review(input: ImpactReviewInput): Promise<ImpactReviewVerdict[]> {
    const startedAt = Date.now();
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
            { role: 'system', content: IMPACT_REVIEW_SYSTEM_PROMPT },
            {
              role: 'user',
              content: impactReviewUserPrompt({
                title: input.title,
                items: input.items.map((item) => ({
                  quote: item.quote,
                  who: item.who,
                  point: item.point,
                  text: item.text,
                  neighborhood: item.neighborhood,
                })),
              }),
            },
          ],
          // 审读要的是**稳定**：同一份判读两次判出不同结论，会让"重跑即失效"那条规矩失去意义
          temperature: 0,
          // 推理模型（DeepSeek 这一档）的推理 token 与正文共用这一个预算：不给上限会被推理吃光
          max_tokens: this.maxTokens,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const elapsedMs = Date.now() - startedAt;
      throw new ImpactReviewTransportError(
        `审读请求失败：${error instanceof Error ? error.message : String(error)}`,
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
        { elapsedMs },
      );
    }
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ImpactReviewTransportError(
        `审读端点 HTTP ${response.status}：${body.slice(0, 200)}`,
        'http',
        { raw: body, elapsedMs },
      );
    }

    /**
     * 先取**文本**再自己解析，不用 `response.json().catch(() => null)`。
     *
     * 那个写法会把两种处置完全相反的故障混成同一句"形状非法"：
     * ① 端点回了个非 JSON 的正文 ⇒ 提示词/端点的活；
     * ② 正文**读到一半断了**（超时或断网）⇒ 重试 / 调超时的活。
     *
     * 2026-10-05 的真实金丝雀正是在这里被误诊的：60 秒的超时把 `deepseek-v4-pro` 的长响应掐断，
     * `catch(() => null)` 把它吞成"缺少 choices[0].message.content"—— 看着像模型没吐东西，
     * 其实是我们的超时太短（那两个修复方向差得很远）。
     */
    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new ImpactReviewTransportError(
        `审读响应读到一半就断了：${error instanceof Error ? error.message : String(error)}`,
        name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network',
        { elapsedMs },
      );
    }

    let payload: ChatCompletionPayload | null = null;
    try {
      payload = JSON.parse(bodyText) as ChatCompletionPayload;
    } catch {
      throw new ImpactReviewShapeError(
        '审读响应不是合法 JSON',
        bodyText.slice(0, 500),
        elapsedMs,
      );
    }

    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      // 空正文必须说清"为什么空"：`finish_reason=length` 要去调输出上限，
      // 而"推理正文有、content 空"是推理模型的特征。只报一句"缺少文本"，
      // 下一个人会去改提示词 —— 方向完全错。
      const finishReason =
        typeof choice?.finish_reason === 'string' ? choice.finish_reason : '未知';
      const reasoningChars =
        typeof choice?.message?.reasoning_content === 'string'
          ? choice.message.reasoning_content.length
          : 0;
      const completionTokens =
        typeof payload?.usage?.completion_tokens === 'number'
          ? payload.usage.completion_tokens
          : null;
      throw new ImpactReviewShapeError(
        `审读响应缺少 choices[0].message.content 文本（finish_reason=${finishReason}，` +
          `推理正文 ${reasoningChars} 字` +
          `${completionTokens === null ? '' : `，completion_tokens=${completionTokens}`}）`,
        bodyText.slice(0, 500),
        elapsedMs,
      );
    }
    try {
      return parseImpactReviewVerdicts(content);
    } catch (error) {
      // 形状错要带上耗时（诊断里两件事都要有：说了什么 + 花了多久）
      if (error instanceof ImpactReviewShapeError) {
        throw new ImpactReviewShapeError(error.message, error.raw, elapsedMs);
      }
      throw error;
    }
  }
}

/** 按 `IMPACT_REVIEW_PROVIDER=openai-compatible` 从环境变量构造适配器。 */
export function createImpactReviewLlmFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleImpactReview {
  return new OpenAiCompatibleImpactReview(resolveImpactReviewConfig(env));
}
