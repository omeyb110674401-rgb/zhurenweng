-- 只读：间歇性慢源的信号、死源与摘要文案口径核对（issue #58）
--
-- 用法（服务器上仓库目录里执行；`-T` 关掉 TTY，stdin 才能进容器里的 psql）：
--   docker compose exec -T db psql -U zhurenweng zhurenweng < deploy/audit-sources-flaky.sql
--
-- 分三段，**跑的时间点不同**（每段开头都标了）：迁移跑完再回来查前两段的列可能已不存在。
\pset border 2

\echo '=== 【迁移前】1) schedule_config_json 是否真的没人用过（0011 DROP COLUMN 的前置）==='
-- 必须返回 0 行。任何一行非 '{}' 都说明有人用一次性 SQL 配过调度 —— 那先要弄清是谁在用，
-- 不能直接删列。查完这段再往下走。
select id, schedule_config_json
from sources
where schedule_config_json is distinct from '{}';

\echo '=== 【迁移前】2) govcn 是否还是死行（cleanup-govcn-source.sql 的前置）==='
-- 期望：条目数 0。若 >0，说明有人补录过挂在它名下的条目，删除脚本会因 WHERE 里的
-- NOT EXISTS 保险而一行都不删（那是有意的：宁可停下也不盲删）。
select s.id,
       s.name,
       s.healthy,
       s.enabled,
       s.last_error_at,
       s.last_error_message,
       (select count(*) from notices n where n.source_id = s.id)          as 条目数,
       (select count(*) from notices n where n.source_id = s.id
          and n.status <> 'closed')                                        as 未截止条目数
from sources s
where s.id = 'govcn';

\echo '=== 【迁移后】3) 各源健康信号：连续失败轮数与当前故障态 ==='
-- 迁移 0010 会给当下 red 的源播种 consecutive_failures=2（不播种会让真挂着的源
-- 在下一轮被算成「第 1 次」而静默转绿）。所以这段刚跑完应看到：healthy=0 ⇔ 计数 ≥ 2。
select s.id,
       s.healthy,
       s.enabled,
       s.consecutive_failures,
       s.last_success_at,
       s.last_error_at,
       left(s.last_error_message, 60)                                      as 当前错误,
       (select count(*) from notices n where n.source_id = s.id)            as 条目数
from sources s
order by s.healthy asc, s.consecutive_failures desc, s.id;

\echo '=== 【迁移后】4) 有没有「红着但计数为 0」或「绿着但计数≥2」的自相矛盾行 ==='
-- 期望 0 行。有行说明播种或某条写入路径没走新入口（recordSourceSuccess/Failure）。
select id, healthy, consecutive_failures
from sources
where (healthy = 0 and consecutive_failures < 2)
   or (healthy = 1 and consecutive_failures >= 2);

\echo '=== 5) 摘要文案口径：已截止且 pending 的条目数（本次改文案的对象）==='
-- 这些条目按 #4 的入队条件永远不会被生成，详情页从 #58 起显示「未生成摘要」。
-- 数字本身不是问题，「它们曾被承诺生成中」才是。
select n.status,
       n.summary_status,
       count(*)                                                            as 条数,
       count(*) filter (where n.ai_summary_json is not null)                as 已有摘要
from notices n
group by 1, 2
order by 条数 desc;

\echo '=== 6) 会被「未生成摘要」误伤的行（必须为 0）==='
-- 已截止**且已有 done 摘要**的条目仍应渲染摘要本体（summaryDisplayState 的第一优先级
-- 就是 hasSummary）。这一段列出它们，便于上线后逐条点开详情页核对。
select n.id, n.source_id, n.summary_status, left(n.title, 40)              as title
from notices n
where n.status = 'closed'
  and n.ai_summary_json is not null
order by n.source_id, n.id;
