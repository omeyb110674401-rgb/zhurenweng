-- 只读：三条自动发信路径**到底有没有真的发出过东西**（issue #68 教训的延伸）
--
-- 为什么要专门查这个：#68 抓到"每日备份 cron 从未触发"—— 配置在、代码在、单测绿、
-- `crontab -l` 看得到那一行，唯独没有任何一次真实产出。同一族问题在发信路径上更值得查，
-- 因为它们**只在出事那天才有用**：告警没发出去，你不会收到"没发出去"的通知。
--
-- 关键是把两件事分开：
--   A. 路径本身坏了（该发没发）—— 必须修；
--   B. 前提不成立（没有可发的订阅者 / 没有正在失败的源）—— 是状态使然，但也要写下来，
--      否则下一次看到 0 行又会当成 bug 去查。
-- 所以每一段都同时给出"发了多少"和"今天有没有可发的东西"。
--
-- 跑法：cat deploy/audit-email-paths.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng

\echo '=== 1) 三条路径的历史产出（行数为 0 时先看第 2 / 3 段的前提）'
select 'alert_sends（任务失败告警）' as 路径,
       count(*)                      as 发出过,
       max(sent_at)                  as 最近一次
  from alert_sends
union all
select 'reminder_sends（截止提醒）', count(*), max(sent_at) from reminder_sends
union all
select 'notice_notifications（新公示通知）', count(*), max(sent_at) from notice_notifications;

\echo '=== 2) 前提：有没有"可发的订阅者"（已确认 且 未退订 —— 两者缺一就不该发）'
select count(*)                                              as 订阅记录,
       count(*) filter (where confirmed = 1)                  as 已确认,
       count(*) filter (where confirmed = 1 and unsubscribed_at is null) as 可发,
       count(*) filter (where unsubscribed_at is not null)     as 已退订
  from subscriptions;

\echo '=== 3) 前提：今天到底有没有该发的内容'
-- 提醒：未截止 且 截止日期落在 7 天 / 3 天窗口内的条目（口径与 send-deadline-reminders 同源：
-- 只按库列 status 与 deadline_at 的日期部分算）。
-- 通知：本轮之前从没被通知过、且 `first_seen_at` 非空的新条目（存量刻意不回填 ⇒ 0 是正常的）。
select (select count(*) from notices
         where status = 'open'
           and deadline_at is not null
           and substr(deadline_at, 1, 10) >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')
           and substr(deadline_at, 1, 10) <= to_char(
                 (now() at time zone 'Asia/Shanghai') + interval '7 day', 'YYYY-MM-DD'))
                                                                 as 提醒窗口内的条目,
       (select count(*) from notices
         where first_seen_at is not null and status = 'open')     as 可被通知的条目,
       (select count(*) from sources where enabled = 1)           as 启用的源,
       (select count(*) from sources where consecutive_failures > 0) as 正在失败的源,
       (select count(*) from sources where last_error_message is not null) as 有错误记录的源;

\echo '=== 4) 该发告警却没发的证据：连续失败 ≥2 轮的源，最近一次告警是什么时候'
select s.id,
       s.name,
       s.consecutive_failures                               as 连续失败轮数,
       left(coalesce(s.last_error_message, '（无）'), 60)     as 最近错误,
       s.last_error_at,
       (select max(a.sent_at) from alert_sends a
         where a.source_id = s.id and a.job_name = 'crawl-notices') as 该源最近一次告警
  from sources s
 where s.consecutive_failures >= 2
 order by s.consecutive_failures desc;

\echo '=== 5) 唯一那个订阅者的真实状态（产品需求侧的事实，不是缺陷）'
select email,
       confirmed,
       (unsubscribed_at is not null)  as 已退订,
       substr(coalesce(confirmed_at, '-'), 1, 10)    as 确认于,
       substr(coalesce(unsubscribed_at, '-'), 1, 10) as 退订于,
       keywords_json,
       categories_json
  from subscriptions
 order by created_at;
