-- 一次性写入（生产）：删掉 `govcn` 这条死源行（issue #58）
--
-- 背景：`govcn`（中国政府网「意见征集」栏目）的适配器早已从注册表删除，但 `sources` 表里
-- 那行还在，且 `enabled=1`、`healthy=0`、错误停在 2026-09-20 的 HTTP 404 —— 后台永远显示
-- 一个红着的空源，而抓取任务再也不会碰它（注册表里没有它）。该栏目已下线，由 `mee` 替代。
--
-- 保险写在 WHERE 里：**只有「一条挂着的条目都没有」才删**。有条目的话本脚本一行都不删，
-- 让回查段落告诉我们情况变了，而不是把 notices.source_id 的外键引用打断或留下孤儿行。
--
-- 执行（服务器上仓库目录）：
--   docker compose exec -T db psql -U zhurenweng zhurenweng < deploy/cleanup-govcn-source.sql
-- 执行前先备份：docker compose exec db pg_dump -U zhurenweng zhurenweng > /root/zw-backup-$(date +%F).sql
-- （确认备份非空再往下走。）

\pset border 2

\echo '=== 删除前：这一行现在长什么样（条目数必须是 0，否则本脚本删不掉它）==='
select s.id, s.name, s.adapter_type, s.healthy, s.enabled, s.last_error_at,
       (select count(*) from notices n where n.source_id = s.id) as 条目数
from sources s
where s.id = 'govcn';

begin;

delete from sources
 where id = 'govcn'
   and not exists (select 1 from notices n where n.source_id = 'govcn');

\echo '=== 本次删除影响行数（1 = 删掉了；0 = 有条目挂着或本来就没有这行，属情况有变）==='
-- psql 自身会在下一段查询前显示 DELETE 0/1；这里再显式回查一次。

commit;

\echo '=== 删除后回查：应为 0 行 ==='
select id, name, healthy, enabled from sources where id = 'govcn';

\echo '=== 顺带核对：把这份清单与 src/sources/registry.ts 的适配器 id 对一遍 ==='
-- 表里有、注册表里没有的 id 就是同类死行（本次只删 govcn，因为实测只有它一条；
-- 若这里又冒出新的，先确认它真的不再被抓取，再照同一写法处理）。
select s.id,
       s.enabled,
       s.last_error_at,
       (select count(*) from notices n where n.source_id = s.id) as 条目数
from sources s
order by s.id;
