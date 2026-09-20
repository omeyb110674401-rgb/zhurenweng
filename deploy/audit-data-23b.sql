-- 生产数据质量审计（第二轮）：正文覆盖 / 无标签成因 / 停更源 / 缺失字段
\pset border 2
\echo '=== A. 正文覆盖（body_text 缺失或过短会影响「读懂」与检索） ==='
select source_id,
       count(*) filter (where body_text is null or length(btrim(body_text)) = 0) as 无正文,
       count(*) filter (where length(btrim(coalesce(body_text, ''))) < 80)          as 正文过短,
       count(*)                                                                     as 总数
from notices
group by source_id
order by 无正文 desc, 总数 desc;

\echo '=== B. ndrc 无领域标签的条目：正文长度与状态 ==='
select left(title, 34) as 标题, length(coalesce(body_text, '')) as 正文长度,
       deadline_at::date as 截止, status
from notices
where source_id = 'ndrc'
  and (category_tags_json is null or category_tags_json in ('', '[]'))
order by 正文长度
limit 12;

\echo '=== C. 各来源日期区间（识别停更源） ==='
select source_id,
       min(published_at)::date as 最早发布,
       max(published_at)::date as 最新发布,
       count(*)                as 条数
from notices
group by source_id
order by 最新发布;

\echo '=== D. 缺截止日期的条目（按来源） ==='
select source_id, count(*) as 缺截止
from notices
where deadline_at is null
group by source_id
order by 缺截止 desc;

\echo '=== E. 抓取时间戳（最近一轮是否覆盖全部来源） ==='
select source_id, max(fetched_at) as 最近抓取
from notices
group by source_id
order by 最近抓取;
