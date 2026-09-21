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
import { noticeStatusLabel } from './notice-status.ts';

/** 截止日期在 additionalProperty 里的属性名（逐字给，供消费方直接读） */
const DEADLINE_PROPERTY = '征求意见截止日期';

export interface NoticeJsonLdOptions {
  notice: NoticeRecord;
  /** 站点对外地址（与 canonical 同一取值口径，见 lib/site-url.ts） */
  siteUrl: string;
  /** 分享摘要：传页面 metadata 用的那一份，保证两处描述一致；省略则不输出 */
  description?: string;
  /**
   * 展示用有效状态（见 lib/notice-status.ts）：库内 status 是每日抓取时推导的，
   * 刚过截止的条目在下一轮前仍是 open —— 结构化数据是对页面的机器可读声明，
   * 必须与页面徽标同一口径。省略时按库内 status 输出。
   */
  status?: NoticeStatus;
}

/** 构建条目页的 JSON-LD 对象（纯函数，便于单测）。 */
export function buildNoticeJsonLd({
  notice,
  siteUrl,
  description,
  status,
}: NoticeJsonLdOptions): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: notice.title,
    url: `${siteUrl}/notices/${notice.id}`,
    inLanguage: 'zh-CN',
    creativeWorkStatus: noticeStatusLabel(status ?? notice.status),
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
 * 列表页的结构化数据（issue #49）：`ItemList`。
 *
 * 为什么是 ItemList 而不是 CollectionPage：本页就是「一串条目」的清单，ItemList 正是
 * 它的机器可读形状；CollectionPage 描述的是「某个集合的落地页」，会把页面语义说成
 * 集合本身（我们并没有把集合当成一件作品来维护）。详情页用 Article（issue #39），
 * 两者合起来才是「列表 → 条目」的完整声明。
 *
 * `position` 从 `startPosition` 起连续编号（分页时第 2 页从 51 开始）：schema.org 要求
 * 位置在列表内唯一有序，写死 1..N 会让第 2 页与第 1 页撞位。刻意不写 `itemListOrder`：
 * 本列表按「征求意见中在前、截止日期升序」排，那不是任何单一字段的升序，写了反而误导。
 *
 * 与详情页同一套自律：只描述页面上**真实可见**的那批条目（`notices` 就是渲染用的那一份），
 * 序列化仍走 `serializeJsonLd`（转义 `<`）。
 *
 * `numberOfItems` 是**整份列表的总数**而不是本页条数（issue #54）：`position` 已经按整份
 * 列表连续编号（第 2 页从 51 起），声明的总数却写本页的 50，等于在同一段结构化数据里
 * 说「这份列表有 50 件、其中第 51 件的位置是 51」——自相矛盾，且与页面可见的「共 N 条」
 * 冲突（线上实测 numberOfItems=50 对 共 185 条）。缺省回落到本页条数，保证不传时
 * 仍然自包含（单页列表两者本就相等）。
 */
export function buildNoticeListJsonLd({
  notices,
  siteUrl,
  startPosition = 1,
  totalItems,
}: {
  notices: NoticeRecord[];
  siteUrl: string;
  /** 本页第一条在整份列表中的位置（分页用；默认 1） */
  startPosition?: number;
  /** 整份列表的总条数（分页时用 count 查询的真实值；默认取本页条数） */
  totalItems?: number;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    numberOfItems: totalItems ?? notices.length,
    itemListElement: notices.map((notice, index) => ({
      '@type': 'ListItem',
      position: startPosition + index,
      url: `${siteUrl}/notices/${notice.id}`,
      name: notice.title,
    })),
  };
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
