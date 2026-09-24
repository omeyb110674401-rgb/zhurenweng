-- 只读：附件文件名进检索索引，到底能多搜到什么（迭代 5 剩余那一刀的判据）
--
-- 为什么要先量再做：这一刀的成本不小（FTS5 虚表加列 + 双方言迁移 + 全量重建索引 +
-- Meilisearch 侧同步字段），而收益完全取决于**文件名里有没有标题之外的词**。
-- 政府附件的命名习惯是两种极端：要么 `《XX技术规范（征求意见稿）》.pdf`（≈标题，加进索引
-- 一个字都不多），要么 `附件1.docx` / `P0202403153XXXX.pdf`（根本没有可搜的词）。
-- 中间那种"文件名写了具体标准号 / 分册名而标题没写"才是要找的增益，得数出来才知道值不值。
--
-- 2026-09-24 首次跑出来的结论：**增益是真的、且集中在最该被搜到的那类条目上** ——
-- 110 个附件行全带名字（分属 56 条公示），73 行的名字主体在标题里找不到（按条目 29/56 = 51.8%），
-- 纯编号名 0 个。样本形如：标题《水质 N,N-二甲基甲酰胺…》那条，附件里另有「海水 汞的测定…」
-- 「固定污染源废气 氨的测定…」——读者按这些词搜，今天找不到这条公示。
--
-- 跑法：cat deploy/audit-filename-search-gain.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng

-- 比"标题里是否已有这个词"之前，两边都去掉空白与中英标点：否则书名号/空格不一样就会被
-- 误判成增益，测出来的数会虚高（这里刻意用同一个字符类，两处各写一遍是为了不建临时函数）
-- 用 temp view 而不是 CTE：psql 按语句分开送，CTE 活不过第一段 SELECT
create temp view flags as
with a as (
  select n.id                                              as notice_id,
         a.name,
         a.status,
         left(n.title, 24)                                 as title,
         trim(regexp_replace(a.name, '\.(pdf|docx|doc|wps|wpt|zip|rar|ofd|txt|xls|xlsx|et|dps)$', '', 'i'))
                                                            as core,
         regexp_replace(n.title, '[[:space:]《》、，。·()（）【】/.:-]', '', 'g') as ntitle
    from notice_attachments a
    join notices n on n.id = a.notice_id
   where coalesce(a.name, '') <> ''
)
select notice_id,
       name,
       core,
       title,
       status,
       length(core) >= 6 as substantive,   -- 短于 6 字符不构成可搜的词
       position(regexp_replace(core, '[[:space:]《》、，。·()（）【】/.:-]', '', 'g') in ntitle) > 0
         as in_title                       -- 标题里已经有（归一化后比）
  from a;
\echo '=== 1) 总量：有名字的附件行、其中"名字主体够长且标题里没有"的有多少'
select count(*)                                             as named_rows,
       count(*) filter (where substantive)                  as rows_with_long_name,
       count(*) filter (where not substantive)              as rows_thin_name,
       count(*) filter (where substantive and not in_title) as rows_adding_terms,
       count(*) filter (where substantive and in_title)     as rows_repeat_title
  from flags;

\echo '=== 2) 按条目算：有多少条公示真能从「文件名进索引」里多搜到东西'
with per_notice as (
  select notice_id,
         count(*) filter (where substantive and not in_title) as adding
    from flags
   group by notice_id
)
select count(*)                                        as notices_with_named_attachments,
       count(*) filter (where adding > 0)              as notices_with_gain,
       round(100.0 * count(*) filter (where adding > 0) / nullif(count(*), 0), 1) as gain_pct
  from per_notice;

\echo '=== 3) 那些"标题里没有的词"长什么样（决定增益是真信息还是编号噪声）'
select left(name, 60) as name, left(title, 24) as title
  from flags
 where substantive and not in_title
 order by notice_id, name
 limit 20;

\echo '=== 4) 反面：纯编号 / 通用前缀的比例（这类加进索引只会让搜索结果变脏）'
select count(*) filter (where name ~ '^(附件|附表|通知|公告|关于)') as generic_prefix,
       count(*) filter (where name ~ 'P?[0-9]{8,}')                as looks_like_id,
       count(*)                                                    as named_rows
  from flags;

\echo '=== 5) 分母：附件行有多少、有多少条目根本没有带名字的附件（覆盖率决定这一刀的上界）'
select count(*)                                              as attachment_rows,
       count(*) filter (where coalesce(name, '') = '')        as rows_without_name,
       count(distinct notice_id)                              as notices_with_attachments,
       count(distinct notice_id) filter (where coalesce(name, '') <> '') as notices_with_named_files,
       count(distinct notice_id) filter (where status = 'ok') as notices_with_readable_files
  from notice_attachments;

\echo '=== 6) 未截止的条目里有多少能受益（读者今天还来得及提意见的那一批才是收益面）'
select count(distinct n.id)                                 as open_notices,
       count(distinct n.id) filter (where coalesce(a.name, '') <> '') as open_with_named_files
  from notices n
  left join notice_attachments a on a.notice_id = n.id
 where n.status <> 'closed';
