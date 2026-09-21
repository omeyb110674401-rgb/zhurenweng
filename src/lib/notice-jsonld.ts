/**
 * 详情页的结构化数据（issue #39）：schema.org JSON-LD。
 *
 * 类型选 Article 的理由：本页**就是**一份文档页（公示正文 + 附件 + 截止日期），
 * Article 是对它的准确描述。Event 要求 location（这些公示没有线下场地），
 * GovernmentService 指「一项持续提供的服务」，两者都会把页面说成它不是的东西。
 * 征求意见针对的那部法规用 `about: Legislation` 表达。
 *
 * 截止日期用两条一起给：schema.org 没有「征求意见截止」这个属性，`expires`
 * （内容过期时间）是语义最接近的标准属性；同时再用 `additionalProperty` 逐字给出
 * 「征求意见截止日期」这个名字，消费方不必猜 `expires` 在本页的含义。
 *
 * 自律：取不到的字段**整个属性省略**（不写 null、不写空串）—— 结构化数据里的空值
 * 会被消费方读成「已知为空」，比缺这个属性更糟。文件名（《…》）与速读卡共用
 * extractDocumentNames，两处口径不会分叉。
 */

import type { NoticeRecord, NoticeStatus } from '../db/types.ts';
import { extractDocumentNames } from './notice-brief.ts';

/** 状态的中文说法（与页面徽标同一套文案） */
const STATUS_LABELS: Record<NoticeStatus, string> = {
  open: '征求意见中',
  closed: '已截止',
  resulted: '已出结果',
};

/** 截止日期在 additionalProperty 里的属性名（逐字给，供消费方直接读） */
const DEADLINE_PROPERTY = '征求意见截止日期';

export interface NoticeJsonLdOptions {
  notice: NoticeRecord;
  /** 站点对外地址（与 canonical 同一取值口径，见 lib/site-url.ts） */
  siteUrl: string;
  /** 分享摘要：传页面 metadata 用的那一份，保证两处描述一致；省略则不输出 */
  description?: string;
}

/** 构建条目页的 JSON-LD 对象（纯函数，便于单测）。 */
export function buildNoticeJsonLd({
  notice,
  siteUrl,
  description,
}: NoticeJsonLdOptions): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: notice.title,
    url: `${siteUrl}/notices/${notice.id}`,
    inLanguage: 'zh-CN',
    creativeWorkStatus: STATUS_LABELS[notice.status],
    // 发布方是本站（聚合方），原文出处另由 isBasedOn 表达
    publisher: { '@type': 'Organization', name: '主人翁', url: siteUrl },
    isBasedOn: notice.url,
  };

  if (description !== undefined && description !== '') {
    doc.description = description;
  }
  if (notice.publishedAt !== null) {
    doc.datePublished = notice.publishedAt;
  }
  // author = 发布机关：这份公告是它发布的
  if (notice.agency !== '') {
    doc.author = { '@type': 'Organization', name: notice.agency };
  }
  if (notice.deadlineAt !== null) {
    doc.expires = notice.deadlineAt;
  }
  if (notice.categoryTags.length > 0) {
    doc.keywords = notice.categoryTags.join(',');
  }

  // 征求意见针对的法规（标题里《…》括起来的，可能有「征求意见稿 + 起草说明」多个）
  const documents = extractDocumentNames(notice.title);
  if (documents.length > 0) {
    doc.about = documents.map((name) => ({ '@type': 'Legislation', name: `《${name}》` }));
  }

  const additionalProperty: Record<string, unknown>[] = [];
  if (notice.deadlineAt !== null) {
    additionalProperty.push({
      '@type': 'PropertyValue',
      name: DEADLINE_PROPERTY,
      value: notice.deadlineAt,
    });
  }
  if (additionalProperty.length > 0) {
    doc.additionalProperty = additionalProperty;
  }

  return doc;
}

/**
 * 序列化为可嵌进 <script type="application/ld+json"> 的字符串。
 *
 * 必须转义 `<`：标题与正文摘自政府页面，只要出现 `</script>` 就会提前闭合脚本块
 * （结构化数据损坏，且是注入面）。JSON 字符串里的 `<` 没有语义，写成 \u003c
 * 之后解析结果完全一致。
 */
export function serializeJsonLd(doc: Record<string, unknown>): string {
  return JSON.stringify(doc).replaceAll('<', '\\u003c');
}
