-- 生产数据质量审计（第三轮）：定位 mot 正文缺失与 moj 数据陈旧
\pset border 2
\echo '=== A. mot 空正文条目（含详情地址） ==='
select left(title, 38) as 标题, url, published_at::date as 发布,
       coalesce(deadline_at, '（无）') as 截止, length(coalesce(body_text, '')) as 正文长度
from notices
where source_id = 'mot' and length(btrim(coalesce(body_text, ''))) < 80
order by published_at desc;

\echo '=== B. mot 全部条目：正文长度 vs 截止日期（看是否同源失败） ==='
select left(title, 30) as 标题,
       length(coalesce(body_text, '')) as 正文,
       coalesce(deadline_at::date::text, '（无）') as 截止
from notices
where source_id = 'mot'
order by 正文, 标题;

\echo '=== C. 各来源正文长度分布（ndrc 是否普遍偏短） ==='
select source_id,
       min(length(coalesce(body_text, '')))                as 最短,
       round(avg(length(coalesce(body_text, ''))))         as 平均,
       max(length(coalesce(body_text, '')))                as 最长,
       count(*)                                            as 条数
from notices
group by source_id
order by 平均;

\echo '=== D. moj 全部条目（最新发布 2026-03-20，需核对源站是否已更新） ==='
select left(title, 40) as 标题, published_at::date as 发布,
       coalesce(deadline_at::date::text, '（无）') as 截止, status
from notices
where source_id = 'moj'
order by published_at desc
limit 12;

\echo '=== E. 附件数分布（正文缺失是否因为内容在附件里） ==='
select source_id,
       count(*) filter (where attachments_json not in ('[]', '')) as 带附件,
       count(*)                                                   as 总数
from notices
group by source_id
order by 带附件 desc;
