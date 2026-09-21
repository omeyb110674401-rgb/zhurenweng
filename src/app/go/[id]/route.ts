import { NextResponse } from 'next/server';
import { getNoticeById, recordOutboundClick } from '@/db/repo/notices';
import { siteDateIso } from '@/lib/dates';

/**
 * 出站跳转端点（PRD「出站转化埋点」）：/go/<条目ID>
 *
 * 记录一次点击（条目 ID + 日期，不记录任何个人身份 —— 不存 IP、不设 Cookie），
 * 然后 302 跳转到该条目的官方原文 URL。北极星指标「出站提意点击数」据此累计，
 * 后续统计切片（M3）按条目 / 日期聚合。
 *
 * 机器请求过滤（issue #17）：北极星指标衡量的是人的参与意愿，而爬虫遍历全站
 * 详情页会把每条的 /go 都点一遍 —— 上线首日实测 45 条各 1 次点击、全部来自
 * 一次机器遍历，指标被污染。命中机器特征时照常 302（绝不打断跳转），只是不计数。
 *
 * 判定维度在 issue #52 从「UA 一维」扩到「UA + 请求方法 + 预取提示」：Next 会用 GET
 * 处理器自动实现 HEAD（`curl -I` 也成了一次点击），而 `Purpose: prefetch` 型请求是
 * 读者还没点就来的。两类都不是「人读了标题并决定去官方页面」。
 */

// 每次请求都要实时读库与计数，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/**
 * 响应头（issue #38）：
 * - `cache-control: no-store`：这是计数端点，被任何中间层缓存都会漏计点击
 *   （302 本身不在可启发式缓存的集合里，显式声明更稳妥）；
 * - `x-robots-tag: noindex`：robots.txt 已 Disallow 了 /go/，这里再加一道 ——
 *   302 响应带不了 meta 标签，只能走响应头；万一有爬虫忽略 robots.txt，
 *   至少不会把跳转端点收录进索引。
 */
const REDIRECT_HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
} as const;

/** 错误响应同样不该被缓存。 */
const NO_STORE = { 'cache-control': 'no-store' } as const;

/** 爬虫 / 机器人 UA 特征（不区分大小写）：搜索引擎、AI 爬虫、站点扫描器、监控探针。 */
const BOT_UA_PATTERN =
  /bot|crawler|spider|slurp|scrapy|headless|lighthouse|monitor|uptime|facebookexternalhit|semrush|ahrefs|mj12|dotbot|yandex|petal|bytespider|gptbot|claudebot|anthropic|perplexity/i;

/** 恰为脚本运行时名（可带版本号）的 UA：curl/8.4.0、node、Go-http-client/1.1 … */
const SCRIPT_CLIENT_UA =
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
function notCountableReason(request: Request): string | null {
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

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    return NextResponse.json({ error: '未找到该公示条目' }, { status: 404, headers: NO_STORE });
  }

  // 协议白名单（issue #52，纵深防御）：写入侧都已守卫（爬虫过 resolveUrl、人工补录
  // 强制 http/https），但只要库里出现一条非 http(s) 的 url，302 的 Location 就会
  // 变成 `javascript:` / `data:` —— 浏览器多数会拦，但那不是我们该依赖的东西。
  let target: URL;
  try {
    target = new URL(notice.url);
  } catch {
    return NextResponse.json({ error: '该条目缺少有效的官方原文链接' }, { status: 500, headers: NO_STORE });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    console.error(`[go] noticeId=${id} 官方原文链接协议非法：${target.protocol}`);
    return NextResponse.json({ error: '该条目缺少有效的官方原文链接' }, { status: 500, headers: NO_STORE });
  }

  const skipReason = notCountableReason(request);
  if (skipReason !== null) {
    // 不计数的请求照常 302（绝不打断跳转）：日志只记判定与机器指纹，不含个人身份。
    console.log(`[go] date=${siteDateIso(new Date())} noticeId=${id} counted=false 原因=${skipReason}`);
    return NextResponse.redirect(target, { status: 302, headers: REDIRECT_HEADERS });
  }

  // 计数是尽力而为的（issue #51）：北极星指标重要，但读者「到得了官方原文页」
  // 更重要 —— 库抖一下就让跳转变 500，等于用计数失败惩罚用户的唯一动作。
  // 两种失败要分开：抛错（库不可用）照常 302 放行；返回 null（条目在两次查询之间
  // 被删掉）仍是 404 —— 那是真的没有可跳转的目标。
  let clicks: number | null = null;
  let clickWriteFailed = false;
  try {
    clicks = await recordOutboundClick(id);
  } catch (error) {
    clickWriteFailed = true;
    console.error(
      `[go] date=${siteDateIso(new Date())} noticeId=${id} counted=false 计数写入失败：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!clickWriteFailed && clicks === null) {
    return NextResponse.json({ error: '未找到该公示条目' }, { status: 404, headers: NO_STORE });
  }

  // 非个人身份的访问日志：仅条目 ID 与日期（不带 UA）
  console.log(
    `[go] date=${siteDateIso(new Date())} noticeId=${id} outboundClicks=${clicks ?? '写入失败'}`,
  );

  return NextResponse.redirect(target, { status: 302, headers: REDIRECT_HEADERS });
}
