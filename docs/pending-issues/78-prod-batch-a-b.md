# 78 — A/B 生产批次（执行中，交接单）

> **这份文件是执行中的记录，不是完成后的复盘。** 用户在 2026-09-25 授权执行
> 「A 部署批次 + B 数据删除」全部动作。上下文压缩过一次，所以把**现场原样**写在这里，
> 好让下一次接着做 —— 包括我判断错的地方。

## 一、当前状态（压缩时的快照）

| 项 | 值 |
| --- | --- |
| 仓库 | `D:\Projects\zhurenweng`，**工作区干净** |
| HEAD | `0609ee4 docs(pins): 全套复跑实测 111/111；更正…` |
| 未推送 | **107** 个提交（GitHub 账号仍停用） |
| 生产 | **未被修改一个字节** —— 本轮只跑过只读探针 |

## 二、最重要的一条更正：**生产是可达的，我先前说"够不到"是错的**

上一轮我在给用户的清单里写「以上全部在生产服务器上，**我这边够不到**」——
那是**从文档推断的，没实测**。实测结果：**通路完全可用**。

- 命令：`workbench exec -i REDACTED_INSTANCE_ID --timeout <秒> -c "<命令>"`
- `workbench.exe` 就在 `C:\Users\35258\AppData\Local\Programs\workbench\workbench.exe`
- 远端根：`/opt/zhurenweng`（那次探测的实例主机名 `iZbp1adysj8za0fhyz6qmiZ`）
- 服务器时间：`Asia/Shanghai`（探测时 23:11 CST = 15:11 UTC）

这正好又撞上本仓库记过两次的同一族错误（#68「验错了对象」、#70「从'推不出去'推出
'CI 没跑'」）：**我是从"文档没写我怎么连"推出"我连不上"的**，而没去试。
规矩照旧：**能一条命令验死的事，不要先下结论。**

## 三、只读探针已经拿到的实况

```
caddy         Up 5 days
db            Up 5 days (healthy)
meilisearch   Up 5 days
web           Up 5 hours      ← 比 worker 早的部署留下的
worker        Up 5 hours
```

## 四、必须先裁决的一处文档自相矛盾（**未决**）

- 提交 `c68f65b` 的标题写着：**「#71 与 #75 已部署并在生产实测（成功路径 0 封 /
  测试告警真发信 / RSS 探针 192=192）」**
- 而 `FOLLOWUPS.md` 里 #71 写「**生效要一次授权**（同步 + `docker compose build worker`）」、
  #75 写「**仍欠的是部署**：镜像里还没这条探针」

两者不可能同时为真。**按本仓库自己的规矩（"未验证即不得宣称上线"），以生产实况为准，
不以文档为准。** 已写好一条只读探针脚本（见第六节）来判定：查
`scripts/alert-backup-failure.mjs` / `scripts/audit-pipeline-health.mjs` /
`scripts/audit-rss-feed.mjs` 在不在服务器上、`pipeline-health.ts` 里有没有
`auditRssFeed`、`docker-compose.yml` 的 worker 有没有 `SITE_URL` 注入、
`summary-content.ts` 有没有 `explanationPoints`（#76 第 3 刀的形状）。

**这一步没跑** —— 第一版探针用 PowerShell heredoc 写，被 Windows 命令行拆坏了
（报 `explanation: command not found`），改成 base64 通道后正要跑就被叫停做压缩。

## 五、通道方法（重开会话直接照用）

`workbench exec -c` 走 Windows 命令行，**多行脚本与其中的 `$(...)`/引号会被拆坏**。
所以远端脚本一律走 base64 单行承载（`sync-files-local.sh` 传文件也是这套路数）：

```powershell
$text = (Get-Content -Raw -Encoding UTF8 $Script) -replace "`r`n", "`n"
$b64  = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
workbench exec -i REDACTED_INSTANCE_ID --timeout 300 -c "echo $b64 | base64 -d > /tmp/zw-step.sh && sh /tmp/zw-step.sh"
```

现成的 helper 在 `%TEMP%\zw-remote.ps1`（`param($Script, $Timeout)`）+ 探针脚本在
`%TEMP%\zw-scripts\probe-state.sh`。**TEMP 可能被清掉**，上面这段就是它的全部内容，
丢了照这条重建即可。

另外两条已知坑（`deploy/README.md` 与 `sync-files-local.sh` 头注）：
- `workbench exec` **会吞掉开头若干行输出**，所以远端脚本第一句永远先 `echo "---BEGIN---"`。
- 单条 `-c` 命令受 Windows 约 32KB 上限；超了的表现是 **exit 126 且无任何输出**。

## 六、待执行的清单（用户已授权「A、B 全部」）

### A 部署批次（**有顺序，不能跳步**）
1. 同步差异文件 → `docker compose build worker`（必要时 web）→ `docker compose up -d`
   - 前提（`deploy/README.md` 明写）：`sync-files-local.sh` **只写宿主机**，
     而 `docker compose run/up` 用的是**镜像里那份**代码 —— 传上去 ≠ 容器里跑的是它，
     失败表现是**行为静默不对而不是报错**。
   - 同步命令：`bash deploy/sync-files-local.sh <相对路径> …`（逐文件 sha256 校验）
2. **部署后当场自证**（#68 的规矩：装上调度 ≠ 在跑）：
   - `docker compose run --rm worker node scripts/audit-pipeline-health.mjs`
     （备份目录不挂进来会报 unknown，不判健康 —— 这是**正确**行为，别当故障）
   - RSS 探针：`node scripts/audit-rss-feed.mjs`（线上产物已实测过 192=192，这次验的是**部署**）
   - 确认 compose 新加的 worker `SITE_URL` 真的注入了
3. **#76**：清 1 条修正案的摘要 → 跑一轮 worker（**花一次境外通道调用**）→
   抓线上详情页确认「改动点表 + 覆盖度那行」；第 3 刀的「编制说明要点」栏要出现也靠同一次重跑
4. **订阅闭环取证（#73 的最小动作）**：清 `unsubscribed_at` + 跑一轮 worker，
   期望 `reminder_sends` 由 **0 变约 5 行**。判据：`deploy/audit-email-paths.sql`（只读）

### B 数据删除（用户已明确同意）
- **B1** 46 行疑似机器点击：`/root/cleanup-machine-clicks.sql`（脚本已就位）
- **B2** `govcn` 死行：`deploy/cleanup-govcn-source.sql`（`WHERE` 里带「名下 0 条目」保险，
  情况有变就一行都不删）

### 红线（执行时必须守）
- **密钥不进对话、不进仓库**：`.env` 只 grep 键名，**绝不打印值**；
  改 `.env` 一律走 `deploy/set-env-keys.sh`。
- **生产写入前先留退路**：B1/B2 与 A3/A4 都是生产写；执行前先确认当日备份存在
  （cron 首次自然运行在 19:30 UTC，即次日 03:30 CST —— 探针时刻还没到）。
- **口径纪律**：每步都要有产物证据才说"完成"，别把"装上了"当成"在跑"。

## 七、顺带查出、但还没修的一处文档缺陷

`FOLLOWUPS.md` 的 #74 与 #75 两行都写「**与 task #44 一起做最省事**」，
但**全仓库没有任何地方解释 `task #44` 指什么**，且它与 **issue #44**
（sitemap `lastmod` / `error.tsx`）显然不是一回事。它是个**批次锚点**，
直接影响上面 A 怎么分批 —— 但推不出所指，**留着问用户，不猜**。
