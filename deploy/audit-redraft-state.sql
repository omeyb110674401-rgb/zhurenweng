-- 只读：存量摘要重跑（issue #67）的现场口径
-- 用法（服务器）：cat deploy/audit-redraft-state.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng

\echo '=== 1) 总量与状态（with_source_points = 详情页真能显示「出处：附件《…」」的条数）'
select count(*)                                              as notices_total,
       count(*) filter (where ai_summary_json is not null)   as with_summary,
       count(*) filter (where ai_summary_json like '{%')     as summary_is_json,
       count(*) filter (where summary_status = 'pending')    as pending,
       count(*) filter (where summary_status = 'failed')     as failed,
       count(*) filter (where status = 'closed')             as closed
  from notices;

\echo '=== 2) 要点带出处的分布（非法 JSON 的行先排除，避免 ::jsonb 直接报错）'
with parsed as (
  select id,
         status,
         ai_summary_json::jsonb as doc
    from notices
   where ai_summary_json like '{%'
)
select count(*)                                                      as json_summaries,
       count(*) filter (where doc ? 'keyPoints')                     as has_keypoints_field,
       count(*) filter (where exists (select 1
                                        from jsonb_array_elements(doc -> 'keyPoints') as e
                                       where jsonb_typeof(e) = 'object'
                                         and coalesce(e ->> 'source', '') <> '')) as with_source_points
  from parsed;

\echo '=== 3) 各条摘要的要点数 / 带出处要点数（按 id 排序，看金丝雀那几条）'
with parsed as (
  select id,
         left(title, 24) as title,
         ai_summary_json::jsonb as doc
    from notices
   where ai_summary_json like '{%'
)
select id,
       jsonb_array_length(doc -> 'keyPoints') as points,
       (select count(*)
          from jsonb_array_elements(doc -> 'keyPoints') as e
         where coalesce(e ->> 'source', '') <> '') as with_source,
       title
  from parsed
 order by with_source desc, points desc, id
 limit 20;

\echo '=== 4) 队列现状（摘要任务下一轮会取哪些）'
select count(*)                                    as queued_now
  from notices
 where ai_summary_json is null
   and summary_status = 'pending'
   and status <> 'closed';

\echo '=== 5) 人工复核那一侧（#56 上线后重置重跑就能成功的存量，是下一次授权的候选）'
select count(*)                                as failed_review_rows,
       count(*) filter (where status <> 'closed') as failed_review_still_open,
       min(substr(published_at, 1, 10))          as oldest_published,
       max(substr(published_at, 1, 10))          as newest_published
  from notices
 where summary_status = 'failed_review';
