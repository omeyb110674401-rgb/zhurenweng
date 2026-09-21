import { envInt } from './env-int.ts';

/**
 * 进程内固定窗口限流（issue #52）。
 *
 * 为什么需要：`POST /api/subscriptions` 与 `POST /admin/login` 此前**一处限流都没有**
 * （仓库没有 middleware.ts，Caddyfile 也没有 rate_limit）。订阅端点的后果最实：
 * 任何人对任意邮箱反复提交，站点就会真的发出一封封来自本站域名的确认信 ——
 * 拿别人的发信域当放大器，损害的是发信域声誉（进黑名单后连正常确认信都投不出去）；
 * 后台登录则是无限次在线爆破，且失败没有任何信号。
 *
 * 口径：**固定窗口**（`limit` 次 / `windowMs`），按客户端 IP 计数。选固定窗口而不是
 * 令牌桶：这里要防的是「批量滥用」，不需要平滑突发，实现越简单越不容易写错。
 *
 * 已知前提（与部署形态绑定）：计数在**进程内存**里，只对**单实例**有效 —— 多副本部署
 * 时每个副本各算各的，实际阈值会乘以副本数；重启即清零。真要横向扩容，得换成共享
 * 存储（Redis / 库表）。当前生产是单实例（见 docs/deploy.md），够用。
 *
 * `limit <= 0` 表示**不限流**（给本地调试与「确定不需要」的场景留的开关，别写成 0 当
 * 「拒绝全部」用 —— 那会让端点变成 429 墙）。
 */

const HOUR_MS = 60 * 60 * 1000;

/** 惰性清理阈值：表大到这个规模才扫一遍过期条目，避免每次请求都全表遍历。 */
const SWEEP_THRESHOLD = 512;

export interface RateLimitVerdict {
  allowed: boolean;
  /** 被拒时距窗口结束的毫秒数（用于 Retry-After）。 */
  retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string): RateLimitVerdict;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** 注入时钟（单测用）；缺省 Date.now。 */
  now?: () => number;
}

/** 建一个限流器（同一实例内部持有计数表）。 */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    check(key: string): RateLimitVerdict {
      if (options.limit <= 0) return { allowed: true, retryAfterMs: 0 };
      const at = now();

      if (hits.size > SWEEP_THRESHOLD) {
        for (const [entryKey, entry] of hits) {
          if (entry.resetAt <= at) hits.delete(entryKey);
        }
      }

      const entry = hits.get(key);
      if (entry === undefined || entry.resetAt <= at) {
        hits.set(key, { count: 1, resetAt: at + options.windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (entry.count >= options.limit) {
        return { allowed: false, retryAfterMs: entry.resetAt - at };
      }
      entry.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
  };
}

/**
 * 客户端标识：`X-Forwarded-For` 的第一跳（Caddy 反代会写入真实客户端地址）。
 * 拿不到时归到 `unknown` 共用一个桶 —— 直连场景（本地开发、容器内探针）本来也
 * 分不出谁是谁；生产经 Caddy，这个头一定在。
 */
export function clientKeyOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : 'unknown';
}

/** 限流器名 → 阈值环境变量 / 缺省值。 */
const LIMITER_CONFIG = {
  subscribe: { env: 'SUBSCRIBE_RATE_LIMIT_PER_HOUR', fallback: 10 },
  adminLogin: { env: 'ADMIN_LOGIN_RATE_LIMIT_PER_HOUR', fallback: 30 },
} as const;

export type LimiterName = keyof typeof LIMITER_CONFIG;

const limiters = new Map<LimiterName, RateLimiter>();

/** 取（惰性建）某个端点的限流器；阈值随 envInt 校验，写错在首次使用时当场报错。 */
function limiterFor(name: LimiterName): RateLimiter {
  const existing = limiters.get(name);
  if (existing) return existing;
  const { env, fallback } = LIMITER_CONFIG[name];
  const created = createRateLimiter({ limit: envInt(env, fallback, { min: 0 }), windowMs: HOUR_MS });
  limiters.set(name, created);
  return created;
}

/** 这次请求是否放行（按 IP × 端点计数）。 */
export function checkRateLimit(name: LimiterName, request: Request): RateLimitVerdict {
  return limiterFor(name).check(clientKeyOf(request));
}
