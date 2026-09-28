-- 只读审计（issue #86 第 3 刀开工前）：摘要窗口的预算该定多大。
--
-- 为什么需要它：预算（issue #86 第 3 刀起按受众面分档）落在 `src/lib/attachment-feed.ts`，
-- 而它从来没有按「附件到底多大」核对过。两个数字都可能不够，而**不够的表现是静默的**：
-- `excerptForPrompt` 结构性截取之后，排在后面的那一份拿不到预算就整份不送，库里看不出任何异常。
--
-- ⚠️ 2026-09-27 实测的教训：**字符数不是汉字数**。这份脚本给的是 `char_count`（抽取文本去空白后的
-- 字符数），而预算是按**汉字**记的 —— 那批环保标准的汉字密度只有约 0.35（化学名与拉丁字母占大半），
-- 按 char_count 推"预算不够了"会推出一个不存在的结论（我第一版就这么错了）。
-- 要看"真的送进去了哪一截"，跑 `scripts/audit-draft-window.mjs <noticeId>`（它走生产同一份判据）。
--
-- 这份脚本回答三件事：
--   ① 未截止的公众广域条目（= 用户拍板的"重管线"那一档）手里到底有几份附件、多大；
--   ② 全库里超过单份上限 / 总预算的附件有多少（按受众面分）；
--   ③ 按喂入顺序（字数降序）累加，第几份开始会被总预算挤掉 —— 挤掉的那份是说明还是条文。
--
-- 全 SELECT，不改任何数据。用法：
--   docker compose cp deploy/audit-feed-window.sql db:/tmp/q.sql
--   docker compose exec -T db psql -U zhurenweng -d zhurenweng -f /tmp/q.sql

\pset pager off

\echo '== 1. 未截止的公众广域条目：附件逐个看 =='
select n.id, coalesce(n.genre, '-') as 体裁, n.deadline_at,
       a.status as 抽取状态, coalesce(a.char_count, 0) as 字数, a.fed_to_summary as 喂过,
       case when a.name like '%说明%' then '说明'
            when a.name like '%对照%' then '对照'
            else '其他' end as 角色粗判,
       left(a.name, 40) as 附件名
from notices n
join notice_attachments a on a.notice_id = n.id
where n.audience = 'public' and n.status = 'open'
order by n.id, coalesce(a.char_count, 0) desc;

\echo ''
\echo '== 2. 同一批：按条目汇总（最长附件 vs 单份上限 8000；总字数 vs 总预算 12000） =='
select n.id,
       count(*) filter (where a.status = 'ok') as 可读附件,
       max(coalesce(a.char_count, 0)) as 最长附件,
       sum(coalesce(a.char_count, 0)) as 附件总字数,
       count(*) filter (where a.name like '%说明%') as 说明份数,
       left(n.title, 36) as 标题
from notices n
join notice_attachments a on a.notice_id = n.id
where n.audience = 'public' and n.status = 'open'
group by n.id, n.title
order by sum(coalesce(a.char_count, 0)) desc;

\echo ''
\echo '== 3. 全库：超过当前预算的附件有多少（按受众面分） =='
select coalesce(n.audience, '(null)') as 受众面,
       count(*) filter (where coalesce(a.char_count, 0) > 8000) as 超单份上限,
       count(*) filter (where coalesce(a.char_count, 0) > 12000) as 超总预算,
       count(*) as 可读附件
from notices n
join notice_attachments a on a.notice_id = n.id
where a.status = 'ok'
group by 1
order by 4 desc;

\echo ''
\echo '== 4. 喂入顺序模拟（按字数降序累加）：总预算 12000 在第几份上被吃光 =='
select t.id, t.序号, t.字数, t.累计字数,
       (t.累计字数 - t.字数) >= 12000 as 上一份就已超预算_整份被丢,
       t.角色粗判, t.附件名
from (
  select n.id as id,
         row_number() over (partition by n.id order by coalesce(a.char_count, 0) desc) as 序号,
         coalesce(a.char_count, 0) as 字数,
         sum(coalesce(a.char_count, 0))
           over (partition by n.id order by coalesce(a.char_count, 0) desc) as 累计字数,
         case when a.name like '%说明%' then '说明'
              when a.name like '%对照%' then '对照'
              else '其他' end as 角色粗判,
         left(a.name, 34) as 附件名
  from notices n
  join notice_attachments a on a.notice_id = n.id
  where n.status = 'open' and a.status = 'ok' and coalesce(a.char_count, 0) > 0
) t
where t.累计字数 > 8000
order by t.id, t.序号;

\echo ''
\echo '== 5. 全库未截止条目：附件份数与最长附件分布（决定重管线要不要按条款分块） =='
select 可读附件数, count(*) as 条目数, max(最长附件) as 该组最长附件
from (
  select n.id, count(*) as 可读附件数, max(coalesce(a.char_count, 0)) as 最长附件
  from notices n
  join notice_attachments a on a.notice_id = n.id
  where n.status = 'open' and a.status = 'ok' and coalesce(a.char_count, 0) > 0
  group by n.id
) s
group by 1
order by 1;
