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
}

export class StubMailer implements MailerPort {
  readonly provider = 'stub';

  private readonly messages: MailMessage[] = [];
  private readonly outboxFile?: string;

  constructor(options: StubMailerOptions = {}) {
    this.outboxFile = options.outboxFile;
  }

  async send(message: MailMessage): Promise<void> {
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
