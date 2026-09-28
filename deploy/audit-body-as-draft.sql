-- 只读：没有可读附件的条目，正文里到底是什么？
--
-- 动机：验收门那一批里 `39a2f5f2e4ed3e34`（国信办《国务院关于保障未成年人健康安全使用网络的规定
-- （征求意见稿）》）**一行附件都没有** ⇒ 新管线对它产不出条文要点/判读。而更早那次探针取到的
-- 三部法律草案（道路交通安全法修订草案、企业破产法二次审议稿…）同样是"0 份可读附件"。
-- 如果这些条目的**正文里就是草案全文**，那"没有附件 ⇒ 没有内容"就不是抓取的限制，而是
-- 我们只把附件当条文来源的限制 —— 那是个产品决定，要先量清楚再说。
\pset pager off
\echo '== 没有可读附件的条目：正文长度与开头（按正文长度降序） =='
select n.id,
       n.audience,
       n.deadline_at as 截止,
       coalesce(n.source_id, '-') as 源,
       length(coalesce(n.body_text, '')) as 正文字符,
       replace(left(coalesce(n.body_text, ''), 150), E'\n', ' ') as 正文开头
from notices n
where n.ai_summary_json is not null
  and not exists (
    select 1 from notice_attachments a
     where a.notice_id = n.id and a.status = 'ok' and coalesce(a.char_count, 0) >= 400)
order by length(coalesce(n.body_text, '')) desc
limit 20;

\echo ''
\echo '== 同一批：按源分桶（哪个源的公告壳最长） =='
select coalesce(n.source_id, '-') as 源,
       count(*) as 条目数,
       round(avg(length(coalesce(n.body_text, '')))) as 正文均值字符,
       max(length(coalesce(n.body_text, ''))) as 最长
from notices n
where n.ai_summary_json is not null
  and not exists (
    select 1 from notice_attachments a
     where a.notice_id = n.id and a.status = 'ok' and coalesce(a.char_count, 0) >= 400)
group by 1
order by 3 desc;

\echo ''
\echo '== 另一头：有可读附件的条目里，正文有没有同样很长的（附件的价值到底在哪） =='
select
  count(*) filter (where length(coalesce(n.body_text, '')) > 3000) as 正文超3000且有附件,
  count(*) as 有可读附件的条目
from notices n
where n.ai_summary_json is not null
  and exists (
    select 1 from notice_attachments a
     where a.notice_id = n.id and a.status = 'ok' and coalesce(a.char_count, 0) >= 400);
