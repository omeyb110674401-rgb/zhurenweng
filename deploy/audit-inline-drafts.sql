-- 只读：两个线索的**覆盖面**（决定值不值得做）。
-- ① 正文里就是条文、而没有任何可读附件的条目：全库有多少（不限于已有摘要的）？
-- ② 这些条目的源分布 —— 哪个源习惯把全文放在正文里？
\pset pager off
\echo '== ① 全库：正文带条文形状（>=5 处「第X条」）且没有可读附件 =='
select n.id, n.audience, n.status, n.deadline_at, coalesce(n.source_id,'-') as 源,
       length(n.body_text) as 正文字符,
       (select count(*) from regexp_matches(n.body_text, '第[一二三四五六七八九十百0-9]{1,4}条', 'g')) as 第X条处数,
       (n.ai_summary_json is not null) as 有摘要,
       left(n.title, 30) as 标题
from notices n
where length(coalesce(n.body_text, '')) >= 1500
  and (select count(*) from regexp_matches(coalesce(n.body_text, ''), '第[一二三四五六七八九十百0-9]{1,4}条', 'g')) >= 5
  and not exists (
    select 1 from notice_attachments a
     where a.notice_id = n.id and a.status = 'ok' and coalesce(a.char_count, 0) >= 400)
order by length(n.body_text) desc;

\echo ''
\echo '== ② 全库：正文 >=1500 字符的条目按源分桶（谁把全文放正文里） =='
select coalesce(source_id,'-') as 源, count(*) as 条目数,
       count(*) filter (where exists (
         select 1 from notice_attachments a
          where a.notice_id = notices.id and a.status='ok' and coalesce(a.char_count,0) >= 400)) as 其中也有可读附件
from notices
where length(coalesce(body_text, '')) >= 1500
group by 1 order by 2 desc;
