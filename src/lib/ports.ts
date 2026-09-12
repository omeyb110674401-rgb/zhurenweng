import { StubLlm } from './adapters/stubs/stub-llm.ts';
import { StubMailer } from './adapters/stubs/stub-mailer.ts';

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

/** SearchPort：生产实现为 Meilisearch 适配器，开发 / 测试为本地实现（检索切片交付）。 */
export interface SearchPort {
  readonly provider: string;
  index(documents: SearchDocument[]): Promise<void>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
}

/** 按环境变量创建 LLM 端口。真实 GLM 适配器由 AI 摘要切片在此注册。 */
export function createLlmPort(): LlmPort {
  const provider = process.env.LLM_PROVIDER ?? 'stub';
  switch (provider) {
    case 'stub':
      return new StubLlm();
    case 'glm':
      throw new Error(
        'GLM LLM 适配器尚未实现（AI 摘要切片交付）；本地与测试请设 LLM_PROVIDER=stub',
      );
    default:
      throw new Error(`未知的 LLM_PROVIDER "${provider}"（可选：stub | glm）`);
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
      throw new Error(
        'SMTP 邮件适配器尚未实现（邮件切片交付）；本地与测试请设 MAILER_PROVIDER=stub',
      );
    default:
      throw new Error(`未知的 MAILER_PROVIDER "${provider}"（可选：stub | smtp）`);
  }
}
