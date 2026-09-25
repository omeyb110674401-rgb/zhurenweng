#!/usr/bin/env node
/**
 * 只读：线上检索后端**还能不能搜到今天存在的条目**（issue #72）。
 *
 * 为什么需要它：检索是本站三条"读者直接用得着"的入口之一（首页关键词框、/search、RSS），
 * 而它的后端是外部服务（生产为 Meilisearch）。这类东西的典型坏法不是报错，是**静默少结果**：
 * 索引没同步、任务失败、后端换过、集合被清过 —— 页面全都 200，只是搜不到。
 * issue #68 与 #70 连着抓到两个同族问题（cron 从未触发、提醒路径发出 0 封），
 * 共同点是"配置在、代码在、没人验过产出"，所以这一条不靠推断，靠抽样真搜一次。
 *
 * 判据是**自证式抽样**：按 id 排序每 `STRIDE` 条取一条，拿它自己标题里的特征片段去搜，
 * 看它自己有没有出现在前 `PER_PAGE` 条里。漏了分三种：`total=0`（多半根本没进索引）、
 * `total>0 但没排进来`（排序/分词）、以及**单条查询报错**（后端故障）—— 处置各不相同，
 * 所以都要打出来，不能混成"漏一条"。
 *
 * 抽样函数与 #74 的健康清单**共用同一份**（`auditIndexSampling`）：两处各写一遍迟早
 * 一个严一个松 —— issue #50 修过一模一样的病（同一个查询在三条路径给出三种结果）。
 *
 * 用法（容器里，需要 DATABASE_URL 与检索后端配置）：
 *   docker compose run --rm worker node scripts/audit-search-index.mjs
 *   docker compose run --rm worker node scripts/audit-search-index.mjs --stride 4 --per-page 30
 * 退出码：有漏网 ⇒ 非零（将来接 cron 告警就照这个判，见 #74 的"未做"）。
 */
import { getDb } from '../src/db/client.ts';
import { listAllNoticesForReindex } from '../src/db/repo/notices.ts';
import { createSearchPort } from '../src/lib/ports.ts';
import { auditIndexSampling } from '../src/lib/pipeline-health.ts';

const argv = process.argv.slice(2);
const numArg = (name, dflt) => {
  const at = argv.indexOf(name);
  return at >= 0 ? Number(argv[at + 1]) || dflt : dflt;
};
const STRIDE = Math.max(1, numArg('--stride', 8));
const PER_PAGE = Math.max(1, numArg('--per-page', 20));
const MAX_SAMPLES = Math.max(1, numArg('--max', 40));

await getDb();   // 库连不上就直接失败，别到搜索那步才报
const all = await listAllNoticesForReindex();
const port = createSearchPort();

console.log(
  `[audit-search] provider=${port.provider} 库内 ${all.length} 条，` +
    `每 ${STRIDE} 条取 1（最多 ${MAX_SAMPLES} 条），前 ${PER_PAGE} 名内算命中`,
);

const { checked, missed } = await auditIndexSampling(port, all, {
  stride: STRIDE,
  perPage: PER_PAGE,
  max: MAX_SAMPLES,
});

for (const miss of missed.slice(0, 12)) {
  const kind =
    miss.total === -1
      ? `查询报错：${miss.why}`
      : miss.total === 0
        ? '索引里查不到（多半没同步）'
        : `有 ${miss.total} 条命中但没排进前 ${PER_PAGE}`;
  console.log(`  漏 ${miss.id}  词「${miss.query}」  ${kind}`);
}
if (missed.length > 12) console.log(`  …另 ${missed.length - 12} 条`);

console.log(
  missed.length === 0
    ? `[audit-search] ${checked}/${checked} 条都能被搜到`
    : `[audit-search] ${missed.length}/${checked} 条搜不到 —— 读者今天用检索找不到它们`,
);
process.exit(missed.length === 0 ? 0 : 1);
