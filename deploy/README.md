# 部署脚本

两种通道，**当前只有第二种可用**。

## 1. `sync-files-local.sh` —— 当前主用（增量）

本地文件 → gzip → base64 → `workbench exec` 写入服务器，逐文件校验 sha256。
不受仓库可达性影响，改几个文件就传几个文件。

```bash
bash deploy/sync-files-local.sh src/app/page.tsx src/lib/dates.ts
# 然后在服务器上重建镜像并重启 web（脚本头部注释给了命令）
```

### 传上去 ≠ 容器里跑的是它

`sync-files-local.sh` 只写宿主机的 `/opt/zhurenweng`，而 `docker compose run/exec/up`
用的都是**镜像里那份代码**。所以同步完直接跑一次性脚本，跑的是上一次的旧版本 ——
失败表现不是报错，是**行为静默不对**。2026-09-24 实测踩过：`scripts/reset-summaries-for-redraft.mjs`
加上幂等过滤后同步上去，dry-run 仍然把 3 条已经补好的条目列为候选（旧版没有那个过滤），
因为 worker 镜像还是构建于加过滤之前。

**但只读探针不必为此重建镜像** —— 把宿主机的单个文件挂进临时容器即可（镜像 `WORKDIR=/app`，
脚本 import 的 `src/**` 本来就在镜像里；`:ro` 保证探针改不到代码，跑完容器就消失）：

```bash
docker compose run --rm   -v /opt/zhurenweng/scripts/audit-search-index.mjs:/app/scripts/audit-search-index.mjs:ro   worker node scripts/audit-search-index.mjs --stride 6
```

**这条捷径只对"判据没变、只是脚本自己改了"的探针成立**。像 `scripts/audit-rss-feed.mjs`
（issue #75）这种把判定放在 `src/lib/pipeline-health.ts` 里的，镜像里那份判据是旧的 ——
新函数 import 不到会直接报错（这一类是硬失败，不是静默不对，所以还算好查）。要么先 `build`，
要么把 `src/lib/pipeline-health.ts` 一起 `-v ...:ro` 挂进去。

真正要被常驻进程长期执行的改动，仍然要走 `build` + `up -d`（下面三条）。

改完脚本要在容器里跑，先重建再跑：

```bash
cd /opt/zhurenweng
docker compose build worker          # 只跑 worker 侧的脚本就只重建 worker
docker compose run --rm worker node scripts/<脚本>.mjs
docker compose up -d worker          # 让常驻容器也换到新镜像，否则下次拉起的还是旧的
```

## 2. `deploy-NN.sh` —— 历史脚本，已不可用

`deploy-23/24/25/29/30/31/32.sh` 是各 issue 上线时的一次性脚本，都从
`codeload.github.com` 取源码包整包覆盖。

**2026-09-21 起 GitHub 账号 `omeyb110674401-rgb` 被停用**（仓库页与 codeload
均 404），这条通道断了，这批脚本原样跑会失败。保留它们只是为了留档「当时怎么
部署的」，不要照着执行 —— 恢复推送通道（或换托管）后再评估是否复用。

`deploy-33.sh` 已删除：它写于通道断掉之后，从未被使用过，且被同批次的
`sync-files-local.sh` 取代（详见 `docs/pending-issues/50-*.md`）。

## 其他文件

- `run-probe-public-impacts.sh` —— **只读实验的启动器**（issue #86 第十三节）：把**未部署**的源码
  （`src/lib/attachment-feed.ts`、适配器、worker 等）从 `/tmp/zw-probe` **只读挂进**一次性 worker
  容器，跑 `scripts/probe-public-impacts.mjs` —— 它用生产那份适配器与反查实现，在真实的
  公众广域条目上打印"如果现在部署，读者会看到什么"，**一条都不写库**。
  用法：先把文件推到 `/tmp/zw-probe`（`sha256` 逐个核对），再 `sh /tmp/zw-probe/deploy/run-probe-public-impacts.sh [--id <前缀> | --limit N]`，
  输出在 `/tmp/zw-probe/out.txt`（后台跑，`tail` 它）。
  **不要把它挂进 `/opt/zhurenweng`** —— 那个目录是下一次 `build` 会捡起来的位置，
  往那儿放没复核过的代码等于悄悄部署
- `Caddyfile` —— 反向代理与证书（见 `docs/deploy.md` 第 5 节）
- `daily-backup.sh` —— **每日备份 + 恢复校验**（服务器上由 root crontab 触发）：导出 `-Fc`
  归档后把它**真的恢复进临时库**并比对 6 项计数，对不上非零退出；保留 7 份。
  失败会发信（issue #71，`scripts/alert-backup-failure.mjs` 复用 worker 的告警出口，当日去重）；
  安装命令与"为什么 crontab 必须带 `CRON_TZ=UTC`"写在 `deploy/daily-backup.sh` 头注与
  `docs/deploy.md` 第 8 节（宿主机是 Asia/Shanghai，缺了它 `30 19` 就是 19:30 北京时间）。
  用法与恢复校验的判据见 `docs/deploy.md` 第 8 节
- `audit-sources-flaky.sql` —— **只读**：间歇性慢源的信号、死源与摘要文案口径核对
  （issue #58）。每段开头标了该在迁移前还是迁移后跑：DROP COLUMN 之前要确认
  `schedule_config_json` 无人用过，删除死行之前要确认它名下 0 条目
- `cleanup-govcn-source.sql` —— **一次性写入**：删掉注册表已删适配器留下的 `govcn` 死行
  （issue #58）。删除条件把「名下 0 条目」写进 `WHERE` 当保险，情况有变就一行都不删
- `audit-redraft-state.sql` —— **只读**：存量摘要置换（issue #67）的现场口径：有多少条摘要、
  其中几条的要点真带得出附件出处（= 详情页能看到「出处：附件《…」」的条数）、队列还剩几条。
  跑法：`cat deploy/audit-redraft-state.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng`
- `preflight-23.sh` / `verify-23-plumbing.sh` / `audit-data-23*.sql` —— 首次上线
  前的预检、链路核验与数据审计，同样是一次性脚本（同属历史留档）
