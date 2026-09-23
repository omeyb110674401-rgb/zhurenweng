-- 生产数据质量审计（issue #23 复核）：以真实库检验 M2 扩源后的解析质量
\pset border 2
\echo '=== 1. 按来源：条数 / 缺截止日期 / 缺发布日期 / 缺机关 ==='
select source_id,
       count(*)                                                        as 条数,
       count(*) filter (where deadline_at is null)                      as 缺截止,
       count(*) filter (where published_at is null)                     as 缺发布,
       count(*) filter (where agency is null or btrim(agency) = '')     as 缺机关,
       count(*) filter (where agency_keys is null or agency_keys = '')  as 缺机关键
from notices
group by source_id
order by 条数 desc;

\echo '=== 2. 状态分布（open/closed 由截止日期推导，应无异常） ==='
select source_id, status, count(*)
from notices
group by source_id, status
order by source_id, status;

\echo '=== 3. 标题里残留状态标记（解析漏剥） ==='
select source_id, count(*) as 残留条数
from notices
where title ~ '[【\[（(]\s*(进行中|征集中|已结束|已截止)\s*[】\]）)]'
group by source_id
order by 残留条数 desc;

\echo '=== 4. 可疑日期（超出合理区间：1970 前后或 2030 之后，或截止早于发布） ==='
select source_id, id, left(title, 30) as 标题, published_at, deadline_at
from notices
where deadline_at < published_at
   or deadline_at < '2026-01-01'
   or deadline_at > '2030-01-01'
   or published_at < '2024-01-01'
order by deadline_at
limit 15;

\echo '=== 5. 最近 5 条（含时间戳，判断数据新鲜度） ==='
select source_id, left(title, 26) as 标题, published_at::date as 发布, deadline_at::date as 截止,
       status, created_at::date as 入库
from notices
order by created_at desc, published_at desc
limit 5;

\echo '=== 6. 领域标签覆盖（category_tags_json 是否普遍为空） ==='
select source_id,
       count(*) filter (where category_tags_json is null or category_tags_json in ('', '[]')) as 无标签,
       count(*) as 总数
from notices
group by source_id
order by 无标签 desc;

\echo '=== 7. 摘要状态分布（只看不判：口径见 #4 与 #58） ==='
-- 「closed 恒为 pending」是 #4 的入队条件带来的既有事实，不是异常（#58 改的是界面文案，
-- 不改数据）；曾写在这里的「应全为 pending 且无 done」是 AI 端口未配置时的断言，已过期。
select summary_status, count(*)
from notices
group by summary_status
order by 2 desc;
