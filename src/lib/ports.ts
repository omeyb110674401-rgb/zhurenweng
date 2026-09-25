import { createGlmLlm } from './adapters/glm-llm.ts';
import { createOpenAiLlmFromEnv } from './adapters/openai-compatible-llm.ts';
import { StubLlm } from './adapters/stubs/stub-llm.ts';
import { StubMailer } from './adapters/stubs/stub-mailer.ts';
import { createSmtpMailerFromEnv } from './adapters/smtp-mailer.ts';
import { LocalSearch } from './search/local-search.ts';
import { createMeilisearchSearchFromEnv } from './search/meilisearch-search.ts';

/**
 * 端口（Port）定义 —— 生产实现与测试 stub 之间的接缝（ADR-0001）。
 *
 * 约定：
 * - 业务代码只依赖这里的接口，永远不直接 import 具体适配器；
 * - 真实服务商适配器（GLM LLM、SMTP 邮件、Meilisearch 检索）由后续切片实现，
 *   接入点是对应的 `createXxxPort()` 工厂（环境变量切换），不在调用方硬编码；
 * - 测试环境通过 LLM_PROVIDER=stub / MAILER_PROVIDER=stub 注入固定行为。
 */

/**
 * 结构化摘要（issue #55 重构为「参与导引」口径）。
 *
 * 为什么没有「关键条款」这一段（此前的五段式是 这是什么 / 影响谁 / 关键条款 /
 * 截止日期 / 如何提意见）：生产实测 77 条未截止条目的**正文均值只有 443 字**
 * （76 条落在 207–1283 字区间），装的是「谁、就哪个文件、征求到什么时候、通过什么
 * 方式反馈」这个公告壳，草案条文与标准文本在**附件**里、不在抓取到的正文中
 * （65/77 条带附件清单）。让模型从公告壳里「概括 2-5 条关键条款」，它只能把
 * 「公示期 30 日」「可邮件反馈」这类元信息重排成看着像条款的句子 —— 不是措辞不好，
 * 是输入里根本没有条款。这一段于是被删掉，改为只回答公告里真实存在的参与信息。
 *
 * 必填两段的口径与后台人工复核一致：这两段任何公示都该有，缺了就是模型没答上，
 * 该重试而不是落一个空段让页面上出现「标题下有内容无」。「影响谁」原本也在必填里，
 * 实测后降级为可缺段 —— 公告壳里通常没有受影响主体（它在附件的草案里），硬要的结果
 * 是一半条目空串作废、另一半填进「有关单位和公众」这类泛称（35 条成功里 26 条如此），
 * 两头都不是要的答案（issue #56 第八节）。
 */

/** 提交渠道的类型（决定详情页怎么渲染：能不能 mailto: / tel: 直接点） */
export type SummaryChannelKind = 'email' | 'phone' | 'mail' | 'online' | 'other';

/**
 * 一条可操作的提交渠道。`value` 只放地址本身（邮箱 / 电话 / 含邮编的邮寄地址 / 网址），
 * 说明性文字归 `howToComment` —— 否则渠道清单又退化成一段糊在一起的话。
 */
export interface SummaryChannel {
  kind: SummaryChannelKind;
  value: string;
}

export interface StructuredSummary {
  /** 这是什么（一句话） */
  what: string;
  /** 影响谁（可缺：原文写明受影响主体才写，泛称不算。见文件头注释与 issue #56 第八节） */
  who: string;
  /** 谁能提（原文未提及则为空串） */
  whoCanSubmit: string;
  /** 逾期会怎样（原文未提及则为空串） */
  afterDeadline: string;
  /** 关键条款：仅在**给了附件条文**时才有内容（issue #57 第 5 步）。
   *  #56 曾因「公告壳里没有条款可概括」停用本段，输入换成附件正文后重新启用 ——
   *  没有条文输入时模型必须输出空数组，这条约束由提示词与归一化共同保证。 */
  keyPoints?: string[];
  /** 截止日期（ISO 8601），未知为 null */
  deadline: string | null;
  /** 如何提意见（一句话概述途径） */
  howToComment: string;
  /** 提交渠道清单（可为空数组） */
  channels: SummaryChannel[];
  /**
   * 修正案改动点（issue #76 第 2 刀）：只有体裁判为修正案、且真的喂进了附件正文
   * 才可能有内容。归一化时拿每条的 `quote` 去喂进去的条文里逐字反查，查不到就丢弃 ——
   * 与 keyPoints 同一条不变量：页面上出现的每一处改动，都得是本站真的读到的原话。
   */
  changes?: AmendmentChangeDraft[];
}

/**
 * 模型给出的一处改动。
 *
 * 引用与内容放在**同一个对象**里，不用平行数组：keyPoints 那套"按下标与 quotes 对齐"
 * 在归一化时吃过不少亏（错配比留空更糟 —— 读者看到的是一条挂在错误原文上的改动）。
 */
export interface AmendmentChangeDraft {
  /** 被改的条款标识，照抄原文写法（如「第三条」「附录A」），不要改写编号 */
  clause: string;
  /** 改动类型：modify 修改 / add 新增 / delete 删除 / renumber 条序调整 / other */
  kind: 'modify' | 'add' | 'delete' | 'renumber' | 'other';
  /** 这一处改了什么：一句话，40 字以内 */
  text: string;
  /** 逐字原文：官方对照文字里描述这处改动的那句话，160 字以内 */
  quote: string;
}

/**
 * 一路附件条文（issue #57 第 5 步）：本站从官方附件里**逐字**提取并已截取的草案文本。
 *
 * `name` 与 `url` 必须带着走完全程 —— 详情页要把「这条要点来自哪个附件」标出来，
 * 而出处是**程序按引用反查**出来的（见 src/lib/draft-sources.ts），不让模型自报来源：
 * 它会把两个附件的内容混引到同一个附件上，而那种错读者看不出来。
 */
export interface DraftSource {
  name: string;
  url: string;
  text: string;
}

export interface LlmSummarizeInput {
  title: string;
  bodyText: string;
  /** 官方原文 URL，提示词中用于锚定引用 */
  url: string;
  /**
   * 附件条文（可选，issue #57 第 5 步）：空数组 / 未设置 = 只给公告壳，
   * 此时提示词要求 keyPoints 留空。摘要是否读附件由 `ATTACHMENT_TEXT` 档位决定
   * （见 src/lib/attachment-mode.ts 的 `attachmentTextFeedsSummary`）。
   */
  draftSources?: DraftSource[];
}

export interface LlmPort {
  readonly provider: string;
  summarize(input: LlmSummarizeInput): Promise<StructuredSummary>;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /**
   * 附加邮件头（issue #34）：目前用于 `List-Unsubscribe` / `List-Unsubscribe-Post`
   * —— 让邮件客户端自带的「退订」按钮走 RFC 8058 一键退订（POST），
   * 而不是把用户丢到网页上找入口。
   */
  headers?: Record<string, string>;
}

export interface MailerPort {
  readonly provider: string;
  send(message: MailMessage): Promise<void>;
}

/** 检索文档（索引字段含标题、AI 摘要、正文纯文本，见 PRD） */
export interface SearchDocument {
  id: string;
  title: string;
  summary: string;
  body: string;
}

export interface SearchHit {
  id: string;
  title: string;
}

/** 检索默认每页条数（两个实现共用同一缺省值，避免 provider 之间口径不一） */
export const SEARCH_DEFAULT_PER_PAGE = 20;

/** 一页检索结果：`total` 是**命中总数**（≥ hits.length），结果页据此如实展示与分页。 */
export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

/** 检索分页参数（页码从 1 起；缺省由实现取 SEARCH_DEFAULT_PER_PAGE）。 */
export interface SearchOptions {
  page?: number;
  perPage?: number;
}

/**
 * SearchPort：生产实现为 Meilisearch 适配器，开发 / 测试为本地实现（检索切片交付）。
 * `index()` 为幂等 upsert（同 id 先删后写）；`remove()` 在条目从库中删除时同步
 * 清理索引（当前管线只有 upsert，无删除路径，接口先行以固化契约）。
 */
export interface SearchPort {
  readonly provider: string;
  index(documents: SearchDocument[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
}

/** 按环境变量创建 LLM 端口。真实 GLM 适配器由 AI 摘要切片在此注册。 */
export function createLlmPort(): LlmPort {
  const provider = process.env.LLM_PROVIDER ?? 'stub';
  switch (provider) {
    case 'stub':
      return new StubLlm();
    case 'glm':
      // 智谱 GLM 预设（PRD 默认服务商）：GLM_API_KEY / GLM_API_BASE / GLM_MODEL
      return createGlmLlm();
    case 'openai':
      // 通用 OpenAI 兼容端点（换模型不改代码）：LLM_API_KEY / LLM_API_BASE / LLM_MODEL
      return createOpenAiLlmFromEnv();
    default:
      throw new Error(`未知的 LLM_PROVIDER "${provider}"（可选：stub | glm | openai）`);
  }
}

/** 按环境变量创建邮件端口。真实 SMTP 适配器由邮件切片在此注册。 */
export function createMailerPort(): MailerPort {
  const provider = process.env.MAILER_PROVIDER ?? 'stub';
  switch (provider) {
    case 'stub': {
      const outboxFile = process.env.MAILER_OUTBOX_FILE || undefined;
      return new StubMailer({ outboxFile });
    }
    case 'smtp':
      // 生产实现（nodemailer，PRD：国内 SMTP 服务商）；配置经 SMTP_* / MAIL_FROM 注入，
      // 见 adapters/smtp-mailer.ts。测试永远走 stub（ADR-0001 第 5 条）。
      return createSmtpMailerFromEnv();
    default:
      throw new Error(`未知的 MAILER_PROVIDER "${provider}"（可选：stub | smtp）`);
  }
}

/**
 * 按环境变量创建检索端口（issue #8）：
 * - local（默认）：SQLite FTS5 / PG ILIKE 本地实现，开发与测试零外部依赖；
 * - meilisearch：生产适配器，配置 MEILI_HOST / MEILI_API_KEY / MEILI_INDEX_UID。
 */
export function createSearchPort(): SearchPort {
  const provider = process.env.SEARCH_PROVIDER ?? 'local';
  switch (provider) {
    case 'local':
      return new LocalSearch();
    case 'meilisearch':
      return createMeilisearchSearchFromEnv();
    default:
      throw new Error(`未知的 SEARCH_PROVIDER "${provider}"（可选：local | meilisearch）`);
  }
}
