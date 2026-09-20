import { NextResponse } from 'next/server';
import { getNoticeById, recordOutboundClick } from '@/db/repo/notices';
import { localDateIso } from '@/lib/dates';

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
 */

// 每次请求都要实时读库与计数，禁止静态优化与缓存。
export const dynamic = 'force-dynamic';

/** 爬虫 / 机器人 UA 特征（不区分大小写）：搜索引擎、AI 爬虫、站点扫描器、监控探针。 */
const BOT_UA_PATTERN =
  /bot|crawler|spider|slurp|scrapy|headless|lighthouse|monitor|uptime|facebookexternalhit|semrush|ahrefs|mj12|dotbot|yandex|petal|bytespider|gptbot|claudebot|anthropic|perplexity/i;

/** 恰为脚本运行时名（可带版本号）的 UA：curl/8.4.0、node、Go-http-client/1.1 … */
const SCRIPT_CLIENT_UA =
  /^(node|nodejs|undici|curl|wget|python-requests|python-urllib|httpx|aiohttp|axios|node-fetch|go-http-client|java|okhttp)(\/[\d.]+)?$/i;

/**
 * 请求是否来自机器（爬虫 / 脚本）：是则不计入北极星指标。
 * 空 UA 也算机器 —— 真实浏览器一定会带 UA。
 */
function isMachineRequest(request: Request): boolean {
  const ua = (request.headers.get('user-agent') ?? '').trim();
  return ua === '' || SCRIPT_CLIENT_UA.test(ua) || BOT_UA_PATTERN.test(ua);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const notice = await getNoticeById(id);
  if (!notice) {
    return NextResponse.json({ error: '未找到该公示条目' }, { status: 404 });
  }

  let target: URL;
  try {
    target = new URL(notice.url);
  } catch {
    return NextResponse.json({ error: '该条目缺少有效的官方原文链接' }, { status: 500 });
  }

  if (isMachineRequest(request)) {
    // 机器请求不计数：日志只记判定与机器 UA（爬虫指纹，非个人身份），
    // 便于日后排查「北极星指标又被谁打满了」。
    const ua = (request.headers.get('user-agent') ?? '').trim();
    console.log(
      `[go] date=${localDateIso(new Date())} noticeId=${id} counted=false ua=${ua.slice(0, 120) || '(empty)'}`,
    );
    return NextResponse.redirect(target, 302);
  }

  const clicks = await recordOutboundClick(id);
  if (clicks === null) {
    return NextResponse.json({ error: '未找到该公示条目' }, { status: 404 });
  }

  // 非个人身份的访问日志：仅条目 ID 与日期（不带 UA）
  console.log(
    `[go] date=${localDateIso(new Date())} noticeId=${id} outboundClicks=${clicks}`,
  );

  return NextResponse.redirect(target, 302);
}
