-- 只读：验收门那一批（有摘要 + 未截止 + 公众广域）**逐条的输入状况** —— 这一批里有几条
-- 其实喂不进任何条文？那决定了"人工过一遍"到底能读到什么。
\pset pager off
\echo '== 逐条：附件抽取状况 =='
select n.id,
       n.deadline_at as 截止,
       coalesce(n.genre, '-') as 体裁,
       count(a.*) as 附件行,
       count(*) filter (where a.status = 'ok') as 可读,
       coalesce(max(a.char_count) filter (where a.status = 'ok'), 0) as 最长可读_汉字,
       left(n.title, 30) as 标题
from notices n
left join notice_attachments a on a.notice_id = n.id
where n.ai_summary_json is not null
  and n.audience = 'public'
  and n.deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')
group by n.id, n.deadline_at, n.genre, n.title
order by n.deadline_at, n.id;

\echo ''
\echo '== 回填受众面之后（模拟：按新规则把方法标准算成 sector）这批会剩几条 =='
select count(*) as 回填后仍是公众广域的
from notices
where ai_summary_json is not null
  and audience = 'public'
  and deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')
  and id not in ('41f2e22edef76d7e');
