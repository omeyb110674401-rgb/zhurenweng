-- 一次性写入（生产）：清掉出站点击的历史污染，北极星指标从干净基线重新起算。
--
-- 背景：2026-09-20 有一次全站遍历（爬虫跟随每个详情页的 /go 出站口）+ 那次部署的
-- 验证点击，记下 **59 行 / 74 次**；此后 09-21~09-25 又累积 37 行 / 39 次，来源无法
-- 从数据里区分（表只记「条目 × 日期」，刻意不记 IP/Cookie/账号，见 schema 注释）。
--
-- 为什么不能直接用 /root/cleanup-machine-clicks.sql：那个脚本写于 09-20，当时
-- `notices.outbound_clicks` 里只有当天数据，所以它的 `UPDATE notices SET
-- outbound_clicks = 0 WHERE outbound_clicks > 0` 与「只清 09-20」等价。放到今天
-- 就不等价了 —— 它会把 09-21 起累积的计数一起清零，而 `DELETE` 仍然只删 09-20，
-- **两处口径不一致**：表里留着 39 次，条目计数却是 0。本文件把两处口径对齐。
--
-- 站长的决定（2026-09-25）：不在乎点击量，历史一并清零，让这条指标从 0 重新起算，
-- 以后每一次增长都能明确归因。因此这里删的是**全部** 96 行 / 113 次，不只是 09-20。
--
-- 可逆：清零前两张表都原样存进 backup 表，回滚语句见文件末尾。
-- 执行（服务器上仓库目录）：
--   docker compose exec -T db psql -U zhurenweng -d zhurenweng -v ON_ERROR_STOP=1 \
--     < deploy/cleanup-click-pollution.sql
-- 先备份：bash deploy/daily-backup.sh

\set ON_ERROR_STOP on
\pset border 2

\echo '=== 1) 清零前：按日分布 ==='
select click_date as 日期, count(*) as 行数, sum(clicks) as 点击数
from outbound_click_daily group by click_date order by click_date;

\echo '=== 2) 清零前：条目计数分布 ==='
select count(*) filter (where outbound_clicks > 0) as 计数大于0的条目,
       coalesce(sum(outbound_clicks), 0)           as 全站累计,
       max(outbound_clicks)                        as 单条最大
from notices;

begin;

-- 刻意不用 `create table if not exists`：这两个表若已存在，说明本次清理跑过或有别的
-- 东西占了名字，那时**宁可整笔事务报错退出**（ON_ERROR_STOP）也不要覆盖掉上一份备份。
\echo '=== 3) 建备份表（已存在则会报错并整笔回滚，这是有意的）==='
create table outbound_click_daily_backup_20260925 as
  select * from outbound_click_daily;

create table notices_clicks_backup_20260925 as
  select id as notice_id, outbound_clicks
  from notices
  where outbound_clicks > 0;

\echo '=== 4) 清零（两张表口径一致）==='
delete from outbound_click_daily;
update notices set outbound_clicks = 0 where outbound_clicks > 0;

commit;

\echo '=== 5) 清零后回查：按日分布应为 0 行，条目累计应为 0 ==='
select count(*) as 日聚合剩余行数, coalesce(sum(clicks), 0) as 日聚合剩余点击
from outbound_click_daily;

select coalesce(sum(outbound_clicks), 0) as 条目累计剩余
from notices;

\echo '=== 6) 备份表内容（回滚靠它）==='
select (select count(*) from outbound_click_daily_backup_20260925) as 日聚合备份行数,
       (select coalesce(sum(clicks), 0) from outbound_click_daily_backup_20260925) as 日聚合备份点击,
       (select count(*) from notices_clicks_backup_20260925) as 条目计数备份行数,
       (select coalesce(sum(outbound_clicks), 0) from notices_clicks_backup_20260925) as 条目计数备份合计;

-- ── 回滚 ────────────────────────────────────────────────────────────────
-- begin;
--   insert into outbound_click_daily (notice_id, click_date, clicks)
--     select notice_id, click_date, clicks from outbound_click_daily_backup_20260925
--     on conflict (notice_id, click_date) do nothing;
--   update notices n set outbound_clicks = b.outbound_clicks
--     from notices_clicks_backup_20260925 b where b.notice_id = n.id;
-- commit;
--
-- 回滚完把两张 backup 表留着别删：它们同时是「这次清零到底删了多少」的唯一原始凭证。
