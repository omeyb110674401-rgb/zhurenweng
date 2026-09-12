import type { NoticeRecord } from '../db/types.ts';
import { parseQuotedSummary } from './summary-content.ts';

/**
 * RSS 2.0 feed 生成（issue #6）—— 纯函数，与传输层（Route Handler）解耦。
 *
 * - 零依赖：XML 拼接 + 自实现转义，不引入任何 XML 库；
 * - 字段：channel（标题 / 链接 / 描述 / 语言 / lastBuildDate / atom:link self）
 *   与 item（title / link / guid / pubDate / description）；
 * - 绝对 URL：站点对外地址由调用方注入（Route Handler 读 SITE_URL 环境变量）；
 * - 摘要片段：AI 摘要就绪（ai_summary_json 可安全解析为五段式摘要）时取
 *   「这是什么」段截断展示，并显著标注 AI 生成（合规姿态在 feed 内同样成立）。
 */

/** RSS 2.0 单页上限（issue #6：item 按发布日期倒序上限 200 条） */
export const FEED_MAX_ITEMS = 200;

export const FEED_TITLE = '主人翁 —— 政府公示信息聚合';

export const FEED_DESCRIPTION =
  '聚合国家级政府公示与征求意见稿，提供 AI 摘要解读与官方原文链接，帮助公众发现、读懂、参与。';

/** description 内 AI 摘要片段的最大长度（超出截断，保持 feed 轻量） */
const SNIPPET_MAX_LENGTH = 120;

/** XML 转义：文本与属性值通用（& 优先，避免二次转义）。 */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * ISO 日期（YYYY-MM-DD，notices.published_at 的存储形状）→ RFC 822 pubDate。
 * 纯日期按 UTC 零点展开（官方页面只给日期，无时刻）；无法解析返回 null（item 省略 pubDate）。
 */
export function rfc822FromIsoDate(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  // 纯日期串按 UTC 零点解析；完整时间戳直接解析
  const date = /^\d{4}-\d{2}-\d{2}$/.test(iso)
    ? new Date(`${iso}T00:00:00Z`)
    : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toUTCString();
}

export interface FeedSite {
  /** 站点对外绝对地址（无尾斜杠），如 https://zhurenweng.example */
  siteUrl: string;
}

/** 生成 feed 的输入：站点地址 + 按发布日期倒序的条目 + 构建时刻。 */
export interface BuildFeedInput extends FeedSite {
  notices: NoticeRecord[];
  now: Date;
}

/**
 * 生成完整 RSS 2.0 XML。channel 元素顺序遵循 RSS 2.0 惯例；
 * atom:link rel="self" 需要 xmlns:atom 命名空间（RSS 阅读器自动发现的推荐写法）。
 */
export function buildFeedXml({ siteUrl, notices, now }: BuildFeedInput): string {
  const base = siteUrl.replace(/\/+$/, '');
  const items = notices.map((notice) => buildItemXml(notice, base)).join('\n');
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '  <channel>',
    `    <title>${escapeXml(FEED_TITLE)}</title>`,
    `    <link>${escapeXml(`${base}/`)}</link>`,
    `    <description>${escapeXml(FEED_DESCRIPTION)}</description>`,
    '    <language>zh-cn</language>',
    `    <lastBuildDate>${escapeXml(now.toUTCString())}</lastBuildDate>`,
    `    <atom:link href="${escapeXml(`${base}/feed.xml`)}" rel="self" type="application/rss+xml" />`,
  ];
  if (items.length > 0) {
    lines.push(items);
  }
  lines.push('  </channel>', '</rss>', '');
  return lines.join('\n');
}

function buildItemXml(notice: NoticeRecord, base: string): string {
  const link = `${base}/notices/${notice.id}`;
  const lines = [
    '    <item>',
    `      <title>${escapeXml(notice.title)}</title>`,
    `      <link>${escapeXml(link)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(notice.id)}</guid>`,
  ];
  const pubDate = rfc822FromIsoDate(notice.publishedAt);
  if (pubDate !== null) {
    lines.push(`      <pubDate>${escapeXml(pubDate)}</pubDate>`);
  }
  lines.push(`      <description>${escapeXml(buildDescription(notice))}</description>`);
  lines.push('    </item>');
  return lines.join('\n');
}

/**
 * item description：发布机关、截止日期、AI 摘要片段（就绪时）、官方原文链接。
 * 段与段以「；」连接；无截止日期 / 摘要未就绪时对应段省略。
 */
function buildDescription(notice: NoticeRecord): string {
  const parts: string[] = [];
  if (notice.agency.length > 0) {
    parts.push(`发布机关：${notice.agency}`);
  }
  if (notice.deadlineAt) {
    parts.push(`截止日期：${notice.deadlineAt}`);
  }
  const snippet = summarySnippet(notice.aiSummary);
  if (snippet !== null) {
    // AI 生成内容在 feed 中同样显著标注（PRD 合规姿态）
    parts.push(`AI 摘要（AI 生成，仅供参考，以官方原文为准）：${snippet}`);
  }
  parts.push(`官方原文：${notice.url}`);
  return parts.join('；');
}

/** AI 摘要片段：五段式摘要安全解析成功且「这是什么」段非空时返回截断文本，否则 null。 */
function summarySnippet(aiSummary: unknown): string | null {
  const summary = parseQuotedSummary(aiSummary);
  if (!summary) return null;
  const text = summary.what.text.trim();
  if (text.length === 0) return null;
  return text.length > SNIPPET_MAX_LENGTH ? `${text.slice(0, SNIPPET_MAX_LENGTH)}……` : text;
}
