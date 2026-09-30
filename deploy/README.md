# 部署脚本

三种通道，**当前主用第一种**（2026-09-30 GitHub 账号恢复后第二种重新可用，但仍不主用）。

## 1. `sync-files-local.sh` —— 当前主用（增量）

本地文件 → gzip → base64 → `workbench exec` 写入服务器，逐文件校验 sha256。
不受仓库可达性影响，改几个文件就传几个文件。

```bash
export ZW_INSTANCE=<实例 id>      # 或把它写进 deploy/.instance-id（已 gitignore）
bash deploy/sync-files-local.sh src/app/page.tsx src/lib/dates.ts
# 然后在服务器上重建镜像并重启 web（脚本头部注释给了命令）
```

**实例 id 不写死在脚本里**（2026-09-30 改）：本仓库是公开仓库，实例 id 不该跟着源码一起公开。
`ZW_INSTANCE` 优先，其次读 `deploy/.instance-id`，两个都没有就当场报错（不静默用一个过期默认值 ——
那会连到一台不是你要的机器上）。

**它只在开发机跑**（服务器上没有 `workbench` 这个命令），所以下次做全树对拍时，这个文件会显示成
`diff`（生产上那份还是旧版），**那是预期的、不必同步** —— 真正被镜像读的代码在 `src/`、`worker/`、
`drizzle/`、`scripts/` 里。记在这里，免得下次把它当成"漏传了一个文件"。

**⚠️ 大文件要分块传**（2026-09-28 实测）：整份 base64 塞进一条 `workbench exec -c` 命令时，
Windows 的命令行长度上限会拦下来，报的是 **`程序"workbench.exe"无法运行: The filename or
extension is too long`** —— 这句错误消息与"文件内容太大"看不出任何关系，很容易读成路径写错。
实测第 21 个文件（`scripts/check-test-pins.mjs`，约 90 KB）就撞上了。做法：把 base64 切片、
逐片 `printf '%s' >> /tmp/x.b64` 追加，最后一次性 `base64 -d | gzip -d` 并核对 sha256
（本地辅助脚本在 `.git/zw-sync-big.ps1`，与 `sync-files-local.sh` 同一契约）。

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

## 2. `deploy-NN.sh` —— 历史脚本，整包覆盖通道

`deploy-23/24/25/29/30/31/32.sh` 是各 issue 上线时的一次性脚本，都从
`codeload.github.com` 取源码包整包覆盖。

**2026-09-21 → 2026-09-30 之间这条通道断过**：账号 `omeyb110674401-rgb` 被 GitHub 停用，
仓库页与 codeload 均 404，这批脚本照原样跑会失败。**现在账号已恢复**（`gh auth status` /
`git ls-remote` 实测可达），codeload 通道原则上又能用了。但**仍然不要照跑**：它们是各轮的
历史留档（里面写死的 URL、文件名、迁移序号都停在那一天），而增量通道更精准。
真要复用，先按当前 `HEAD` 重写一遍再跑，别拿旧脚本赌它对不对。

`deploy-33.sh` 已删除：它写于通道断掉之后，从未被使用过，且被同批次的
`sync-files-local.sh` 取代（详见 `docs/pending-issues/50-*.md`）。

## 其他文件

- `audit-review-selection.sql` —— **只读**：验收门那一步会读到哪几条（有摘要 + 未截止 + 受众面），
  顺带确认 `summary_diagnostics_json` 这一列存不存在（迁移 0019 之前会报 `column does not exist`）
- `sync-list-86.txt` —— **2026-09-27 那一批的同步清单**（46 个文件），不是估的：把本地 deploy 面的
  272 个文件算成 sha256 与 `/opt/zhurenweng` 逐文件对拍得出（same=226 / diff=26 / missing=20）。
  **清单要现算**（第十六节落地后就从 39 个变成 46 个）。下次要用同一手法时，
  `git ls-files` 出清单 → 本地算 sha → 在服务器上比一遍即可。
  **2026-09-28 已按这份清单部署完毕**（第十八节）：46/46 sha256 对拍通过、journal 19→20、
  `summary_diagnostics_json` 落库、4 条公众广域摘要按新管线重跑。
  同一天还有第二批（npc 草案附件开关，见 `docs/pending-issues/86-*.md` §18.4）：现算下来是
  **9 个文件**（7 改 2 新），**新文件不在 `git ls-files` 里，现算清单时要先 `git add`**
  —— 否则它们既不在清单里、也不会被同步，而表现是"代码改了、服务器上还是旧的"
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
