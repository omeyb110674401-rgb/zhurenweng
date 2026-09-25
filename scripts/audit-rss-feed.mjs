#!/usr/bin/env node
/**
 * 只读：读者今天用 RSS 还拿得到东西吗（issue #75）。
 *
 * 为什么单独量这一条：RSS 是本站三条"读者直接用得着"的入口之一（首页关键词框、/search、
 * /feed.xml），而它和检索是同一族坏法 —— 端点 200、XML 也打得开，只是里面少了最新那批条目
 * 或链接指向了错的域名，读者侧的表现不是报错而是"最近好像没什么新东西"。issue #72 量过检索
 * （抽样 32/32 可搜到）与点击两口径，RSS 那条一直没被产物验证过 —— 与 #68（cron 从未触发）、
 * #70（实际发出 0 封）同属"配置在、代码在、没人验过产出"。
 *
 * 判据不是"feed 有没有响应"，而是**feed 里那批条目等不等于库里今天该出现的那批**：
 * guid 集合、guid 是否都在库里、link 指向哪个站、XML 结构（启发式）分开判，
 * 因为四者的处置完全不同（分别要查同步、查删除、查 SITE_URL、查转义）。
 * 判定与比对都写在 `src/lib/pipeline-health.ts` 的 `auditRssFeed` 里，这个脚本只取数与打印 ——
 * #74 的健康清单走同一份，两处各写一遍迟早一个严一个松（issue #50 的老坑）。
 *
 * 用法（容器里，需要 DATABASE_URL；取哪个地址由 SITE_URL 决定，可 --url 覆盖）：
 *   docker compose run --rm worker node scripts/audit-rss-feed.mjs
 *   docker compose run --rm worker node scripts/audit-rss-feed.mjs --url http://web:3000/feed.xml
 * 退出码：fail ⇒ 非零（将来要接 cron 告警就照这个判）。
 */
import { getDb } from '../src/db/client.ts';
import { listAllNoticesForReindex } from '../src/db/repo/notices.ts';
import { FEED_MAX_ITEMS } from '../src/lib/feed.ts';
import { auditRssFeed } from '../src/lib/pipeline-health.ts';

const argv = process.argv.slice(2);
const at = argv.indexOf('--url');
const siteBase = (process.env.SITE_URL || '').replace(/\/+$/, '');
const url = at >= 0 ? argv[at + 1] : siteBase === '' ? '' : `${siteBase}/feed.xml`;

await getDb();
const all = await listAllNoticesForReindex();
const { check, missingIds, ghostIds, badLinks, feedCount } = await auditRssFeed({
  url,
  siteBase,
  records: all,
  maxItems: FEED_MAX_ITEMS,
});

const mark = { ok: '✓', warn: '!', fail: '✗', unknown: '?' };
console.log(`[audit-rss] 取 ${url || '（没地址）'}：feed 里 ${feedCount} 条 item，库内 ${all.length} 条（上限 ${FEED_MAX_ITEMS}）`);
console.log(`  ${mark[check.verdict]} ${check.name}：${check.detail}`);
for (const id of missingIds.slice(0, 5)) console.log(`  feed 里没有：${id}`);
for (const id of ghostIds.slice(0, 5)) console.log(`  库里没有的 guid：${id}`);
for (const link of badLinks.slice(0, 3)) console.log(`  链接不指向本站：${link}`);
console.log(
  check.verdict === 'fail'
    ? '[audit-rss] 读者今天从 RSS 拿到的东西与库里不一致'
    : check.verdict === 'ok'
      ? '[audit-rss] 读者今天能拿到完整的一批条目'
      : '[audit-rss] 探针没跑成，这一条未验证 —— 别当成通过',
);
process.exit(check.verdict === 'fail' ? 1 : 0);
