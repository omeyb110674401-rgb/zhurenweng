import fs from 'node:fs';
import path from 'node:path';
import type { MailMessage, MailerPort } from '../../ports.ts';

/**
 * stub 邮件发送器：MailerPort 的测试实现（ADR-0001 第 5 条）。
 * 不真正发信，只捕获邮件供测试断言。
 *
 * 捕获方式有两种：
 * - 进程内：`sentMessages()` 直接读取内存数组（stub 与测试同进程时用）；
 * - 跨进程：构造时传入 outboxFile（或环境变量 MAILER_OUTBOX_FILE），
 *   每发一封邮件追加一行 JSON（JSONL），测试进程读取该文件断言。
 */

export interface StubMailerOptions {
  /** 追加写入的 JSONL 文件路径；缺省时仅记录在内存。 */
  outboxFile?: string;
  /**
   * 注入失败：前 n 次 `send()` 抛错；'always' = 每次都抛。
   * 与 `LLM_STUB_FAILURES` 同构（issue #60 加）：用来验"发信失败不能写去重标记"
   * 这类只在失败时才成立的保证 —— 没有注入手段，这类断言就只能靠读代码信任。
   */
  failures?: number | 'always';
}

function failuresFromEnv(raw: string | undefined): number | 'always' {
  if (raw === undefined || raw === '') return 0;
  if (raw === 'always') return 'always';
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`非法的 MAILER_STUB_FAILURES "${raw}"（应为非负整数或 always）`);
  }
  return parsed;
}

export class StubMailer implements MailerPort {
  readonly provider = 'stub';

  private readonly messages: MailMessage[] = [];
  private readonly outboxFile?: string;
  private readonly failures: number | 'always';
  private sendSeq = 0;

  constructor(options: StubMailerOptions = {}) {
    this.outboxFile = options.outboxFile;
    this.failures = options.failures ?? failuresFromEnv(process.env.MAILER_STUB_FAILURES);
  }

  async send(message: MailMessage): Promise<void> {
    this.sendSeq += 1;
    if (this.failures === 'always' || this.sendSeq <= this.failures) {
      throw new Error(`【stub】注入的邮件发送失败（第 ${this.sendSeq} 次，MAILER_STUB_FAILURES=${this.failures}）`);
    }
    this.messages.push({ ...message });
    if (this.outboxFile) {
      fs.mkdirSync(path.dirname(path.resolve(this.outboxFile)), { recursive: true });
      fs.appendFileSync(this.outboxFile, `${JSON.stringify(message)}\n`, 'utf8');
    }
  }

  /** 已捕获的邮件快照，供进程内断言。 */
  sentMessages(): MailMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }
}
