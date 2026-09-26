-- 体裁分桶与「收窄词表后哪些条目会换桶」只读核对（issue #79 / #81）
--
-- 用途：`--force` 回填**前后**各跑一次，比对分桶与逐条走向。预期（2026-09-26 实测基线）：
--   回填前 amendment 52 / new_draft 107 / package_plan 25 / unknown 5 / list_or_result 3
--   回填后 amendment 47 / new_draft 112（那 22 条里 17 条仍是修正案、5 条变成新案）
-- 若回填后仍是 52，最可能的原因是漏了 `--force`：覆盖规矩会把"标题级证据"挡在
-- "附件正文级证据"门外，改动一条都落不了地（详见 docs/pending-issues/81-*.md 第二节）。
--
-- 跑法（服务器上仓库目录里执行）：
--   cat deploy/audit-genre-rebucket.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng
--
-- 只读：本文件里只有 SELECT。

\pset tuples_only off
\pset format aligned

-- ① 全库分桶（回填前后对比这一张表）
select coalesce(genre, 'NULL') as 体裁, count(*) as 条数
from notices
group by genre
order by 条数 desc;

-- ② 修正案按判据分桶：哪些是标题判的、哪些靠附件正文、哪些靠附件名
select genre_evidence as 证据, count(*) as 条数,
       count(*) filter (where genre_basis like '%现行%') as 依据里含现行
from notices
where genre = 'amendment'
group by genre_evidence
order by 条数 desc;

-- ③ 收窄词表后"会换桶"的那批：证据是附件正文、依据写着「现行」的条目，
--    按当前代码的分支顺序推出它该落到哪一桶（前三档对这批必为假，理由见 81-*.md 第二节）
select case
         when title ~ '修正|修订' then 'amendment（标题）'
         when title ~ '草案|征求意见稿|办法|规定|规则|规程|导则|规范|指南|条例|实施细则|技术文件' then 'new_draft'
         else 'unknown'
       end as 新桶,
       count(*) as 条数
from notices
where genre = 'amendment' and genre_evidence = 'attachment_text' and genre_basis like '%现行%'
group by 1
order by 2 desc;

-- ④ 逐条名单（回填前看一眼有没有不该动的）
select left(id, 8) as id,
       case
         when title ~ '修正|修订' then 'amendment'
         when title ~ '草案|征求意见稿|办法|规定|规则|规程|导则|规范|指南|条例|实施细则|技术文件' then 'new_draft'
         else 'unknown'
       end as 新桶,
       left(title, 40) as 标题
from notices
where genre = 'amendment' and genre_evidence = 'attachment_text' and genre_basis like '%现行%'
order by 2, 1;

-- ⑤ 读者可见面：52 条修正案里有多少条真带着"改动点"
--    正确判据是 jsonb_array_length（"键在不在"这种问法永远不会失败，见 78-*.md 的 A3）
select count(*) filter (where ai_summary_json is not null) as 有摘要,
       count(*) filter (where ai_summary_json ~ '^\s*\{'
                          and jsonb_array_length(ai_summary_json::jsonb -> 'changes') > 0) as 改动点非空,
       count(*) filter (where ai_summary_json ~ '^\s*\{'
                          and (ai_summary_json::jsonb ? 'changeMarkers')) as 带过覆盖度键
from notices
where genre = 'amendment';
