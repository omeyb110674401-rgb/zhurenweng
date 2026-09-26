/**
 * 出站跳转的**计数判据**（issue #83 从 `src/app/go/[id]/route.ts` 抽出来）。
 *
 * 为什么单独成模块：这段判据决定的是**北极星指标**（出站提意点击数）里哪些请求算数，
 * 而它此前只能靠 e2e 覆盖 —— e2e 跑的是 `.next` 构建产物，而 pin 自证（撤掉实现要变红）
 * 改的是源码，两者对不上：`/go` 的实现被撤掉，e2e 照样全绿。把它抽成一个纯函数之后，
 * 判据能被单测直接执行，也就第一次**真的可以被撤掉实现来验证**。
 *
 * 抽出来时行为一字未改（词表、判定顺序、返回的原因字符串都照抄），只是换了个家。
 */

/** 爬虫 / 机器人 UA 特征（不区分大小写）：搜索引擎、AI 爬虫、站点扫描器、监控探针。 */
export const BOT_UA_PATTERN =
  /bot|crawler|spider|slurp|scrapy|headless|lighthouse|monitor|uptime|facebookexternalhit|semrush|ahrefs|mj12|dotbot|yandex|petal|bytespider|gptbot|claudebot|anthropic|perplexity/i;

/** 恰为脚本运行时名（可带版本号）的 UA：curl/8.4.0、node、Go-http-client/1.1 … */
export const SCRIPT_CLIENT_UA =
  /^(node|nodejs|undici|curl|wget|python-requests|python-urllib|httpx|aiohttp|axios|node-fetch|go-http-client|java|okhttp)(\/[\d.]+)?$/i;

/**
 * 请求为什么不该计入北极星指标：返回原因字符串，可计数时返回 null。
 *
 * 空 UA 也算机器 —— 真实浏览器一定会带 UA。
 *
 * 除 UA 之外的两维（issue #52）：
 * - **HEAD**：Next 会用 GET 处理器自动实现 HEAD（App Router 的既定行为），于是
 *   `curl -I`、链接校验器、监控探针都成了「一次点击」；
 * - **预取 / 预渲染**：`Purpose: prefetch`（Chrome 的推测性预取）与
 *   `Sec-Purpose: prefetch|prerender` 会在读者**还没点**的时候就来取一次。
 * 两者都不是「人读了标题并决定去官方页面」，计进去等于自己给指标灌水 ——
 * 库内那 46 行机器点击就是这么来的（issue #17 的 UA 过滤只挡住了其中一类）。
 */
export function notCountableReason(request: {
  method: string;
  headers: { get(name: string): string | null };
}): string | null {
  const ua = (request.headers.get('user-agent') ?? '').trim();
  if (ua === '') return '空 UA';
  if (SCRIPT_CLIENT_UA.test(ua) || BOT_UA_PATTERN.test(ua)) {
    return `机器 UA：${ua.slice(0, 120)}`;
  }
  if (request.method === 'HEAD') return 'HEAD 请求';

  const purpose = `${request.headers.get('purpose') ?? ''} ${request.headers.get('sec-purpose') ?? ''}`
    .trim()
    .toLowerCase();
  if (purpose.includes('prefetch') || purpose.includes('prerender')) {
    return `预取 / 预渲染：${purpose}`;
  }
  return null;
}
