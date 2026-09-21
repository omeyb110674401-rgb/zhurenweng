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

/** 结构化 AI 摘要（PRD：这是什么 / 影响谁 / 关键条款 / 截止日期 / 如何提意见） */
export interface StructuredSummary {
  /** 这是什么 */
  what: string;
  /** 影响谁 */
  who: string;
  /** 关键条款 */
  keyPoints: string[];
  /** 截止日期（ISO 8601），未知为 null */
  deadline: string | null;
  /** 如何提意见（指回官方渠道的指引） */
  howToComment: string;
}

export interface LlmSummarizeInput {
  title: string;
  bodyText: string;
  /** 官方原文 URL，提示词中用于锚定引用 */
  url: string;
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
