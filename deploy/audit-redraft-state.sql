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

\echo '=== 6) 出处正确性（不是"有没有出处字段"，而是**页面上那句引用真的在附件正文里**）'
-- 注意写法：第 2/3 段里裸 `e ->> 'x'` 能跑，而这两段（jsonb_array_elements 出现在 CTE 的
-- select 列表里）同写法报 `column e.quote does not exist`，所以显式命名输出列 `as e(item)`
-- 并用 `e.item`。为什么两种上下文不一样我没查证 —— 这里只记"实测哪一种能跑"，
-- 别顺手把四处统一成同一种写法，那会让其中两处变成跑不了的。
-- 程序侧 `buildQuotedSummary` 本来就要求逐字对上才落库（单测钉着），这一段是拿**线上真数据**
-- 独立复核一遍：如果这里出现 verifiable < total，说明要么落库路径绕过了反查，要么抽取文本
-- 与喂给模型时已经不是同一份。两种都得查。空白全部去掉再比，与程序侧同一个口径（PDF 抽取带换行）。
with p as (
  select n.id,
         e.item ->> 'quote'  as quote,
         e.item ->> 'source' as source
    from notices n,
         jsonb_array_elements(n.ai_summary_json::jsonb -> 'keyPoints') as e(item)
   where n.ai_summary_json like '{%'
     and coalesce(e.item ->> 'source', '') <> ''
     and coalesce(e.item ->> 'quote', '') <> ''
)
select count(*)                                              as points_with_source,
       count(*) filter (where exists (select 1
                                        from notice_attachments a
                                       where a.notice_id = p.id
                                         and regexp_replace(coalesce(a.extracted_text, ''),
                                                            '[[:space:]]', '', 'g')
                                             like '%' || regexp_replace(p.quote, '[[:space:]]', '', 'g') || '%')) as verifiable_in_attachment,
       count(*) filter (where not exists (select 1
                                        from notice_attachments a
                                       where a.notice_id = p.id
                                         and regexp_replace(coalesce(a.extracted_text, ''),
                                                            '[[:space:]]', '', 'g')
                                             like '%' || regexp_replace(p.quote, '[[:space:]]', '', 'g') || '%')) as NOT_found
  from p;

\echo '=== 7) 对不上的那些长什么样（正常应为 0 行；有行就是缺陷，别放过）'
with p as (
  select n.id, left(n.title, 22) as title, e.item ->> 'quote' as quote, e.item ->> 'source' as source
    from notices n,
         jsonb_array_elements(n.ai_summary_json::jsonb -> 'keyPoints') as e(item)
   where n.ai_summary_json like '{%'
     and coalesce(e.item ->> 'source', '') <> ''
     and coalesce(e.item ->> 'quote', '') <> ''
)
select id, title, source, left(regexp_replace(quote, '[[:space:]]', ' ', 'g'), 70) as quote
  from p
 where not exists (select 1
                     from notice_attachments a
                    where a.notice_id = p.id
                      and regexp_replace(coalesce(a.extracted_text, ''), '[[:space:]]', '', 'g')
                           like '%' || regexp_replace(p.quote, '[[:space:]]', '', 'g') || '%')
 limit 10;
