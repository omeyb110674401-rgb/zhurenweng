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

\echo '=== 7) 抽取文本的"逐字空格 / 目录点线"有多普遍（决定该不该在截取前做空白归一）'
-- 起因（issue #67）：`4815e769` 那条附件抽出 48,543 字，但真正送进提示词的 7,974 个字符里
-- 只有 1,432 个汉字 —— PDF 逐字定位抽出来的文本每两个字中间都有空格，加上封皮与目录的点线，
-- **每份 8,000 字符的预算被噪声吃掉大半**。如果这是普遍现象，修 `excerptForPrompt` 之前的
-- 归一是高收益的；如果只有零星几条，就别为一行数据动共用逻辑。
-- 判据：汉字占字符比 <0.55 视为"逐字空格"（正常中文正文通常 ≥0.8）。
with t as (
  select a.notice_id,
         a.fed_to_summary,
         coalesce(a.extracted_text, '')                                       as txt,
         length(coalesce(a.extracted_text, ''))                               as chars,
         length(regexp_replace(coalesce(a.extracted_text, ''), '[^一-鿿]', '', 'g')) as cjk
    from notice_attachments a
   where a.status = 'ok' and coalesce(a.extracted_text, '') <> ''
)
select count(*)                                                    as ok_files,
       count(*) filter (where cjk::numeric / chars < 0.55)          as 逐字空格的,
       count(*) filter (where chars - length(regexp_replace(txt, '\.{8,}', '', 'g')) > 500)
                                                                   as 目录点线超500字符,
       count(*) filter (where fed_to_summary = 1)                   as 送入过摘要的,
       count(*) filter (where fed_to_summary = 1 and cjk::numeric / chars < 0.55)
                                                                   as 送入过摘要且逐字空格,
       round(avg(cjk::numeric / chars), 3)                          as 平均汉字占比,
       round(min(cjk::numeric / chars), 3)                          as 最低占比
  from t;

