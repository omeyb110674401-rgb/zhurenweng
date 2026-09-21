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

/**
 * 错误响应的头（issue #54）：此前这里只有 no-store，**丢了 `x-robots-tag: noindex`** ——
 * 而 404 恰恰是爬虫最容易撞到的响应（`/nope`、已被合并掉的条目 ID），没声明 noindex
 * 就等于把错误页留给搜索引擎收录。直接复用 302 那一份常量，两边不会各自漂移。
 */
const ERROR_HEADERS = { ...REDIRECT_HEADERS } as const;

/**
 * 面向读者的错误页（issue #53）：此前 404 / 500 直接回 `{"error":"未找到该公示条目"}`
 * —— 读者在详情页点「去官方渠道提意见」，若该条目恰好已被合并或清掉，看到的是一屏
 * 裸 JSON，既读不懂也没有回站路径。这个端点本来就是**给人点**的（机器请求走 302），
 * 错误响应也该是能读的页面。
 *
 * 内联最小样式、不依赖站点渲染管线（这里在 App Router 的响应层，拿不到 globals.css
 * 与页面组件）；标题与正文都来自下面的常量，没有插值输入。
 */
function errorPage(status: number, message: string): NextResponse {
  const html = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${message} —— 主人翁</title></head>`,
    '<body style="margin:0;padding:48px 20px;background:#f8fafc;color:#1f2937;line-height:1.6;',
    'font-family:system-ui,-apple-system,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif">',
    '<main id="main-content" style="max-width:640px;margin:0 auto">',
    `<h1 style="font-size:20px;margin:0 0 12px">${message}</h1>`,
    '<p style="margin:0 0 20px;color:#4b5563">该链接指向的公示条目可能已被合并或移除。',
    '本站只做聚合，意见的提交与法律效力一律以官方渠道为准。</p>',
    '<p style="margin:0"><a href="/" style="color:#b45309">← 返回公示列表</a></p>',
    '</main></body></html>',
  ].join('');
  return new NextResponse(html, {
    status,
    headers: { ...ERROR_HEADERS, 'content-type': 'text/html; charset=utf-8' },
  });
}

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
    return errorPage(404, '未找到该公示条目');
  }

  // 协议白名单（issue #52，纵深防御）：写入侧都已守卫（爬虫过 resolveUrl、人工补录
  // 强制 http/https），但只要库里出现一条非 http(s) 的 url，302 的 Location 就会
  // 变成 `javascript:` / `data:` —— 浏览器多数会拦，但那不是我们该依赖的东西。
  let target: URL;
  try {
    target = new URL(notice.url);
  } catch {
    return errorPage(500, '该条目缺少有效的官方原文链接');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    console.error(`[go] noticeId=${id} 官方原文链接协议非法：${target.protocol}`);
    return errorPage(500, '该条目缺少有效的官方原文链接');
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
    return errorPage(404, '未找到该公示条目');
  }

  // 非个人身份的访问日志：仅条目 ID 与日期（不带 UA）
  console.log(
    `[go] date=${siteDateIso(new Date())} noticeId=${id} outboundClicks=${clicks ?? '写入失败'}`,
  );

  return NextResponse.redirect(target, { status: 302, headers: REDIRECT_HEADERS });
}
