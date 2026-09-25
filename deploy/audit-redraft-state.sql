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

\echo '=== 7) 重跑了却一条可核对要点都没有的条目：是真没条文可喂，还是喂了没被逐字对上'
-- #67 放量的 49 条里有 6 条属于这种。区分这两种情况决定了下一步该动哪里：
-- `fed_files > 0` 而要点全不带出处 ⇒ 模型没从给定条文里挑可引用的句子（提示词侧 / 模型侧）；
-- `fed_files = 0` ⇒ 抽取或选取层没把条文送进去（`draftSourcesForSummary` 的门槛/预算侧），
-- 那才是代码能修的地方。
with p as (
  select n.id,
         left(n.title, 22) as title,
         n.status,
         n.ai_summary_json::jsonb as doc
    from notices n
   where n.ai_summary_json like '{%'
     and not exists (select 1
                       from jsonb_array_elements(n.ai_summary_json::jsonb -> 'keyPoints') as e(item)
                      where coalesce(e.item ->> 'source', '') <> '')
)
select p.id,
       p.title,
       p.status,
       jsonb_array_length(coalesce(p.doc -> 'keyPoints', '[]'::jsonb))     as points_without_source,
       (select count(*) from notice_attachments a
         where a.notice_id = p.id and a.status = 'ok')                      as ok_files,
       (select count(*) from notice_attachments a
         where a.notice_id = p.id and a.fed_to_summary = 1)                 as fed_files,
       (select coalesce(sum(length(coalesce(a.extracted_text, ''))), 0)
          from notice_attachments a
         where a.notice_id = p.id and a.fed_to_summary = 1)                 as fed_chars
  from p
 order by fed_files desc, fed_chars desc
 limit 15;

\echo '=== 8) 出处对不上的那些长什么样（正常应为 0 行；有行就是缺陷，别放过）'
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

\echo '=== 9) 列联表：附件里有没有条文锚点 × 页面上有没有可核对要点（覆盖率上不去先看这张）'
-- 「要点带不出出处」有两种完全不同的原因：附件里确实没有编号条文（数据实况，不该修），
-- 或有条文但没被逐字对上（提示词 / 截取窗口 / 模型，才是能修的）。锚点判据与
-- `excerptForPrompt` 用的是同一个形状：`第X条`（汉字或数字皆可）。
-- 2026-09-25 实测（#67 放量 49 条之后）的三个格子：无锚点+有要点 29、无锚点+没要点 38、
-- 有锚点+有要点 17，而**"有条文锚点却没对上要点"那一格是 0 行** —— 有锚点却产出不了要点，
-- 才是指向截取窗口/提示词的那种缺陷，本次没有。
-- 反过来别把这张表读成"无锚点 ⇒ 不该有要点"：那 29 条正是无锚点却有可核对要点，
-- 引用形如「本标准规定了…」（`excerptForPrompt` 的锚点窗口之外照样有规范句）。
-- 锚点只能当正向证据，不能当"该不该有要点"的判据。
with per_notice as (
  select n.id,
         (select coalesce(sum((select count(*)
                                 from regexp_matches(f.extracted_text,
                                                     '第[一二三四五六七八九十百0-9]{1,4}条', 'g'))), 0)
            from notice_attachments f
           where f.notice_id = n.id and f.fed_to_summary = 1)          as anchors,
         (select count(*)
            from jsonb_array_elements(n.ai_summary_json::jsonb -> 'keyPoints') as e(item)
           where coalesce(e.item ->> 'source', '') <> '')              as source_points
    from notices n
   where n.ai_summary_json like '{%'
)
select case when anchors > 0 then '附件有条文锚点' else '附件无条文锚点' end as 送进去的附件里,
       case when source_points > 0 then '页面有可核对要点' else '页面没有要点' end as 页面上,
       count(*)                                                    as 条数
  from per_notice
 group by 1, 2
 order by 1, 2;

\echo '=== 10) 抽取文本里"汉字占字符的比例"分布（决定要不要在截取层做空白归一）'
-- 起因：`4815e769` 那条送入摘要的窗口 7,974 字符里只有 1,432 个汉字 —— PDF 逐字定位抽出来的
-- 文本每两个字之间都带空格，再加上一整页目录的点线（............），于是**每份 8,000 字符的
-- 预算被噪声吃掉大半**，模型实际看到的正文比"8,000 字"少得多。
-- 这一段落 distribution：如果低比例（<0.5）的行占可观份额，值得在 `excerptForPrompt` 前
-- 做空白归一 + 点线删除；如果只是零星几条，就别为一行数据改共用逻辑。
with t as (
  select a.notice_id,
         a.status,
         a.fed_to_summary,
         length(coalesce(a.extracted_text, ''))                                    as chars,
         length(regexp_replace(coalesce(a.extracted_text, ''), '[^一-鿿]', '', 'g')) as cjk,
         length(regexp_replace(coalesce(a.extracted_text, ''), '\.{6,}', '', 'g'))   as no_dots
    from notice_attachments a
   where coalesce(a.extracted_text, '') <> ''
)
select case
         when chars < 2000 then 'a. <2k 字'
         when chars < 8000 then 'b. 2k–8k'
         when chars < 20000 then 'c. 8k–20k'
         else 'd. >=20k'
       end                                                        as 抽取规模,
       count(*)                                                   as 文件数,
       round(avg(cjk::numeric / nullif(chars, 0)), 3)              as 平均汉字占比,
       count(*) filter (where cjk::numeric / nullif(chars, 0) < 0.5) as 占比低于一半的文件数,
       count(*) filter (where chars - no_dots > 500)               as 点线超500字符的文件数
  from t
 group by 1
 order by 1;

