/**
 * 列表排序口径的定义（issue #62）。
 *
 * 为什么单独一个模块而不是放在 `src/db/repo/notices.ts`：排序的 SQL 实现在仓储层，
 * 而 querystring 参数白名单在 `app/_lib/home-query.ts` —— 后者刻意「只放纯解析，
 * 不碰数据库」（把 SQL 的 import 拖进 generateMetadata 用的模块，等于让索引口径
 * 依赖数据库连接）。键放这里，两边各取所需，清单仍只有一份。
 *
 * 新增一档要同时改三处：这份清单、仓储层 `ORDERS` 的实现、首页的排序入口。
 * 前两处由类型绑住 —— `ORDERS` 是 `Record<NoticeSortKey, SQL[]>`，少一档编译不过；
 * 第三处漏了不会报错，只是那个排序没人用得上。
 */
export const NOTICE_SORT_KEYS = ['deadline', 'published', 'newest', 'clicks'] as const;

export type NoticeSortKey = (typeof NOTICE_SORT_KEYS)[number];

/** 排序档位的中文说法（首页排序入口与「当前按 X 排序」说明共用一份文案，都不带「按」字）。 */
export const NOTICE_SORT_LABELS: Record<NoticeSortKey, string> = {
  deadline: '截止日期最近',
  published: '发布日期最新',
  newest: '最新收录',
  clicks: '提意见最多',
};

/** querystring 里的排序值是否认识（未知值不生效，与未知领域值同一处理）。 */
export function isNoticeSortKey(value: string): value is NoticeSortKey {
  return (NOTICE_SORT_KEYS as readonly string[]).includes(value);
}
