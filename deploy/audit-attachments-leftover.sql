-- 只读：附件抽取的「不达标」与「还挂着没处理」的行分别是什么形状（issue #57 遗留核对）

\echo '=== 1) ok 但条文很薄（< 3000 汉字）：这些真喂给摘要有用吗'
select n.source_id,
       a.char_count,
       a.kind,
       a.bytes,
       left(n.title, 30)                                             as title,
       left(regexp_replace(a.extracted_text, '\s+', ' ', 'g'), 40)    as head
  from notice_attachments a
  join notices n on n.id = a.notice_id
 where a.status = 'ok' and a.char_count < 3000
 order by a.char_count
 limit 20;

\echo '=== 2) too_large：到底多大，上限该不该动'
select n.source_id,
       round(a.bytes / 1048576.0, 1)   as mb_declared,
       a.kind,
       left(n.title, 30)               as title
  from notice_attachments a
  join notices n on n.id = a.notice_id
 where a.status = 'too_large'
 order by a.bytes desc;

\echo '=== 3) pending / error 卡在哪：有没有发过请求、试过几次'
select n.source_id,
       a.status,
       (a.last_fetch_at is null)       as 从未请求,
       a.attempt_count,
       count(*)                        as 行数
  from notice_attachments a
  join notices n on n.id = a.notice_id
 where a.status in ('pending', 'error')
   and n.status <> 'closed'
 group by 1, 2, 3, 4
 order by 1, 行数 desc;

\echo '=== 4) 已截止的公示还占着多少行（清理口径）'
select n.source_id,
       count(distinct n.id)            as 公示,
       count(*)                        as 附件行,
       count(*) filter (where a.status = 'ok') as 其中_ok,
       pg_size_pretty(sum(length(coalesce(a.extracted_text, '')))::bigint) as 文本量
  from notice_attachments a
  join notices n on n.id = a.notice_id
 where n.status = 'closed'
 group by 1
 order by 附件行 desc;

\echo '=== 5) 判成 ok 却一行字都没有（判据自相矛盾）'
select n.source_id, a.status, a.char_count, a.bytes, left(n.title, 30) as title
  from notice_attachments a
  join notices n on n.id = a.notice_id
 where a.status = 'ok' and coalesce(a.char_count, 0) = 0;

\echo '=== 6) 各状态总行数（对照 shadow 轮的失败面）'
select a.status, count(*) from notice_attachments a group by 1 order by 2 desc;
