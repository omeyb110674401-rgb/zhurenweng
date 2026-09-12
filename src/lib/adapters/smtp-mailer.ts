import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { MailMessage, MailerPort } from '../ports.ts';

/**
 * SMTP 邮件适配器（issue #7）：MailerPort 的生产实现（PRD：国内 SMTP 服务商）。
 *
 * 通过环境变量接入（生产 compose / 部署环境注入）：
 * - SMTP_HOST / SMTP_PORT：服务器地址与端口（端口缺省 465）；
 * - SMTP_SECURE：'1' 走 TLS 直连（默认，按端口 465/2465 推断），否则 STARTTLS；
 * - SMTP_USER / SMTP_PASS：认证凭据（都设置才启用认证）；
 * - MAIL_FROM：发件人（如「主人翁 <no-reply@example.gov.cn>」）。
 *
 * 测试永远走 stub（MAILER_PROVIDER=stub，ADR-0001 第 5 条）；本适配器只在
 * MAILER_PROVIDER=smtp 时由 createMailerPort() 构造。
 */

export interface SmtpMailerOptions {
  host: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export class SmtpMailer implements MailerPort {
  readonly provider = 'smtp';

  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(options: SmtpMailerOptions) {
    this.from = options.from;
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port ?? 465,
      secure: options.secure ?? true,
      auth:
        options.user !== undefined && options.pass !== undefined
          ? { user: options.user, pass: options.pass }
          : undefined,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

/** 从环境变量读取 SMTP 配置并创建适配器；缺关键配置时抛出明确错误。 */
export function createSmtpMailerFromEnv(): SmtpMailer {
  const host = process.env.SMTP_HOST;
  const from = process.env.MAIL_FROM;
  if (!host) {
    throw new Error('MAILER_PROVIDER=smtp 需要设置 SMTP_HOST（SMTP 服务器地址）');
  }
  if (!from) {
    throw new Error('MAILER_PROVIDER=smtp 需要设置 MAIL_FROM（发件人地址）');
  }
  const port = process.env.SMTP_PORT !== undefined ? Number(process.env.SMTP_PORT) : undefined;
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === '1'
      : (port ?? 465) === 465;
  return new SmtpMailer({
    host,
    port,
    secure,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from,
  });
}
