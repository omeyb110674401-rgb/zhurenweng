-- 只读：校验 show-notice-summary.mjs 的选取判据（"有摘要 + 未截止 + 受众面"）在生产上选出几条。
-- 「未截止」用展示口径（截止日 >= 北京时间今天），与页面徽标 / ?open=1 / RSS 同一份口径。
\pset pager off
\echo '== 默认视图（公众广域 + 未截止 + 有摘要） =='
select id, deadline_at, left(title, 42) as 标题
from notices
where ai_summary_json is not null
  and audience = 'public'
  and deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')
order by deadline_at, id;
\echo ''
\echo '== --all-open（不限受众面） =='
select audience, count(*) as 条目数
from notices
where ai_summary_json is not null
  and deadline_at >= to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD')
group by 1 order by 2 desc;
\echo ''
\echo '== 顺带核对：这一列在迁移 0019 之前存在吗（应该报错/为空） =='
select count(*) as 有诊断的行数 from notices where summary_diagnostics_json is not null;
