-- 只读审计（issue #83）：AI 摘要的「输入依据」分层 —— 哪些摘要真的读了附件条文，
-- 哪些只依据公示页信息。不改任何数据：一条 create temp view（会话级临时对象，
-- 会话结束即消失）+ 全是 select。
--
-- 用法（生产，只读）：
--   docker compose exec -T db psql -U zhurenweng -d zhurenweng < /tmp/audit-summary-grounding.sql
--
-- 判据三轴：
--   1) 附件侧（notice_attachments）：att_total / ok_files（status='ok'，抽出了条文）/
--      fed_files / fed_chars（fed_to_summary=1，本轮摘要真的用了它）
--   2) 摘要侧（ai_summary_json）：keyPoints / explanationPoints / changes 是否非空 ——
--      这三栏**只有喂了附件正文才可能产出**（见 lib/summary-content.ts 的反查不变量）
--   3) 模板侧：'explanationPoints' 这个键在不在 —— issue #76 之后的代码才会写它；
--      键缺席 = 摘要生成于旧模板，与「有没有附件」是两件不同的事
--
-- 注意：ai_summary_json 是 TEXT 列，键缺席时 `-> 'keyPoints'` 返回 SQL NULL，
-- 但值写成 JSON null 时 `->` 返回 jsonb 'null'，对后者直接 jsonb_array_length 会报错
-- （issue #78 那族误报的来源）—— 因此统一先判 jsonb_typeof。

\echo '---BEGIN---'
\pset pager off

create temp view grounding as
with att as (
  select notice_id,
         count(*) as att_total,
         count(*) filter (where status = 'ok') as ok_files,
         count(*) filter (where fed_to_summary = 1) as fed_files,
         coalesce(sum(char_count) filter (where fed_to_summary = 1), 0) as fed_chars
    from notice_attachments
   group by notice_id
),
base as (
  select n.id,
         n.status,
         n.genre,
         n.deadline_at,
         n.source_id,
         n.title,
         coalesce(a.att_total, 0) as att_total,
         coalesce(a.ok_files, 0) as ok_files,
         coalesce(a.fed_files, 0) as fed_files,
         coalesce(a.fed_chars, 0) as fed_chars,
         case when n.ai_summary_json is null then null else n.ai_summary_json::jsonb end as j
    from notices n
    left join att a on a.notice_id = n.id
),
shaped as (
  select base.*,
         (j is not null) as has_summary,
         (j ? 'explanationPoints') as new_template,
         case when jsonb_typeof(j -> 'keyPoints') = 'array'
              then jsonb_array_length(j -> 'keyPoints') else 0 end as kp,
         case when jsonb_typeof(j -> 'explanationPoints') = 'array'
              then jsonb_array_length(j -> 'explanationPoints') else 0 end as ep,
         case when jsonb_typeof(j -> 'changes') = 'array'
              then jsonb_array_length(j -> 'changes') else 0 end as ch
    from base
)
select shaped.*,
       case
         when not has_summary then '0_无摘要'
         when kp > 0 or ep > 0 or ch > 0 then '1_附件要点已产出'
         when fed_chars > 0 then '2_喂过附件但零要点'
         when ok_files > 0 then '3_有可读附件但没喂过'
         when att_total > 0 then '4_附件读不到'
         else '5_无附件（只能依据公示页）'
       end as bucket
  from shaped;

\echo '=== 一、依据分层 × 是否新模板 × 是否仍在征集 ==='
select bucket,
       new_template as new_tpl,
       case when status = 'open' then 'open' else 'closed' end as live,
       count(*) as rows
  from grounding
 where has_summary
 group by 1, 2, 3
 order by 1, 2, 3;

\echo ''
\echo '=== 二、有摘要的总数与分层合计（对账用） ==='
select count(*) filter (where has_summary) as with_summary,
       count(*) filter (where not has_summary) as without_summary,
       count(*) as total
  from grounding;

\echo ''
\echo '=== 三、重跑候选：open 且「有可读附件但摘要零要点」 ==='
select id, genre, deadline_at, ok_files, fed_files, fed_chars, kp, ep, ch, new_template,
       left(title, 40) as title
  from grounding
 where status = 'open' and ok_files > 0 and kp = 0 and ep = 0 and ch = 0
 order by deadline_at nulls last;

\echo ''
\echo '=== 四、open 且已有附件要点（已优化的样本，前 15） ==='
select id, genre, deadline_at, ok_files, fed_chars, kp, ep, ch, new_template,
       left(title, 40) as title
  from grounding
 where status = 'open' and (kp > 0 or ep > 0 or ch > 0)
 order by new_template desc, deadline_at nulls last
 limit 15;

\echo ''
\echo '=== 五、open 且无任何附件（摘要只能依据公示页 —— 不是缺陷，但页面该说清楚） ==='
select count(*) as rows, count(*) filter (where has_summary) as has_summary,
       count(*) filter (where new_template) as new_tpl
  from grounding
 where status = 'open' and att_total = 0;
