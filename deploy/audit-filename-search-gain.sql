-- 只读：附件文件名进检索索引，到底能多搜到什么（迭代 5 剩余那一刀的判据）
--
-- 为什么要先量再做：这一刀的成本不小（FTS5 虚表加列 + 迁移 + 全量重建 + Meilisearch 加字段，
-- 还要按 #50 的教训同步首页关键词筛选与 PG 兜底那条路径），而收益完全取决于
-- **文件名里有没有"索引里已经有的东西"之外的词**。
--
-- 关键判据是跟**整份被索引的文档**比，不是只跟标题比。`SearchDocument` 的字段是
-- title + summary + body（见 `src/lib/search/search-text.ts` 的 `buildSearchDocument`），
-- 所以只比标题会把"标题没写但正文列了"的那些标准名误算成增益 —— 第一版就是这么错的：
-- 按标题量出 51.8% 的条目"有增益"，抽样却看到搜「海水 汞的测定」在今天就命中那条公示
-- （正文里本来就逐项列了），于是改成下面这份三字段一起比。
--
-- 2026-09-24 重测的结论：**这一刀降级不做**（与迭代 3 同类 —— 先量再做，量完就不做）。
-- 只剩 12/110 行、5/56 条目（8.9%）是"今天真搜不到"，其中 61 行是"标题没写但正文写了"的假增益；
-- 而那 12 行全是 `附件1：《X》起草说明 / 编制说明 / 申报汇总表` 这种"标题 + 文书类型后缀"，
-- 新增的可搜词只有那几个通用词，不含任何新主题。附件命名习惯哪天变了就重跑本文件：
-- 两个口径都留在里面，就是为了能直接看出差异有多大。
--
-- 跑法：cat deploy/audit-filename-search-gain.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng

-- 比之前两边都去掉空白与中英标点：否则书名号/空格不一样就会被误判成增益（两处各写一遍是为了
-- 不建临时函数；temp view 而不是 CTE —— psql 按语句分开送，CTE 活不过第一段 SELECT）
create temp view flags as
with a as (
  select n.id                                              as notice_id,
         a.name,
         a.status,
         left(n.title, 20)                                 as title,
         n.title                                           as raw_title,
         trim(regexp_replace(a.name, '\.(pdf|docx|doc|wps|wpt|zip|rar|ofd|txt|xls|xlsx|et|dps)$', '', 'i'))
                                                            as core,
         -- 今天真正被索引的那一份：标题 + 正文 + AI 摘要（摘要列是 JSON 文本，字段名与
         -- 引用原文也在里面，比"只比 text"更宽松，所以这里是保守估计）
         concat(' ', n.title, ' ', coalesce(n.body_text, ''), ' ', coalesce(n.ai_summary_json, ''))
                                                            as indexed_doc
    from notice_attachments a
    join notices n on n.id = a.notice_id
   where coalesce(a.name, '') <> ''
)
select notice_id,
       name,
       core,
       title,
       status,
       length(core) >= 6 as substantive,
       -- 只比标题（旧口径，留着看两者的差）
       position(regexp_replace(core, '[[:space:]《》、，。·()（）【】/.:-]', '', 'g')
                in regexp_replace(raw_title, '[[:space:]《》、，。·()（）【】/.:-]', '', 'g')) > 0
         as in_title,
       -- 比整份被索引的文档（这才是"今天搜不到"的判据）
       position(regexp_replace(core, '[[:space:]《》、，。·()（）【】/.:-]', '', 'g')
                in regexp_replace(indexed_doc, '[[:space:]《》、，。·()（）【】/.:-]', '', 'g')) > 0
         as in_indexed_doc
  from a;

\echo '=== 1) 两种口径的差：按标题算的"增益"有多少其实正文里已经有了'
select count(*)                                              as named_rows,
       count(*) filter (where substantive and not in_title)  as missing_from_title,
       count(*) filter (where substantive and not in_indexed_doc) as missing_from_index,
       count(*) filter (where substantive and not in_title and in_indexed_doc) as false_gain_body_has_it
  from flags;

\echo '=== 2) 按条目算：真正"今天搜不到、加了文件名才搜得到"的条目有多少'
with per_notice as (
  select notice_id,
         count(*) filter (where substantive and not in_indexed_doc) as adding
    from flags
   group by notice_id
)
select count(*)                                         as notices_with_named_attachments,
       count(*) filter (where adding > 0)               as notices_with_real_gain,
       round(100.0 * count(*) filter (where adding > 0) / nullif(count(*), 0), 1) as gain_pct
  from per_notice;

\echo '=== 3) 那些"整份索引里都没有的词"长什么样（决定增益是真信息还是编号噪声）'
select name, title, status
  from flags
 where substantive and not in_indexed_doc
 order by notice_id, name
 limit 20;

\echo '=== 4) 反面：纯编号 / 通用前缀的比例（这类加进索引只会让结果变脏）'
select count(*) filter (where name ~ '^(附件|附表|通知|公告|关于)') as generic_prefix,
       count(*) filter (where name ~ 'P?[0-9]{8,}')                as looks_like_id,
       count(*)                                                    as named_rows
  from flags;
