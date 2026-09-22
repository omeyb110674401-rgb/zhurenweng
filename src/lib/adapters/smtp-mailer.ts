import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { MailMessage, MailerPort } from '../ports.ts';

/**
 * SMTP 邮件适配器（issue #7）：MailerPort 的生产实现（PRD：国内 SMTP 服务商）。
 *
 * 通过环境变量接入（生产 compose / 部署环境注入）：
 * - SMTP_HOST / SMTP_PORT：服务器地址与端口（端口缺省 465）；
 * - SMTP_SECURE：只认 '1'（TLS 直连）与 '0'（STARTTLS），留空按端口推断（465 → 直连）；
 *   其它写法会在构造期报错，见 parseSmtpSecure；
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

/**
 * SMTP 超时（issue #51）：nodemailer 的默认值是「很宽松」—— socketTimeout 10 分钟、
 * connectionTimeout 2 分钟。worker 是串行的：一个黑洞 SMTP 主机（防火墙丢包、
 * 服务商限流）会让每条提醒卡满默认超时，整轮任务停在那里，而且**没有任何告警**
 * （提醒发送失败只记日志）。取值依据：正常 SMTP 握手在秒级，10s 建连 / 20s 单封
 * 已经比任何正常路径宽一个数量级。
 */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
const SMTP_GREETING_TIMEOUT_MS = 10_000;
const SMTP_SOCKET_TIMEOUT_MS = 20_000;

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
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      // 附加邮件头（issue #34）：List-Unsubscribe 等；缺省时不传
      headers: message.headers,
    });
  }
}

/** 默认 SMTP 端口（465 = 隐式 TLS 直连）。 */
const DEFAULT_SMTP_PORT = 465;

/** 解析后的 SMTP 配置（端口与 TLS 已按默认规则补齐，可直接断言）。 */
export interface SmtpEnvOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

/**
 * 解析 SMTP 环境变量为最终配置（纯函数 —— 配置契约因此可以在测试里钉死，
 * 不必真的连一次 SMTP 才知道端口被解析成了什么）。
 *
 * 判空一律「trim 后看空串」，不用 `!== undefined`：compose 以 `${SMTP_PORT:-}`
 * 这类写法把「未设置」传成**空串**，按 undefined 判空会把空串当有效配置 ——
 * 端口变成 0、TLS 推断（465 → 直连）被空串覆盖成 STARTTLS，两者都只在真正
 * 发信时才炸。口径与 lib/mailer-availability.ts 的门控保持一致。
 */
export function resolveSmtpOptions(env: NodeJS.ProcessEnv = process.env): SmtpEnvOptions {
  const host = env.SMTP_HOST?.trim();
  const from = env.MAIL_FROM?.trim();
  if (!host) {
    throw new Error('MAILER_PROVIDER=smtp 需要设置 SMTP_HOST（SMTP 服务器地址）');
  }
  if (!from) {
    throw new Error('MAILER_PROVIDER=smtp 需要设置 MAIL_FROM（发件人地址）');
  }
  const parsedPort = parseSmtpPort(env.SMTP_PORT);
  const port = parsedPort ?? DEFAULT_SMTP_PORT;
  const secure = parseSmtpSecure(env.SMTP_SECURE, port);
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS?.trim() || undefined;
  // 认证凭据要么都给要么都不给：只给一半会让 SMTP 在发信时报 535，
  // 错误现场离配置现场太远，这里直接说清楚。
  if ((user === undefined) !== (pass === undefined)) {
    throw new Error('SMTP_USER 与 SMTP_PASS 必须同时配置（只填一半会在发信时报认证失败）');
  }
  return { host, port, secure, user, pass, from };
}

/** 从环境变量创建 SMTP 适配器；缺关键配置时抛出明确错误。 */
export function createSmtpMailerFromEnv(): SmtpMailer {
  return new SmtpMailer(resolveSmtpOptions());
}

/** SMTP_PORT：空白 / 未设置 → 用默认端口；填了但不是合法端口 → 立刻报错。 */
function parseSmtpPort(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SMTP_PORT 不是合法端口：「${value}」（应填 1-65535 的整数，如 465）`);
  }
  return port;
}

/**
 * SMTP_SECURE：只认 `1` / `0`，其它字面值当场报错（留空则按端口推断）。
 *
 * 为什么不容错：`true` 是最顺手的一种写法（`.env.example` 自己也这么写过、生产 `.env`
 * 里就躺着一条），而按旧实现它会解析成 **STARTTLS** —— 对着 465 这种隐式 TLS 端口发
 * STARTTLS 握手必然失败，且只在真正发信那一刻才炸，错误现场离配置现场隔了一整个
 * SMTP 往返。与其猜操作者的意思，不如在这里把话说清（口径同 parseSmtpPort）。
 */
function parseSmtpSecure(raw: string | undefined, port: number): boolean {
  const value = raw?.trim();
  if (!value) return port === DEFAULT_SMTP_PORT;
  if (value === '1') return true;
  if (value === '0') return false;
  throw new Error(
    `SMTP_SECURE 只能填 1（隐式 TLS 直连）或 0（STARTTLS），收到「${value}」；` +
      '留空则按端口推断（465 直连、其余 STARTTLS）',
  );
}
