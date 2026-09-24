# issue #66：迁移被静默跳过 —— 部署 #58/#60/#62–#65 时线上少了三张表与五列

对应提交：（部署轮）

## 一、发生了什么

2026-09-24 执行生产部署（授权范围：代码同步 + 迁移 + 备份脚本 + cron）。顺序按
`59-iteration-baseline.md` 第四节：传 `daily-backup.sh` → 先跑一次备份并通过 6 项恢复校验
→ 传 64 个运行时文件 → `docker compose build` → `up -d`（web/worker 的启动命令里带
`node scripts/db-migrate.mjs`）。

**容器起来了、`db-migrate` 打印「迁移已应用」、退出码 0 —— 但迁移只落到 0011。**
回查库结构才发现：

- `notices.first_seen_at` 不存在（0013）
- `subscriptions.scope / agencies_json / pending_rules_json` 不存在（0012 / 0014）
- `notice_notifications` 表不存在（0013）

而跑着的代码正在读这些列。生产有约 15 分钟处于「新代码 + 缺列的库」状态。

## 二、根因（是我这轮埋的，不是 drizzle 的锅）

`drizzle/<driver>/meta/_journal.json` 里 0012–0014 的 `when` 是我手写的
`17900000000xx`，**比 0011 的 `1791072003000` 更早**。drizzle 的迁移器对存量库的规则是：

```js
if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) // 才执行
```

于是这三条被**静默跳过**：SQL 文件在、journal 里在、日志说成功、退出码 0。

**为什么本地 331 条 e2e + 370 条单测全绿也照不出来**：本地每个测试都用全新的 SQLite 文件，
`__drizzle_migrations` 是空的 ⇒ `!lastDbMigration` 对每一条都成立 ⇒ 一次全跑。
「晚到的迁移接不上」这条路径只在**存量库向后迁移**时发作，而那条路径只有生产走。
这是「测试跑过的路径 ≠ 线上走的路径」的一个具体实例，和 #54 那批教训同源。

修完 0012–0014 之后，新加的结构守卫又抓到一处**既存**的同类乱序：0007
（`alert_sends` 表，2026-09 初上线）的 `when` 比 0006 早。它在生产上没造成损失
（当时是从更前面一次全跑过去的），但同样是个哑雷。

## 三、修了什么

1. `drizzle/{sqlite,postgres}/meta/_journal.json`：0012/0013/0014 的 `when` 改成
   严格递增（`1791072004000/5000/6000`），0007 挪到 0006 与 0008 之间（`1789300000002`）。
   改**已应用**迁移的 `when` 是无害的：迁移器只拿「最后一条已应用的 `created_at`」做门限，
   不回头比对哈希，也不会重跑。
2. `tests/e2e/migrations-integrity.test.mjs` 加两道守卫（都要能红才算数）：
   - **结构**：两方言 journal 的 `when` 必须严格递增，报错信息直接写明「drizzle 会静默跳过」；
   - **行为**：两阶段迁移 —— 先把库建到「停在 0011」的样子（复制一份 journal 截断到 idx≤11），
     再对**同一个库文件**跑完整目录，断言 `first_seen_at` / `scope` / `agencies_json` /
     `pending_rules_json` / `notice_notifications` 都补得上。
     这条才是复现生产路径的那道 —— 全新库那次全跑永远测不到它。
3. `scripts/check-test-pins.mjs`：83 → 85 条，两条新 pin 分别指向结构守卫与行为守卫。
   已实测：把 `when` 改回非单调，三个用例全红。
   （第一版 pin 片段我按 8 空格缩进写，JSON 实际是 6 空格 —— 替换不命中时
   `String.replace` 是**静默无操作**，pin 会假绿。是手动验证才发现的，
   与 #63/#65 那两条假绿同属「撤了但没撤到」这一类。）

## 四、部署结果（当场实测，不是推断）

- 迁移：`drizzle.__drizzle_migrations` 15 条，`max(created_at)=1791072006000`；
  `notices.first_seen_at`（可空）、`subscriptions` 三列、`notice_notifications`（0 行）全部到位。
- 备份：`zhurenweng-2026-09-24-120010.dump`（1,200,897 字节）**真的恢复进临时库**并比对
  6 项计数通过：187 条公示 / 79 条摘要 / 98 行附件 / 1,479,501 字 / 1 个订阅 / 11 个源。
- cron：`30 19 * * * …daily-backup.sh`，服务名在这台 Alibaba Cloud Linux 3 上是 **`crond`**
  （active + enabled，进程自 09-14 起在跑）。第一次查 `systemctl is-active cron` 显示
  inactive 是我查错了 unit，不是 cron 没装。
- 0011 要 DROP 的 `sources.schedule_config_json`：11 行**全部非空但全是 `{}`**，
  导出件仍留在 `/var/backups/zhurenweng/pre-0011-schedule_config_json.txt`。
- 线上功能回查：首页 192 条；`/?sort=newest&open=1` → 73 条且口径写明「只看未截止」；
  `/?source=npc` → 5 条并显示来源名「全国人大网·法律草案征求意见」；
  `/feed.xml?source=npc&open=1` → 频道标题带条件、self 带条件、5 条；
  `/stats` 的「各来源收录量」11 行、数字与点进去的条数一致（0 的行退化成纯文本，符合 #53 的约定）。

## 五、随后接着做的两件（用户打字授权：「两个待办都通过，按顺序继续实施」）

**1. `ATTACHMENT_TEXT` 翻 `on`（`.env` 第 26 行）**

- 改法：`cp .env .env.bak-20260924-pre-attachment-on` → `sed` 只改那一行 →
  用两份「去掉该行后」的临时文件 `diff` 证明**其余 25 行逐字未动** → `up -d web worker`。
  凭据全程不上命令行（这是非密钥值，但同一条命令也不打印 `.env` 内容）。
- 取证：worker 日志 `附件抽取（on）本轮…`。这一轮「无待摘要条目」（那 5 条待摘要的条目
  在翻档之前的 12:15 那轮已被摘要掉），所以**条文真的进提示词**的线上证据要等今晚
  自然抓取轮（约 14:5x UTC）新入库的条目 —— 届时的日志行是
  「附件条文 N 份 / M 字」+「档位 on」。库里现有 98 行附件、1,479,501 字，
  候选不是空的。
- 顺带确认一件事：`ATTACHMENT_TEXT` 只在 compose 的 **worker** 服务里声明，
  `src/app/**` 完全不读档位（呈现层读的是落库的 `fedToSummary` 与要点出处）。
  所以 web 容器里这个变量为空不是"两处口径分家"，而是本来就不该有。

**2. `deploy/cleanup-govcn-source.sql`（生产数据删除）**

- 执行前发现该文件**不在服务器上** —— 第一批只同步了运行时目录（src/worker/drizzle/scripts/配置），
  `deploy/` 下这几个审计脚本漏了。先补同步再执行（顺带把 `audit-sources-flaky.sql`、
  `deploy/README.md` 一起补齐，保持服务器副本与仓库记录一致）。
- 脚本自带的保险先跑通：删除前那一行 `条目数 = 0` ⇒ `DELETE 1` + `COMMIT`，
  删后回查 0 行。备份用的是本轮那份**已通过恢复校验**的
  `zhurenweng-2026-09-24-120010.dump`（比现做一个没验证过的 dump 更算数）。
- 交叉核对（正是脚本最后那段清单的用途）：库里剩 10 个源，
  `src/sources/adapters/` 也正好 10 个适配器 —— **没有"表里有、注册表里没有"的死行了**；
  十个源的条目数相加 = 192 = 首页「共 192 条」，`/stats` 的来源表也只剩 10 行。

## 六、仍然没做（不在本次授权内）

- 存量 79 条已生成摘要**不会自动补条文要点**（入队条件是摘要为空）。要让它们带上条文，
  需要显式清空重跑，量级约 49 次带条文的境外通道调用（#57 文档里挂的就是这一件，
  也是 task「迭代 1 生产验收」的前置）。
- 附件文件名进检索（先量文件名相对标题的信息增量）。
- 「已出结果」三态收缩还是为 mot 开一口：等产品决定。

## 七、这一轮真正的教训

1. **"迁移会自动跑"不等于"迁移会自动跑对"**：加了一道只在全新库上跑的路径，
   而向后迁移这条路径没人走过。守卫必须造"存量库"的样子，不能只查文件齐不齐。
2. **静默跳过是最坏的失败模式**（本项目在告警降噪、订阅补发、影子档上都踩过同一形状）：
   日志说成功、退出码 0、代码在跑、库缺列。凡是"跳过"的分支，要么响，要么被测试复现。
3. 部署顺序里「备份先行」这次真的用上了：缺列状态下最坏需要回退时，有一个刚验证过可恢复的 dump。
