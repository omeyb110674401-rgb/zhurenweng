-- 只读：追两个线索。
-- ① cac 那条 6,912 字符的正文里到底有没有条文（「第X条」）与对照措辞（「修改为」）？
--    如果有，那"没有附件 ⇒ 没有内容"留在地上的就是一条真正的公众广域条目。
-- ② 五条 npc 法律草案的正文字符 ≤234 且没有可读附件 —— 它们的全文在哪（正文里有没有链接/提示）？
\pset pager off
\echo '== ① cac 那条：正文的形状 =='
select id,
       length(body_text) as 字符,
       (select count(*) from regexp_matches(body_text, '第[一二三四五六七八九十百0-9]{1,4}条', 'g')) as 第X条处数,
       (select count(*) from regexp_matches(body_text, '修改为|修改如下|删去|增加一款|修订前后', 'g')) as 对照措辞处数,
       left(replace(substr(body_text, 400, 220), E'\n', ' '), 200) as 第400字符起
from notices
where id = '39a2f5f2e4ed3e34';

\echo ''
\echo '== ② npc 那五条：正文全文（都很短，整段打出来看） =='
select id, deadline_at as 截止, url, replace(body_text, E'\n', ' ') as 正文
from notices
where source_id = 'npc'
  and not exists (
    select 1 from notice_attachments a
     where a.notice_id = notices.id and a.status = 'ok' and coalesce(a.char_count, 0) >= 400)
order by deadline_at
limit 5;
