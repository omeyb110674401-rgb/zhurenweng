/**
 * 环境变量里的整数解析（issue #51）：空白 / 未设置用缺省值；**非法值抛出明确错误**。
 *
 * 为什么不能直接 `Number(process.env.X ?? 缺省)`：`Number('abc')` 是 NaN，而 NaN 会
 * 静默穿过大多数用法，把「配置写错」变成「看起来在跑的错误行为」——
 * - `setInterval(fn, NaN)` 的延迟按 0 处理 → worker 对十个政府站点变成热循环
 *   （正是 issue #14 花力气避免的事）；
 * - `for (let i = 0; i <= NaN; i += 1)` 一次都不执行 → 摘要重试整个失效，
 *   每条直接判 failed_review 转人工。
 *
 * 配置写错必须在启动那一刻说清楚（与 SMTP_PORT 的 parseSmtpPort 同一取舍）：
 * 宁可进程起不来，也不要带着错误的调度节奏跑一整天。
 */
export function envInt(
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} 不是合法整数：「${raw}」（应为 ${min}-${max} 的整数，未设置时缺省 ${fallback}）`,
    );
  }
  return value;
}
