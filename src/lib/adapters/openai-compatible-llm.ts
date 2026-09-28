import type {
  AmendmentChangeDraft,
  AmendmentExplanationDraft,
  AmendmentImpactDraft,
  DraftSource,
  ImpactKind,
  LlmPort,
  LlmSummarizeInput,
  SummaryChannel,
  SummaryChannelKind,
} from '../ports.ts';
import { SUMMARY_TIERS } from '../attachment-feed.ts';
import { CHANGE_KINDS, type ChangeKind } from '../change-coverage.ts';
import {
  SUMMARY_CHANNEL_KINDS,
  type QuotedStructuredSummary,
  type SummaryQuotes,
} from '../summary-content.ts';
import {
  LlmResponseError,
  SUMMARY_DIAGNOSTICS_VERSION,
  capRawOutput,
  emptyDroppedCounts,
  emptyFieldCounts,
  type SummaryDiagnostics,
  type SummaryDroppedCounts,
  type SummaryFieldCounts,
  type SummaryTokenUsage,
} from '../summary-diagnostics.ts';

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
/** 条文要点条数上限：提示词要 2-4 条，给一点余量；再多就是模型在凑数而不是在摘录。 */
const MAX_KEY_POINTS = 6;

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
 *
 * 「影响谁」为什么是**可缺段**（issue #56 第八节的实测）：这一段要的是「受这份文件影响的
 * 具体主体」，而公告壳里没有这句话 —— 它在附件的草案里。把它列为必填的两种下场都测到了：
 * 模型要么按「宁可留空也不要凑」返回空串（整条作废转人工复核，第一轮 15/50 条就是这么掉的），
 * 要么把壳里的「有关单位和公众 / 社会公众」填进来（35 条成功摘要里 26 条如此，正是提示词
 * 原本禁止写泛称的那类答案）。前者诚实但失败，后者通过但答非所问，且与「谁能提」重复。
 * 现在明确写成可缺段，并要求泛称留空。
 */
const SYSTEM_PROMPT = [
  '你是政府公示的「参与导引」助手。用户会给出一份公示的标题与网页正文纯文本，可能还会附上本站从该公示官方文档里提取的「附件条文」。',
  '重要背景：网页正文通常只是公告本身；草案条文、标准文本、名单在**附件**里，只有给了「附件条文」段落时你才真的看得到它们。',
  '因此：没有「附件条文」段落时，不要编写、推测或概括任何「条款内容」，只回答公告里真实存在的参与信息。',
  '请只输出一个 JSON 对象（不要输出任何解释、markdown 代码围栏或其他文字），字段如下：',
  '{"what":"这是什么：一句话概括这份公示在做什么，40 字以内","who":"影响谁：只有原文明确写出受这份文件影响的主体时才写（如运输机场运营人、医疗器械注册人、标准起草单位）；原文只写「社会公众」「有关单位和个人」这类泛称时**留空字符串** —— 那是「谁能提」，不是「影响谁」。这类页面的正文通常不含受影响主体（它在附件的草案里），宁可留空也不要推断","whoCanSubmit":"谁能提：原文写明的可提出意见的主体或范围；原文未提及则留空字符串","afterDeadline":"逾期会怎样：原文写明超过截止日期后如何处理（如逾期视为无意见、不再受理）；原文未提及则留空字符串","keyPoints":["草案条文要点：仅当给出「附件条文」时填写，2-4 条从条文中读到的实质规定，每条一句话、40 字以内；没有附件条文段落时必须为空数组"],"explanationPoints":[{"heading":"照抄说明里的小节标题（如 一、项目概况）","text":"这一节说了什么：一句话，60 字以内","quote":"这一节的逐字原文，200 字以内"}],"impacts":[{"quote":"这一条/这一处的逐字原文（中间可以省略，但每一截都要逐字对得上）","who":"具体可能受影响的主体，写不出就留空字符串","text":"可能带来什么：一句话，60 字以内","kind":"risk|loophole|burden"}],"changes":[{"clause":"被改条款标识，照抄原文写法（如 第三十六条 / 附录A）","kind":"modify|add|delete|renumber|other","text":"这一处改了什么：一句话，40 字以内","quote":"描述这处改动的逐字原文，160 字以内"}],"deadline":"截止日期：YYYY-MM-DD，原文未明确则为 null","howToComment":"如何提意见：一句话概述提交途径，40 字以内","channels":[{"kind":"email|phone|mail|online|other","value":"可直接使用的具体值"}],"quotes":{"what":"what 对应的原文引用片段（逐字摘录，不超过100字）","who":"who 对应的原文引用片段，留空时空字符串","whoCanSubmit":"谁能提对应的原文片段，没有则空字符串","afterDeadline":"逾期会怎样对应的原文片段，没有则空字符串","keyPoints":["与 keyPoints 一一对应的逐字条文原文，顺序严格一致，没有则为 null"],"deadline":"截止日期对应的原文引用片段","howToComment":"如何提意见对应的原文引用片段","channels":["每条渠道对应的原文片段，顺序与 channels 严格一致"]}}',
  '要求：',
  '1. 只依据给定原文，不编造、不猜测；原文没有的字段留空字符串或 null，宁可留空也不要凑。',
  '2. 引用必须是原文中的逐字连续片段。',
  '3. channels 的 value 只放地址本身（如 xxx@yyy.gov.cn、010-6601xxxx、含邮编的邮寄地址、网址），说明性文字放 howToComment；一份公示常同时给邮件、信函、传真、网址几种渠道，应全部列出。',
  '4. channels 没有可列的渠道时输出空数组。',
  '5. keyPoints 是这份计划里**唯一**允许写条文内容的段落，它的依据只能是「附件条文」段落：',
  '   - 每条要点都要在 quotes.keyPoints 给出对应的逐字条文原句（同一下标配对，错配比留空更糟）；',
  '   - 附件条文可能只是草案的一部分（本站按字数预算截取），因此只写你确实在文本里读到的规定，不要用「规定了」「明确了」去概括看不到的部分；',
  '   - 受影响主体（who）往往写在条文里（如「中华人民共和国境内的某某企业从事下列活动…」），给了条文时 who 可以据实填写，其引用取自条文。',
  '6. explanationPoints 只依据「编制说明」段落（说明讲为什么制定、依据什么、主要改了什么、向谁征求意见，不是规定本身）：heading 照抄该小节自己的标题，引用只能取自说明段落；keyPoints 的引用只能取自条文段落 —— 本站按段落分别反查，串了整条丢弃。说明里没有分层小标题时输出空数组，不要自己造小节名。',
  '7. impacts 是**唯一允许推断**的一段，其余各段只许照抄。用户要的正是它："让读者发现对自己和社会有影响的条例，识别修订后的不利影响和可能的漏洞"。所以它的口径比别处严：',
  '   - 每项都要带 quote，且 quote 必须是给定原文里的**逐字片段**（中间可以省略，但每一截都要逐字对得上）：本站拿它反查出处，反查不到的整项丢弃；',
  '   - who 写**具体可能受影响的主体**（如「需要无犯罪记录证明的用人单位」「以车辆通行费筹集养护资金的地方政府」）；写不出具体主体就留空字符串，不要写「社会公众」「人民群众」；',
  '   - text 只写这一条**可能**带来什么，一句话、60 字以内。**不做定性、不指控、不预测结果**：不写「违法」「违宪」「必将」「必然导致」，也不点名任何机关或个人；',
  '   - kind 三选一：risk 可能的不利后果 / loophole 可能被规避、滥用或执行不到的地方 / burden 新增的义务、成本或门槛；',
  '   - **看不出影响就输出空数组**。把条文复述一遍（「规定了…」「明确了…」）不算影响，宁可空着；',
  '   - 这一段不要求你下结论，只要求你把「哪条原文 + 谁可能受影响 + 可能是什么」如实摆出来，让读者自己判断。',
  '8. changes 回答"这一稿把哪几条改成了什么"（**事实**，与 impacts 的"可能意味着什么"是两回事）：',
  '   - 每项都要带 quote，且 quote 必须是给定原文里的**逐字片段**（中间可以省略，但每一截都要逐字对得上）：本站拿它反查出处，反查不到的整行丢弃；',
  '   - clause 照抄原文的条款写法（如「第三十六条」「附录A」），不要改写编号；kind 五选一；text 一句话、40 字以内；',
  '   - 官方通常把改动写在同一句里（如「将第三十六条修改为：……」「删去第七条」「增加一条，作为第X条」），照原句摘出来，不要重述成你自己的话；',
  '   - **只列你真在文本里看到的改动**。附件可能被本站按字数预算截断，看不到的部分就不要列，也不要写「等」「主要修改内容如下」来掩盖缺口 —— 正文里检测到多少处、本页列出多少处，那个差值是本站读得不够，不是你漏写；',
  '   - 这份文件不是"修改现行法律、法规、规章或标准"时（全新制定的标准、名单、计划项目等），输出空数组。',
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
 * 归一化阶段"丢在哪一关"的计数（issue #86 第 0 刀）。
 *
 * 做成一个**可选的可变入参**而不是改返回值，是为了把计数写在丢弃发生的那一行旁边 ——
 * 另写一个函数去"数一遍模型输出会丢几条"就是把条数上限和空值判据实现第二遍，
 * 而两份实现漂移的表现是：诊断说没丢，实际丢了（那正是这个功能要消灭的那类静默）。
 */
export interface NormalizeTally {
  /** 条目缺必填文本 / 类型不对 */
  emptyOrInvalid: number;
  /** 超过条数上限被挡掉 */
  overLimit: number;
}

/**
 * 模型原始 JSON 里三类数组的条数（未受任何上限影响）。
 * 与 `normalized` 的差额就是"上限与空值"吃掉的量，所以它必须从**解析后的原始对象**上数，
 * 不能从归一化结果上数（那是自证）。
 */
export function countModelOutput(raw: unknown): SummaryFieldCounts {
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const lengthOf = (key: string): number => (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0);
  return {
    keyPoints: lengthOf('keyPoints'),
    explanationPoints: lengthOf('explanationPoints'),
    channels: lengthOf('channels'),
    impacts: lengthOf('impacts'),
    changes: lengthOf('changes'),
  };
}

/**
 * 校验并归一化模型输出的摘要 JSON；形状不合法抛错（由摘要任务的重试策略兜底）。
 *
 * 三条有意的规则：
 * 1. **必填两段必须非空**（what / howToComment）—— 此前只校验「是不是字符串」，于是
 *    `"who": ""` 也能落库，页面上「影响谁」标题下面空无一物（生产实测 mimo-v2.5 有 1 条
 *    这样，glm 0 条）。答不上就抛错，交给重试 / 转人工复核，比留一个空段落诚实。
 *    不合格时**一次报全**并分开写清是缺字段、值不是字符串还是空串：三者的成因与处置
 *    完全不同，合成一句就会把「校验器按顺序先撞上哪个」误读成「只有那个字段有问题」
 *    （issue #56 的 30% 失败率就是这么被误判成模型抖动的）。
 * 2. 原文可能确实没有的段（**影响谁** / 谁能提 / 逾期会怎样）缺省为空串，不算形状异常 ——
 *    把它们变成必填只会逼模型编一句；「影响谁」原本在必填里，实测后降级（见 SYSTEM_PROMPT 注释）。
 * 3. 渠道数组**一项都不删**：`quotes.channels` 按原始下标与渠道配对，这里删一项
 *    就会让后面的渠道挂上前面的引用。去空 / 去重 / 截断统一由 buildQuotedSummary
 *    里的 normalizeChannels 在配好引用之后做。
 */
export function normalizeModelSummary(raw: unknown, tally?: NormalizeTally): QuotedStructuredSummary {
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
  const take = (key: 'what' | 'howToComment'): string => {
    const value = record[key];
    const problem = shapeProblem(value);
    if (problem !== null) {
      problems.push(`"${key}" ${problem}`);
      return '';
    }
    return (value as string).trim();
  };
  const what = take('what');
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

  // 说明要点（issue #76 第 3 步）：形状不对的条目这里就丢掉，
  // 逐字反查不到出处由 buildQuotedSummary 负责丢弃。
  const explanationPoints = normalizeExplanationPoints(record.explanationPoints, tally);

  // 影响判读（issue #86 第 1 刀）：与说明要点一样，形状不对的在这里丢掉，
  // 逐字反查不到出处由 buildQuotedSummaryWithTally 负责丢弃。
  const impacts = normalizeImpacts(record.impacts, tally);

  // 「改了哪几处」（issue #86 第 2 刀）：与影响判读同一套路 —— 形状不对的在这里丢掉，
  // 逐字反查不到出处由 buildQuotedSummaryWithTally 负责丢掉整行。
  const changes = normalizeChanges(record.changes, tally);

  const rawQuotes = readQuotes(record.quotes);
  // keyPoints 与它的引用必须**先按原始下标配好、再过滤空项** —— 这是 normalizeChannels
  // 的同一条教训（issue #56）：先 filter 再取引用，第 3 条要点就会挂上第 2 条的原句，
  // 而页面把它显示成「摘自官方原文」，读者无从发现配错了。
  const rawKeyPoints = Array.isArray(record.keyPoints) ? record.keyPoints : [];
  const rawKeyPointQuotes = Array.isArray(rawQuotes?.keyPoints) ? rawQuotes.keyPoints : [];
  const keyPoints: string[] = [];
  const keyPointQuotes: (string | null)[] = [];
  rawKeyPoints.forEach((raw, index) => {
    if (keyPoints.length >= MAX_KEY_POINTS) {
      if (tally) tally.overLimit += 1;
      return;
    }
    const point = typeof raw === 'string' ? raw.trim() : '';
    if (point === '') {
      if (tally) tally.emptyOrInvalid += 1;
      return;
    }
    const quote = rawKeyPointQuotes[index];
    keyPoints.push(point);
    keyPointQuotes.push(typeof quote === 'string' && quote.trim() !== '' ? quote.trim() : null);
  });
  const quotes = rawQuotes
    ? { ...rawQuotes, ...(keyPointQuotes.length > 0 ? { keyPoints: keyPointQuotes } : { keyPoints: undefined }) }
    : undefined;

  return {
    what,
    who: optionalText('who'),
    whoCanSubmit: optionalText('whoCanSubmit'),
    afterDeadline: optionalText('afterDeadline'),
    ...(keyPoints.length > 0 ? { keyPoints } : {}),
    ...(explanationPoints.length > 0 ? { explanationPoints } : {}),
    ...(impacts.length > 0 ? { impacts } : {}),
    ...(changes.length > 0 ? { changes } : {}),
    deadline,
    howToComment,
    channels,
    ...(quotes ? { quotes } : {}),
  };
}

/** 一次摘要最多列几个说明小节（超了就不是给人看的清单，是把说明重排一遍） */
const MAX_EXPLANATION_POINTS = 24;

/** 模型的说明小节 → 端口形状。缺 quote 或缺说明的一律不要（后面还要按说明段落反查）。 */
function normalizeExplanationPoints(value: unknown, tally?: NormalizeTally): AmendmentExplanationDraft[] {
  if (!Array.isArray(value)) return [];
  const out: AmendmentExplanationDraft[] = [];
  for (const item of value) {
    if (out.length >= MAX_EXPLANATION_POINTS) {
      // 到顶后继续数（而不是 break）：计数要的是"被上限挡掉几条"，
      // 提前退出会让这个数永远等于 0，而成品与 continue 完全一致。
      if (tally) tally.overLimit += 1;
      continue;
    }
    if (typeof item !== 'object' || item === null) {
      if (tally) tally.emptyOrInvalid += 1;
      continue;
    }
    const point = item as Record<string, unknown>;
    const quote = typeof point.quote === 'string' ? point.quote.trim() : '';
    const text = typeof point.text === 'string' ? point.text.trim() : '';
    const heading = typeof point.heading === 'string' ? point.heading.trim() : '';
    if (quote === '' || text === '') {
      if (tally) tally.emptyOrInvalid += 1;
      continue;
    }
    out.push({ heading, text, quote });
  }
  return out;
}

/**
 * 一次摘要最多列几处影响（issue #86 第 1 刀）。
 *
 * 12 是"给人看的清单"的量级：这一段是读者要逐条判断的东西，列到二三十条就等于把条文
 * 重排了一遍；而每条都要求挂原文引用，数量一上去模型就开始凑数（`emitted` 与
 * `dropped.emptyOrInvalid` 里看得见那股凑数的形状）。
 */
const MAX_IMPACTS = 12;

/** 影响类型白名单。`other` 只作为**兜底桶**存在（模型给了认不出的值时用它），提示词里不要求。 */
const IMPACT_KINDS: readonly ImpactKind[] = ['risk', 'loophole', 'burden', 'other'];

/**
 * 模型给的影响判读 → 端口形状。
 *
 * `quote` 与 `text` 缺一即丢：**没有引用的推断在本站不许落库** —— 这正是这一段与其余各段的
 * 区别所在（别处明令禁止推断，这里允许推断但**必须挂依据**，由程序反查出处在哪一份附件）。
 * `who` 允许为空：与顶层 `who` 同一规矩，写不出具体主体时宁可空着也不要填「社会公众」。
 */
function normalizeImpacts(value: unknown, tally?: NormalizeTally): AmendmentImpactDraft[] {
  if (!Array.isArray(value)) return [];
  const out: AmendmentImpactDraft[] = [];
  for (const item of value) {
    if (out.length >= MAX_IMPACTS) {
      if (tally) tally.overLimit += 1;
      continue;
    }
    if (typeof item !== 'object' || item === null) {
      if (tally) tally.emptyOrInvalid += 1;
      continue;
    }
    const impact = item as Record<string, unknown>;
    const quote = typeof impact.quote === 'string' ? impact.quote.trim() : '';
    const text = typeof impact.text === 'string' ? impact.text.trim() : '';
    if (quote === '' || text === '') {
      if (tally) tally.emptyOrInvalid += 1;
      continue;
    }
    const declared = typeof impact.kind === 'string' ? impact.kind.trim() : '';
    out.push({
      quote,
      text,
      who: typeof impact.who === 'string' ? impact.who.trim() : '',
      // 认不出的值落进 other 而**不是** risk：给一条判读贴上错的类型标签，
      // 比老实说"其他"更坏（读者按标签理解这一条是"不利后果"还是"负担"）
      kind: (IMPACT_KINDS as readonly string[]).includes(declared) ? (declared as ImpactKind) : 'other',
    });
  }
  return out;
}

/**
 * 一次摘要最多列多少处改动（issue #86 第 2 刀，沿用 #76 定的 40）。
 * 再多就不是"给人看的表格"，是把正文重排一遍了；而每一行都要求挂一条逐字原文。
 */
const MAX_CHANGES = 40;

/**
 * 模型给的改动 → 端口形状。
 *
 * `quote` 与 `text` 缺一即丢：**没有原文的改动不许落库**（否则表格里会出现一行谁也核对不了的
 * "改了哪几处"）。`clause` 允许空 —— 有些改动句本身没写条号（如「将相关条文中的…统一修改为…」），
 * 页面那一格就空着，而不是让模型去补一个看起来很像的编号。
 */
function normalizeChanges(value: unknown, tally?: NormalizeTally): AmendmentChangeDraft[] {
  if (!Array.isArray(value)) return [];
  const out: AmendmentChangeDraft[] = [];
  for (const item of value) {
    if (out.length >= MAX_CHANGES) {
      if (tally) tally.overLimit += 1;
      continue;
    }
    if (typeof item !== 'object' || item === null) {
      if (tally) tally.emptyOrInvalid += 1;
      continue;
    }
    const change = item as Record<string, unknown>;
    const quote = typeof change.quote === 'string' ? change.quote.trim() : '';
    const text = typeof change.text === 'string' ? change.text.trim() : '';
    if (quote === '' || text === '') {
      if (tally) tally.emptyOrInvalid += 1;
      continue;
    }
    const declared = typeof change.kind === 'string' ? change.kind.trim() : '';
    out.push({
      quote,
      text,
      clause: typeof change.clause === 'string' ? change.clause.trim() : '',
      kind: (CHANGE_KINDS as readonly string[]).includes(declared)
        ? (declared as ChangeKind)
        : 'other',
    });
  }
  return out;
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
  // keyPoints 的引用允许缺项（null），由调用方与 keyPoints 一一对齐后再过滤 —— 
  // 空串会被读成 null，这样「模型漏了第 2 条的引用」不会被误配到第 1 条上。
  const keyPointQuotes = Array.isArray(record.keyPoints)
    ? record.keyPoints.map((item) =>
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
    ...(keyPointQuotes ? { keyPoints: keyPointQuotes } : {}),
  };
}

export function userPrompt(input: LlmSummarizeInput): string {
  const budget = SUMMARY_TIERS[input.tier ?? 'standard'];
  const body =
    input.bodyText.length > MAX_BODY_CHARS
      ? `${input.bodyText.slice(0, MAX_BODY_CHARS)}…（正文过长已截断）`
      : input.bodyText;
  return [
    `标题：${input.title}`,
    `官方原文链接：${input.url}`,
    '正文纯文本：',
    body.length > 0 ? body : '（未抓取到正文，仅能基于标题判断）',
    draftBlock(input.draftSources, budget.draftBlockChars),
    explanationBlock(input.draftSources, budget.explanationBlockChars),
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

/**
 * 「编制说明」段落（issue #76 第 3 刀）。
 *
 * 与「附件条文」分开成两段，是为了让**引用反查按段落隔离**：说明里的话不能当作规定
 * 落进 keyPoints，条文也不能冒充"说明里的解释"。角色由调用方按文件名判好
 * 带在 DraftSource.role 上（见 src/lib/attachment-select.ts 的 attachmentRole）。
 *
 * 上限由档位给（issue #86 第 3 刀）：缺省 = 标准档（与在此之前逐个相同）；重档放宽是因为
 * worker 那一侧的重档预算已经把说明喂到 16,000 字符，卡在 10,000 就会**静默切掉尾部** ——
 * 而"静默切掉"正是这一刀要消灭的失败模式。数字只在 `attachment-feed.ts` 里存一份。
 */
export function explanationBlock(
  sources: DraftSource[] | undefined,
  maxChars: number = SUMMARY_TIERS.standard.explanationBlockChars,
): string {
  const usable = (sources ?? []).filter((item) => item.role === 'explanation' && item.text.trim().length > 0);
  if (usable.length === 0) return '';
  const parts: string[] = [
    `编制说明（本站从该公示的官方附件中逐字提取，共 ${usable.length} 份。这是解释性文件，不是规定本身：讲为什么制定、依据什么、主要改了什么、向谁征求意见）：`,
  ];
  let left = maxChars;
  usable.forEach((item, index) => {
    const label = `【说明 ${index + 1}：${item.name}】`;
    if (left <= 0) {
      parts.push(`…（另有 ${usable.length - index} 份说明超出字数预算，未提供）`);
      return;
    }
    const text = item.text.trim().slice(0, left);
    left -= text.length;
    parts.push(label, text);
  });
  return parts.join('\n');
}

/**
 * 「附件条文」段落（issue #57 第 5 步）。
 *
 * 没有条文时返回**空串**（而不是「（无附件）」之类的占位）—— 提示词里那句
 * 「没有『附件条文』段落时 keyPoints 必须为空数组」的依据就是这个段落出现与否，
 * 占位文字会让「没给条文」和「给了空条文」看起来一样。
 *
 * 上限由档位给（issue #86 第 3 刀），理由同 `explanationBlock`：
 * 它是**最后一道防线**（挡"把整份文档直接塞进 draftSources"的调用方），不是预算本身 ——
 * 预算在 `attachment-feed.ts`，两处同源。
 */
export function draftBlock(
  sources: DraftSource[] | undefined,
  maxChars: number = SUMMARY_TIERS.standard.draftBlockChars,
): string {
  const usable = (sources ?? []).filter((item) => item.text.trim().length > 0 && item.role !== 'explanation');
  if (usable.length === 0) return '';
  const parts: string[] = [
    `附件条文（本站从该公示的官方附件中逐字提取，共 ${usable.length} 份。这是草案正文本身，不是公告；只写你在这里确实读到的规定）：`,
  ];
  let left = maxChars;
  usable.forEach((item, index) => {
    const label = `【附件 ${index + 1}：${item.name}】`;
    if (left <= 0) {
      parts.push(`…（另有 ${usable.length - index} 份附件条文超出字数预算，未提供）`);
      return;
    }
    const text = item.text.trim().slice(0, left);
    left -= text.length;
    parts.push(label, text);
  });
  return parts.join('\n');
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
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt(input) },
          ],
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // 请求没发出去 / 没回来 ⇒ **没有响应可诊断**。这里刻意不编一份空诊断：
      // 诊断的全部价值在"模型说了什么"，而此刻什么都没说过；凭空写一条会让人
      // 以为调用发生过（与 #64 那条"空态占比 0/192"同一种诚实要求）。
      throw new Error(
        `${this.provider} API 请求失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new LlmResponseError(
        `${this.provider} API HTTP ${response.status}：${body.slice(0, 200)}`,
        this.diagnosticsFor({ raw: body, elapsedMs, finishReason: null, usage: null }),
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
      usage?: unknown;
    } | null;
    const choice = payload?.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const usage = readTokenUsage(payload?.usage);

    if (typeof content !== 'string' || content.length === 0) {
      throw new LlmResponseError(
        `${this.provider} API 响应缺少 choices[0].message.content 文本`,
        this.diagnosticsFor({ raw: '', elapsedMs, finishReason, usage }),
      );
    }

    let parsed: unknown;
    try {
      parsed = parseModelJson(content);
    } catch (error) {
      throw new LlmResponseError(
        error instanceof Error ? error.message : String(error),
        this.diagnosticsFor({ raw: content, elapsedMs, finishReason, usage }),
      );
    }

    // 丢弃计数写在丢弃发生的那一行旁边（见 NormalizeTally 的注释）
    const tally: NormalizeTally = { emptyOrInvalid: 0, overLimit: 0 };
    const emitted = countModelOutput(parsed);
    let summary: QuotedStructuredSummary;
    try {
      summary = normalizeModelSummary(parsed, tally);
    } catch (error) {
      throw new LlmResponseError(
        error instanceof Error ? error.message : String(error),
        this.diagnosticsFor({
          raw: content,
          elapsedMs,
          finishReason,
          usage,
          emitted,
          dropped: { ...tally, quoteNotFound: 0 },
        }),
      );
    }

    const normalized: SummaryFieldCounts = {
      keyPoints: summary.keyPoints?.length ?? 0,
      explanationPoints: summary.explanationPoints?.length ?? 0,
      channels: summary.channels.length,
      impacts: summary.impacts?.length ?? 0,
      changes: summary.changes?.length ?? 0,
    };
    return {
      ...summary,
      diagnostics: this.diagnosticsFor({
        raw: content,
        elapsedMs,
        finishReason,
        usage,
        emitted,
        normalized,
        // kept 要等逐字反查之后才知道（buildQuotedSummaryWithTally）；这里先与 normalized 同值，
        // 由 worker 用真正的落库条数覆盖 —— 宁可给一个"还没算"的值，也不留一个 undefined
        // 让读的人以为适配器不知道。
        kept: normalized,
        dropped: { ...tally, quoteNotFound: 0 },
      }),
    };
  }

  /**
   * 组装一次调用的诊断。
   *
   * `attempts` 先写 1：它属于**重试循环**，而适配器看不到自己是被第几次调用的 ——
   * 由 worker 覆盖（它是唯一知道"这条试了几次"的地方）。
   */
  private diagnosticsFor(parts: {
    raw: string;
    elapsedMs: number;
    finishReason: string | null;
    usage: SummaryTokenUsage | null;
    emitted?: SummaryFieldCounts;
    normalized?: SummaryFieldCounts;
    kept?: SummaryFieldCounts;
    dropped?: SummaryDroppedCounts;
  }): SummaryDiagnostics {
    const capped = capRawOutput(parts.raw);
    return {
      v: SUMMARY_DIAGNOSTICS_VERSION,
      model: this.model,
      provider: this.provider,
      elapsedMs: parts.elapsedMs,
      attempts: 1,
      // 走到这里就说明响应回来了（连 `!response.ok` 那条也带着响应体），
      // 所以"有人看过"这件事是真的 —— 见 SummaryDiagnostics.instrumented 的注释
      instrumented: true,
      finishReason: parts.finishReason,
      usage: parts.usage,
      rawChars: parts.raw.length,
      raw: capped.raw,
      rawTruncated: capped.rawTruncated,
      emitted: parts.emitted ?? emptyFieldCounts(),
      normalized: parts.normalized ?? emptyFieldCounts(),
      kept: parts.kept ?? emptyFieldCounts(),
      dropped: parts.dropped ?? emptyDroppedCounts(),
    };
  }
}

/**
 * 读 OpenAI 兼容响应里的 usage（issue #86）。字段名各家略有出入，三种写法都认；
 * 给不出就是 null —— 不把"没上报"写成 0（那会让人以为这次调用没花 token）。
 */
function readTokenUsage(raw: unknown): SummaryTokenUsage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };
  const usage: SummaryTokenUsage = {
    promptTokens: pick('prompt_tokens', 'promptTokens', 'input_tokens'),
    completionTokens: pick('completion_tokens', 'completionTokens', 'output_tokens'),
    totalTokens: pick('total_tokens', 'totalTokens'),
  };
  if (usage.promptTokens === null && usage.completionTokens === null && usage.totalTokens === null) {
    return null;
  }
  return usage;
}
