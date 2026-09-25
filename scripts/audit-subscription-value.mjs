#!/usr/bin/env node
/**
 * 只读：订阅规则在**今天的生产数据上**实际会命中多少条（issue #73）。
 *
 * 为什么需要它：迭代 4 的四刀都已上线并有 e2e 覆盖，但"上线"不等于"有人能收到东西"——
 * 09-25 实测 `reminder_sends` 与 `notice_notifications` 各 0 行（可发订阅者为 0，唯一那条
 * 是站长本人且确认当天就退订）。要判断这套闭环值不值继续投入，缺的从来不是代码，
 * 而是"如果现在有人按这些规则订阅，他一周会收到几条"这个数。
 *
 * 判据复用发信任务同一份 `matchesSubscriptionRules()`（不重写规则），条目集合与提醒/通知
 * 任务一样按**库列** `status='open'` 算（不是展示层的 effectiveStatus —— 发信用的就是前者）。
 *
 * 用法（容器里，需要 DATABASE_URL）：
 *   docker compose run --rm worker node scripts/audit-subscription-value.mjs
 * 只读：仅 SELECT，不写库、不发信。
 */
import { getDb } from '../src/db/client.ts';
import { subscriptions } from '../src/db/schema/sqlite.ts';
import { listAllNoticesForReindex } from '../src/db/repo/notices.ts';
import { matchesSubscriptionRules } from '../src/lib/subscription.ts';
import { recencyCutoffIso } from '../src/lib/notice-recency.ts';
import { daysUntil } from '../src/lib/dates.ts';
import { safeParseJson } from '../src/db/types.ts';

const db = await getDb();   // 连不上就直接失败
const subRows = await db.select().from(subscriptions).orderBy(subscriptions.createdAt);
const all = await listAllNoticesForReindex();
const open = all.filter((row) => row.status === 'open');
const now = new Date();
const weekAgo = recencyCutoffIso(now, 7);

function asStringArray(raw) {
  const parsed = safeParseJson(raw);
  return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
}

/** 一条订阅按现有规则能命中什么：命中总数、其中本周新收录（= 通知会发的量）、截止 7 天内（= 提醒会发的量） */
function evaluate(subscription) {
  const hits = open.filter((notice) => matchesSubscriptionRules(subscription, notice));
  return {
    hits: hits.length,
    newThisWeek: hits.filter((notice) => (notice.firstSeenAt ?? '') >= weekAgo).length,
    reminding: hits.filter((notice) => {
      const days = daysUntil(notice.deadlineAt, now);
      return days !== null && days >= 0 && days <= 7;
    }).length,
  };
}

console.log(
  `[audit-subscription] 条目 ${all.length} 条（库列 open ${open.length} 条），` +
    `订阅记录 ${subRows.length} 条，本周（7 天）新收录 ${
      open.filter((row) => (row.firstSeenAt ?? '') >= weekAgo).length
    } 条`,
);

for (const row of subRows) {
  const subscription = {
    keywords: asStringArray(row.keywordsJson),
    categories: asStringArray(row.categoriesJson),
    agencies: asStringArray(row.agenciesJson),
    scope: row.scope,
  };
  const stat = evaluate(subscription);
  const pending = row.pendingRulesJson ? '（另有未确认的改动待生效）' : '';
  console.log(
    `  ${row.email}  状态=${row.confirmed ? '已确认' : '未确认'}${row.unsubscribedAt ? '+已退订' : ''}` +
      `  规则=[关键词 ${JSON.stringify(subscription.keywords)} 领域 ${JSON.stringify(subscription.categories)}` +
      ` 机关 ${JSON.stringify(subscription.agencies)} 订全部=${subscription.scope === 'all'}]${pending}`,
  );
  console.log(
    `    ⇒ 命中 open ${stat.hits} 条；本周新收录 ${stat.newThisWeek} 条（新公示通知的量）；` +
      `7 天内截止 ${stat.reminding} 条（截止提醒的量）`,
  );
}

// 天花板：订全部会是什么量，用来对照"规则订阅"到底是收窄还是几乎没收窄
const everything = evaluate({ keywords: [], categories: [], agencies: [], scope: 'all' });
console.log(
  `  【天花板：scope=all】命中 ${everything.hits} 条 / 本周新收录 ${everything.newThisWeek} 条` +
    ` / 7 天内截止 ${everything.reminding} 条`,
);
console.log('[audit-subscription] 只读：未发任何邮件，未改任何数据');
process.exit(0);
