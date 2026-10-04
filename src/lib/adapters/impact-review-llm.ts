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

/** 缺省超时（毫秒）。审读是同步链路的一环，不能像摘要那样慢：给 60 秒。 */
export const IMPACT_REVIEW_DEFAULT_TIMEOUT_MS = 60_000;

/** 解析后的审读侧配置（构造端口与独立性核对共用一份口径）。 */
export interface ResolvedImpactReviewConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
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

/** 真实审读端口（OpenAI 兼容端点）。 */
export class OpenAiCompatibleImpactReview implements ImpactReviewPort {
  readonly provider: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ImpactReviewLlmOptions) {
    this.provider = options.providerLabel;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.apiBase = options.apiBase;
    this.timeoutMs = options.timeoutMs;
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

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new ImpactReviewShapeError(
        '审读响应缺少 choices[0].message.content 文本',
        '',
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
