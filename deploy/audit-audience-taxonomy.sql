-- 只读审计（issue #83 第 3 问）：为「专业性 / 公众影响面」分类法取现状数据。
-- 不改任何数据。用法同 audit-summary-grounding.sql（stdin 喂给容器里的 psql）。

\echo '---BEGIN---'
\pset pager off

\echo '=== 一、领域标签（category_tags_json）分布：现存 10 个领域谁有量 ==='
select tag, count(*) as rows
  from notices n, jsonb_array_elements_text(n.category_tags_json::jsonb) as tag
 group by tag
 order by rows desc;

\echo ''
\echo '=== 二、标签个数分布（0 = 一条标签都没打上） ==='
select case when jsonb_typeof(n.category_tags_json::jsonb) = 'array'
            then jsonb_array_length(n.category_tags_json::jsonb) else -1 end as tag_count,
       count(*) as rows,
       count(*) filter (where n.status = 'open') as open_rows
  from notices n
 group by 1
 order by 1;

\echo ''
\echo '=== 三、来源分布（源 = 机关范围，是"专业性"的一条现成线索） ==='
select source_id, count(*) as rows,
       count(*) filter (where status = 'open') as open_rows,
       count(distinct agency) as agencies,
       min(left(agency, 14)) as agency_sample
  from notices
 group by source_id
 order by rows desc;

\echo ''
\echo '=== 四、发布机关 top 20 ==='
select agency, count(*) as rows, count(*) filter (where status = 'open') as open_rows
  from notices
 group by agency
 order by rows desc
 limit 20;

\echo ''
\echo '=== 五、open 条目标题全量（分类法必须能在真实的这批标题上落地） ==='
select id, source_id, deadline_at, left(title, 60) as title
  from notices
 where status = 'open'
 order by deadline_at nulls last;
