import { resolveSmtpOptions } from './adapters/smtp-mailer.ts';

/**
 * 邮件订阅可用性（issue #17）：订阅入口的可见性与表单可用性由邮件端口配置决定。
 *
 * 背景：生产上线时 `MAILER_PROVIDER=smtp` 但 `SMTP_*` 未配置（compose 传的是
 * `${SMTP_HOST:-}`）——订阅表单必然在「发确认邮件」这一步失败。此时对外展示
 * 订阅入口等于给用户一个死流程（首页挂死链、提交只报错），因此：
 * - 首页导航 / 列表头 / 详情页的订阅入口：仅在可用时渲染；
 * - 订阅页：不可用时给提示与 RSS 兜底，不渲染表单；
 * - 提交端点：不可用时直接回 `mailer_unavailable`，不写库、不发信。
 *
 * 配置补齐（或本地 / 测试用 `MAILER_PROVIDER=stub`）后入口自动出现，无需改代码。
 * 判定口径与 adapters/smtp-mailer.ts 的构造校验保持一致：SMTP 端口缺 HOST 或
 * 发件人地址都算不可用。
 */

/** 邮件端口是否可用于对外订阅（true = 入口可见、表单可用）。 */
export function mailerReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return mailerUnavailableReason(env) === null;
}

/**
 * 不可用的原因（可用时返回 null）。
 *
 * 与 `llm-availability.ts` 同一手法：日志、worker 的跳过说明、页面提示都取这一个函数的说法，
 * 于是"界面说的"和"判据说的"不会分家；换服务商时也不用逐处改文案。
 * 判定复用端口构造的同一套解析（`resolveSmtpOptions`），包括端口号合法与凭据成对。
 */
export function mailerUnavailableReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = env.MAILER_PROVIDER ?? 'stub';
  try {
    switch (provider) {
      case 'stub':
        return null;
      case 'smtp':
        resolveSmtpOptions(env);
        return null;
      default:
        return `MAILER_PROVIDER=「${provider}」不是已知服务商（应为 smtp 或 stub）`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
