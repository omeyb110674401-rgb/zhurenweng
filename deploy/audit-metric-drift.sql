-- 只读：出站点击的两套口径有没有已经漂移（issue #72）
--
-- 背景（FOLLOWUPS 的 #52 那行）：`recordOutboundClick` 写两处 —— `notices.outbound_clicks`
-- 与 `outbound_click_daily`。第一条成功、第二条失败就会漂移，而两处分别被**详情页**
-- （「出站提意点击：N 次」）和**统计页**（Top 点击榜、按日趋势）用着：数字对不上时，
-- 撒谎的是我们自己的页面。当时判断"包事务做不到"（drizzle 的 better-sqlite3 事务不接受
-- async 回调）而保留，但保留的前提是"漂移没在发生" —— 这个前提得量，不能信推断。
--
-- 跑法：cat deploy/audit-metric-drift.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng

\echo '=== 1) 两个总数：条目计数之和 vs 日聚合之和（不等就是漂移）'
select (select coalesce(sum(outbound_clicks), 0) from notices)          as 条目列相加,
       (select coalesce(sum(clicks), 0) from outbound_click_daily)      as 日表相加,
       (select coalesce(sum(outbound_clicks), 0) from notices)
         - (select coalesce(sum(clicks), 0) from outbound_click_daily)  as 差额,
       (select count(*) from outbound_click_daily)                      as 日表行数;

\echo '=== 2) 逐条比对：哪几条公示的两个数不一致（最多列 10 条）'
select n.id,
       left(n.title, 26)                          as 标题,
       n.outbound_clicks                          as 条目列,
       coalesce(d.daytotal, 0)                    as 日表合计
  from notices n
  left join (
    select notice_id, sum(clicks) as daytotal from outbound_click_daily group by notice_id
  ) d on d.notice_id = n.id
 where n.outbound_clicks <> coalesce(d.daytotal, 0)
 order by abs(n.outbound_clicks - coalesce(d.daytotal, 0)) desc
 limit 10;

\echo '=== 3) 形状异常：未来的日期、负数、孤儿行（notice 已不存在）'
select count(*) filter (where click_date > substring((now() at time zone 'Asia/Shanghai')::date::text, 1, 10))
                                                                    as 未来日期行,
       count(*) filter (where clicks < 0)                            as 负数行,
       count(*) filter (where not exists (select 1 from notices n where n.id = click_date.notice_id))
                                                                    as 孤儿行
  from outbound_click_daily click_date;
