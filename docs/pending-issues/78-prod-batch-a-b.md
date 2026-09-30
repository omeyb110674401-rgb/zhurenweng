# 78 — A/B 生产批次（执行记录）

> 这是**执行记录**，不是计划。用户在 2026-09-25 授权「A 部署批次 + B 数据删除」全部动作，
> 本文件记结果 —— **包括没做成的那个（A3）和我判断错的地方**。

## 一、结论速览

| 项 | 结果 | 产物证据 |
| --- | --- | --- |
| 矛盾裁决：#71/#74/#75/#76 到底部署了没 | **已裁决：部署了**。`c68f65b` 对，`FOLLOWUPS.md` 那三行是过期的 | 宿主与镜像逐文件 sha256 |
| A1 同步 + 重建 + `up -d` | **完成** | web `9033d6f5584c` / worker `a844be13ce4a`，00:14 构建，00:15 起容器 |
| A2 部署后当场自证 | **全绿** | 健康清单 7 项（1 warn）/ RSS 192=192，退出码均 0 |
| A3 #76 金丝雀重跑 | **没做成**（跑了，但产出是空的） | `changes=0 条`、`explanationPoints=0 条`；见第四节 |
| A4 #73 订阅闭环取证 | **完成，且与预测逐字吻合** | `reminder_sends` 0 → **5**，`notice_notifications` **0** |
| B1 机器点击清理 | **完成（比原描述范围更大，用户当场同意）** | `DELETE 96` / `UPDATE 88`，两张备份表 |
| B2 govcn 死源 | **已是空操作** | 该行早已不存在，`DELETE 0`；库里 10 源与注册表 10 个适配器完全一致 |
| 顺带查出 | **一处新缺陷**：体裁词表与改动词表不一致 ⇒ 读者看到一个空的「改动点」栏 | 见 `79-amendment-genre-false-positive.md` |

## 二、裁决：#71/#74/#75/#76 是**已部署**的，`FOLLOWUPS.md` 三行过期

`c68f65b` 的标题写「#71 与 #75 已部署并在生产实测」，而 `FOLLOWUPS.md` 写「仍欠的是部署」。
按规矩以生产实况为准，方法是**逐文件 sha256 比对**，不靠读文档：

- 先在开发机与生产各跑**同一份**清单脚本（`src/ worker/ drizzle/ scripts/ deploy/ public/`
  + 根级配置共 238 个文件），并**统一去掉 `\r` 再哈希** —— 因为传输通道会把 CRLF 改写成 LF，
  不归一化会把每个文件都报成"不同"（第一版就报了 518 行全变，其实是行尾）。
- 结果：**238 个共有文件里 0 个内容不同**；只有两处不对称，都是预期的
  （`deploy/sync-files-local.sh` 只在开发机、`deploy/deploy-33.sh` 只在生产）。
- 裁决前生产是**落后**的：11 个文件对应更早的本地提交，没有任何"生产独有改动"
  ⇒ 没人热修过生产，只是上次只同步了 #71/#75/#76 需要的那几个文件。

`FOLLOWUPS.md` 里#71「生效要一次授权」、#75「仍欠的是部署」、#76 第 3 刀「已实现，还没部署」
三行都写于那次部署之前，属于**过期描述**，已在本轮更正。

## 三、A1/A2 的产物

同步 12 个文件（逐文件 sha256 校验；`scripts/check-test-pins.mjs` 压缩后 24,116 字符超过
单条命令约 20,000 的上限，走了分块路径，9 块，最终校验通过）。

**一个必须成对同步的坑**：`package.json` 本轮新增了 `prebuild` / `pree2e` / `pretest:unit`
三个前置门，而门脚本 `scripts/check-pins-clean.mjs` 是生产上**没有的新文件**。
若只传 `package.json` 不传它，`Dockerfile.web` 的 `RUN npm run build` 会因 `prebuild`
找不到模块而**构建失败**。两个文件一起传了；该脚本是纯读的（不碰 git），生产无 `.git` 也能跑。

`docker compose up -d` 重建了 web / worker / caddy，新镜像就位。worker 启动即跑一轮
（`worker/index.ts:88` 的 `await guardedTick()` 在 `setInterval` 之前）：10 个源全抓、
178 条更新 0 条新增、附件抽取、摘要、发信、reindex 192 条。

A2 自证（**用镜像里的探针**，不是宿主上的文件）：

```
[health] provider=meilisearch 条目 192 未截止 81 备份目录=/var/backups/zhurenweng
  ✓ 每日备份产物：最新 dump 0.9 小时前（阈值 26 小时）
  ✓ 抓取新鲜度：最近一条新收录 28.1 小时前（阈值 48 小时）
  ✓ 摘要队列：待生成 0 条（每轮上限 50）
  ✓ 发信闭环：可发订阅者 1 人（历史发出 5 封）
  ! 近 7 天出站点击：0 次（0 次是需求侧事实，不判故障）
  ✓ 检索索引可搜性：抽样 12 条，搜不到自己的 0 条
  ✓ RSS feed 产物：192 条 item，guid 与库里对得上、链接指向本站
[health] 总结论 warn          ← 只因上面那条 warn，退出码 0
[audit-rss] 取 https://cn101.top/feed.xml：feed 里 192 条 item，库内 192 条
  [audit-rss] 读者今天能拿到完整的一批条目
```

`worker` 容器里的 `SITE_URL=https://cn101.top` 已注入（**看容器不看 compose 文件**）——
#75 那句「注入要 `up -d worker` 才生效」现在是生效状态。

那条 `warn` 是 B1 的直接结果：出站点击被清零了，探针按设计把"0 次"判为需求侧事实而非故障。

## 四、A3 没做成 —— 以及我是怎么先把它误报成做成的

**先说错在哪。** 我在看到库里 `changes=true explanationPoints=true` 时宣布 A3 成功。
那个判据用的是 `ai_summary_json::jsonb ? 'changes'`，**问的是"这个键在不在"，不是"数组空不空"**。
空数组 `[]` 一样满足它 —— 也就是说，**这条判据从一开始就不可能失败**。真正该问的是
`jsonb_array_length(... -> 'changes')`。

实况（补测）：

```
changes 实际条数 = 0      explanationPoints 实际条数 = 0      amendmentCoverage = NULL
全库 84 条摘要：changes 非空 0 条，explanationPoints 非空 0 条
线上详情页：有「改动点」小节，但内容是「未在附件正文里检测到成文的修改表述（按标题判为修正案）」；
             「编制说明要点」小节**根本没渲染**（证据页 .live-76-a3-detail.html）
```

所以 **#76 第 2/3 刀在线上仍未证明**，A3 的目标没达成。

### 根因（已定位到两处，一处确定、一处未定）

**确定的这处**：金丝雀被判成修正案的依据是 `attachment_text` ·「附件正文含对照措辞**「现行」**」，
而它实际是一份**全新标准**的征求意见稿（《美丽河湖评价技术导则（征求意见稿）》）——
「现行」出现在它的编制说明里（"现行标准"这类说法），**不是**在描述对既有条文的改动。
喂进去的正文里 `changeMarkers.total = 0`，所以模型没有改动点可写，页面就渲染出一个空的「改动点」栏。

这**正是代码注释里声明不可能发生的那件事**：`notice-genre.ts:57` 与
`amendment-coverage.ts:26` 都写着"判体裁和算覆盖度必须认同一批词"，但两份词表并不一致：

- 体裁词表 `AMENDMENT_TEXT_MARKERS`（`notice-genre.ts:60`）：
  `修改为 / 删去 / 增加一条 / 原条款 / 现行`
- 改动类型词表 `KIND_PATTERNS`（`amendment-coverage.ts:29`）：
  `修改为 / 修改如下 / 作…修改 / 增加一条 / 新增…条 / 删去 / 删除 / 作为第…条 / 顺序作…调整`

**`现行` 与 `原条款` 只在体裁词表里**。按 `genre_basis` 分布：52 条修正案中
**23 条（44%）** 是靠这两个词判进来的（`现行` 22 条、`原条款` 1 条），
它们一旦重跑摘要就会各自长出一个空的「改动点」栏。

顺带一处文案错：那行说明硬编码成「（按标题判为修正案）」，而这 22 条的判据明明是附件正文。
注释 `amendment-coverage.ts:68` 也写着"体裁是靠标题判的"——这个前提同样过期了。

**未定的这处**：编制说明**确实喂进去了**（17,631 字，`fed_to_summary=1`），
`explanationSections=39`（说明里检出了 39 个小节标题），上限也不卡（`MAX_EXPLANATION_POINTS=24`），
**但 `explanationPoints` 是 0 条**。两种可能无法从库里区分：模型自己返回了空数组，
或返回的 `quote` 没通过"逐字反查"被整条丢弃。要定位得拿到那一次模型原始输出，
不该靠猜 —— 记在 `79-amendment-genre-false-positive.md` 里当下一个动作。

## 五、A4 完成，且与 #73 的预测逐字吻合

`73-subscription-value-measured.md` 09-25 算过：恢复站长那条「数据」规则的订阅后，
**"应当出现 5 条左右 `reminder_sends` 行、0 条新公示通知"**。实跑：

```
截止提醒已发送 stage=d7 剩余=0天 notice=3dbaab0ce87a29df to=3525****@qq.com
截止提醒已发送 stage=d7 剩余=0天 notice=857e3efe9c7f324c to=…
截止提醒已发送 stage=d7 剩余=0天 notice=d36371e0b753cd05 to=…
截止提醒已发送 stage=d7 剩余=0天 notice=7f7af8210fd74462 to=…
截止提醒已发送 stage=d7 剩余=0天 notice=6f6fb1e6edbe3f34 to=…
截止提醒任务完成：候选条目 81，订阅 1，发送 5 封，去重跳过 0 次
新公示通知任务完成：候选条目 5，订阅 1，发送 0 封，无需发送 1 人，失败 0 次
```

`reminder_sends` 0 → 5，`notice_notifications` 保持 0 —— **预测的 5 与 0 都对上了**。
判据 `deploy/audit-email-paths.sql` 与健康清单的"历史发出 5 封"互相独立地印证了同一件事。
（上面日志里收件人邮箱的本地部分**打了码** —— 2026-09-30 上线前扫查时改的，理由见
`73-subscription-value-measured.md` 里那条说明。）

**收件人是站长本人**（订阅地址与 `ALERT_EMAIL`、`SMTP_USER` 同一），所以这不是给第三方发信；
但**"邮件真的在 QQ 邮箱里能看到"这一条只有站长能确认**（#73 第 39 行把它写成了判据的一半）。
另需站长定夺：`unsubscribed_at` 现在被清成了 NULL，**订阅是活的**，下一轮还会按规则发提醒；
要退回退订状态，原值 `2026-09-21T16:33:40.643Z` 在 `subscriptions_backup_20260925` 里，一行 SQL 即可。

## 六、B1 —— 现场那个脚本会多删，用户当场改口"全删也行"

`/root/cleanup-machine-clicks.sql` 写于 **2026-09-20**，当时 `notices.outbound_clicks`
只有当天数据，所以它写成：

```sql
DELETE FROM outbound_click_daily WHERE click_date = '2026-09-20';   -- 按日期
UPDATE notices SET outbound_clicks = 0 WHERE outbound_clicks > 0;   -- 全局！
```

放到今天两条口径就不一致了：`DELETE` 只删 09-20，`UPDATE` 却把 09-21~09-25 累积的计数
一起清零。实测当时 09-20 是 **59 行 / 74 次**（授权时的描述写的是"46 行"，与实物不符），
全期 **113 次**，照原样跑会多删 39 次。**没跑原脚本**，先问了用户。

用户答复：**「没事，全删了都行。目前不在乎点击量」** ⇒ 改成口径一致的**全量清零 + 两份备份表**，
落在 `deploy/cleanup-click-pollution.sql`（`DELETE 96` / `UPDATE 88` / `COMMIT`，前后回查均为 0）。
同时把 `/root/cleanup-machine-clicks.sql` 换成 9 行指路牌 —— 否则下一个读 `FOLLOWUPS.md`
的人还会照那行"已就位"去跑它，这是本仓库反复踩的同一类坑。

回滚：`outbound_click_daily_backup_20260925`（96 行 / 113 次）+
`notices_clicks_backup_20260925`（88 行 / 113 次），语句写在那个 SQL 文件末尾。

## 七、B2 是空操作，但顺带确认了一件更有用的事

`govcn` 那行**早已不存在**（脚本 `DELETE 0`）。顺手把库里源清单与
`src/sources/registry.ts` 的适配器对了一遍：**10 个 id 完全一致**（cac / mee / miit / moe /
mohurd / moj / mot / ndrc / npc / samr），10 个源 `consecutive_failures` 全 0、无错误记录。
所以"表里有、注册表里没有"的同类死行现在是 **0 条**。

## 八、退路与凭证

| 东西 | 位置 |
| --- | --- |
| 数据库整库 | `/var/backups/zhurenweng/zhurenweng-2026-09-25-152516.dump`（1,235,842 字节，**恢复校验 6 项计数全过**，跑在每个生产写之前） |
| 84 条摘要 | `summary_backup_20260925` |
| 订阅行 | `subscriptions_backup_20260925` |
| 点击两口径 | `outbound_click_daily_backup_20260925` + `notices_clicks_backup_20260925` |
| 文件回滚 | 12 个被同步文件各自对应哪个历史提交，见本文件第二节的口径（`git show <commit>:<path>` 再回传） |
| 线上详情页 | `.live-76-a3-detail.html`（A3 的证据页） |

## 九、通道上的三条教训（下次直接照用）

1. **辅助脚本 ASCII-only**：本机是 **Windows PowerShell 5.1**，读无 BOM 的 `.ps1` 用 ANSI 代码页，
   带中文注释的 helper 会被解成乱码、**解析失败在开头**（报 `Unexpected token ')'`）。第一版就这样挂了。
2. **`workbench exec` 是串行的**：我挂了一个长达 30 分钟的等待作业，之后**所有**探针都超时且无输出
   —— 包括只有 `date` 的。杀掉那个作业后，同样的探针 **0.23 秒**返回。要等长任务，去远端挂一个
   哨兵进程写状态文件，本地用**短**探针轮询，别占着通道等。
3. **构建日志不带 TTY 时不刷**：buildkit 会在**一步结束时**才整块吐出该步输出，所以 `npm ci`
   跑着的 45 分钟里日志一直停在 1566 字节 —— 那不是卡住。判进度要看 `/proc/<pid>/io` 的
   `wchar`/`write_bytes` 有没有涨（实测从 469 MB 涨到 865 MB）。

另：`npm ci` 慢是因为 Dockerfile 没配 npm 缓存挂载，**每次构建都重新下载整棵依赖树**，
本轮约 45 分钟。要提速就加 `--mount=type=cache,target=/root/.npm`，属独立一轮。

> **2026-09-27 更正（issue #84 部署时实测）**：上面这条归因**不准确**。缓存挂载只是次要项，
> 主因是**官方 npm 源在这台机器上被限速**：同一时刻量 `registry.npmjs.org` 的 `next` 元数据
> （31 MB）25 秒只下来 3.4 MB（≈136 KB/s），而 `registry.npmmirror.com` 同一份 **1.65 秒**。
> 缓存挂载救不了元数据那一段（每个 packument 仍要重新拉），换成镜像源才是根上的修法：#84 把
> npm 源做成构建期可配（`ARG NPM_REGISTRY` + compose `build.args` + `.env`），改完那次
> `npm ci` + 双镜像**约 2 分钟**。缓存挂载仍值得做（省已下载的 tarball），但它不是这个数的来源。

## 十、没做 / 待用户

- **#76 第 2/3 刀在线上仍未证明**，且查出体裁词表不一致这个新缺陷 —— 见
  `79-amendment-genre-false-positive.md`（含 23/52 受影响面与建议改法）。
- **订阅现在是活的**，要不要恢复退订状态由站长定（原值与回滚 SQL 见第五节）。
- **健康清单仍未接 cron 告警**（#74 本来的诉求）。探针已部署且实测可跑，接上仍欠一次授权；
  与 #75 一样排在 **task #44** 那个批次里 —— 而 `task #44` 到底指什么，全仓库没有解释，
  仍待用户澄清（`FOLLOWUPS.md` 的 #74/#75 两行都在引用它）。
- 本次没有改动任何源码，所以没有新增迁移、没有需要重建的镜像。
