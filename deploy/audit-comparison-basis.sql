-- 只读审计（issue #86 开工前）：AI 摘要要新增的两条路，各自的依据在生产库里到底有多少。
--
-- 两条路各自需要不同的输入，缺一不可：
--   ① 「影响判读」需要**可读的条文正文**（附件抽出来、且真的喂进了提示词）；
--   ② 「改了哪几处」对照表需要**官方给出的对照依据**（附件叫对照表，或说明/正文里逐条写着
--      「第X条修改为…」）—— 本站没有现行法全文，所以这一条只能从官方对照里抽，不能自己算。
--
-- 全 SELECT，不改任何数据。用法：
--   docker compose cp deploy/audit-comparison-basis.sql db:/tmp/q.sql
--   docker compose exec -T db psql -U zhurenweng -d zhurenweng -f /tmp/q.sql

\pset pager off

\echo '== 1. 规模：总数 / 未截止 / 有摘要 / 公众广域 =='
select count(*) as 总条目,
       count(*) filter (where status = 'open') as 未截止,
       count(*) filter (where ai_summary_json is not null) as 有摘要,
       count(*) filter (where audience = 'public') as 公众广域,
       count(*) filter (where audience = 'public' and status = 'open') as 公众广域未截止_
from notices;

\echo ''
\echo '== 2. 附件名里带「对照」的条目（最硬的对照依据） =='
select n.id, n.status, n.deadline_at, a.status as 抽取状态,
       a.fed_to_summary as 喂过, a.char_count as 字数, a.name
from notice_attachments a
join notices n on n.id = a.notice_id
where a.name like '%对照%'
order by n.status, n.id;

\echo ''
\echo '== 3. 附件正文里含对照措辞的条目（按 是否未截止 x 是否有摘要 分桶） =='
select n.status, (n.ai_summary_json is not null) as 有摘要,
       count(distinct n.id) as 条目数, count(*) as 附件数
from notices n
join notice_attachments a on a.notice_id = n.id
where a.extracted_text like '%修改为%'
   or a.extracted_text like '%修改如下%'
   or a.extracted_text like '%删去%'
   or a.extracted_text like '%增加一款%'
   or a.extracted_text like '%修订前后%'
group by 1, 2
order by 1, 2;

\echo ''
\echo '== 4. 编制说明类附件：抽取状态与是否喂过摘要 =='
select a.status as 抽取状态, count(*) as 附件数, sum(a.fed_to_summary) as 喂过摘要的
from notice_attachments a
where a.name like '%说明%'
group by 1
order by 2 desc;

\echo ''
\echo '== 5. 判读层真正能跑的那一批：未截止 x 有可读条文 =='
select n.audience,
       count(distinct n.id) as 条目数,
       count(*) as 可读附件数
from notices n
join notice_attachments a on a.notice_id = n.id
where n.status = 'open'
  and a.status = 'ok'
  and coalesce(a.char_count, 0) > 0
group by 1
order by 2 desc;

\echo ''
\echo '== 7. 含对照措辞的那几条：附件逐个看（对照措辞落在条文里还是说明里） =='
select n.id, n.genre, n.audience, a.status as 抽取状态, a.fed_to_summary as 喂过,
       (a.extracted_text like '%修改为%' or a.extracted_text like '%修改如下%'
        or a.extracted_text like '%删去%' or a.extracted_text like '%增加一款%'
        or a.extracted_text like '%修订前后%') as 含对照,
       a.char_count as 字数, left(a.name, 38) as 附件名
from notices n
join notice_attachments a on a.notice_id = n.id
where n.id in (
  select distinct n2.id from notices n2
  join notice_attachments a2 on a2.notice_id = n2.id
  where a2.extracted_text like '%修改为%' or a2.extracted_text like '%修改如下%'
     or a2.extracted_text like '%删去%' or a2.extracted_text like '%增加一款%'
     or a2.extracted_text like '%修订前后%')
order by n.id, a.status, a.url;

\echo ''
\echo '== 8. 未截止的 78 条：受众面 x 是否有摘要 =='
select audience, (ai_summary_json is not null) as 有摘要, count(*) as 条目数
from notices
where status = 'open'
group by 1, 2
order by 1, 2;

\echo ''
\echo '== 6. 未截止且有可读条文的条目清单（滚动窗口，最多 40 条） =='
select n.id, n.audience, n.deadline_at, n.genre,
       count(*) as 可读附件, sum(coalesce(a.char_count, 0)) as 总字数,
       left(n.title, 46) as 标题
from notices n
join notice_attachments a on a.notice_id = n.id
where n.status = 'open' and a.status = 'ok' and coalesce(a.char_count, 0) > 0
group by n.id, n.audience, n.deadline_at, n.genre, n.title
order by n.deadline_at nulls last, n.id
limit 40;
