# issue #67：存量摘要不会自动补条文要点 —— 把「置换」做成可复审的工具

父 issue：`57-attachment-draft-text.md` 第八节第一条（当时记的是"存量 79 条"，实测是 84 条有摘要）。
本轮做完后，「条文要点覆盖率」才第一次成为一个可测的数（task：迭代 1 生产验收）。

## 一、为什么翻了档位也不生效（有意的，但代价要写清）

摘要任务的入队条件（`src/db/repo/summaries.ts`）是三条同时成立：

```
ai_summary_json IS NULL AND summary_status = 'pending' AND status <> 'closed'
```

`ATTACHMENT_TEXT` 已于 2026-09-24 从 `shadow` 翻成 `on`（见 `66-*.md` 第五节），但那只是
**改变喂给模型的内容**，不改变**谁会被喂**。已经生成过摘要的条目摘要列非空，永远不会再
进入队列 —— 所以线上出现了一个分裂的界面：今天之后新抓的条目有「条文要点 + 出处：附件《…」」，
此前的存量只有旧五段式。**84 条存量 vs 每天几条新增**，不显式处理的话这个比例会长期停在那儿。

不清空存量是 #4 以来的设计，理由仍然成立：

- 不覆盖已被人工复核过的结果（复核队列在 `failed_review` 那一侧）；
- 不每天重烧一遍调用 —— 走的是境外网关（PRD 第 49 条要求的国产备案模型仍未落地），既有钱的
  问题也有合规债，每一次调用都是欠着的。

代价就是这条：**#57 第 5 步对存量不生效**。要生效只能显式置换，而置换是**写生产数据 + 一次性
约 50 次境外调用**，所以它必须是一个可复审、可中止、可回滚的工具，不是一句手打的 `UPDATE`。

## 二、两个不能靠人记住的坑

1. **清空是单向的**。`ai_summary_json` 里没有别处能恢复的东西：旧摘要是模型输出，重跑一次
   就是另一份。所以"先拿到旧值、再清"必须是同一个函数里、同一件事的前后两步 —— 顺序错了
   就等于把一条本来能看的摘要弄丢（新输出更差、或模型这轮失败，都是真实可能的结果）。
2. **已截止条目清了就是永久失去摘要**。入队过滤排除了 `status='closed'`（截止后再提意见没有
   对象，#4 的设计），所以清空后那条页面会长期挂着「未生成摘要」。候选因此**硬性排除**已截止
   （实测 84 条里有 2 条），而不是"清完发现没生成再抱怨"。

「这条现在重跑到底会不会带上条文」的判据**复用摘要任务自己的** `draftSourcesForSummary()`
（本轮把它导出）：同一份 400 字门槛、同一份 8,000/12,000 汉字预算、同一个档位判断。脚本里另写
一份的后果是可以预见的 —— 脚本说"有条文"、真跑起来没有，白花一次调用还以为是模型的问题。

## 三、工具的三道门

```
docker compose run --rm worker node scripts/reset-summaries-for-redraft.mjs            # 只读
docker compose run --rm worker node scripts/reset-summaries-for-redraft.mjs --apply --limit 3   # 金丝雀（--apply 不给 limit 默认就是 3）
docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng \
  worker node scripts/reset-summaries-for-redraft.mjs --apply --all 2>&1 | tee /root/redraft.log
```

- **默认只读**：不加 `--apply` 一个字都不改，打的是「候选多少、其中几条真会喂进条文、各自几份
  多少字」，按字数降序（收益大的在前）。
- **`--all` 要显式写**：不给 limit 而又不写 `--all` 是金丝雀 3 条，防止"以为在放量其实在试水"
  和反向的"以为在试水其实在放量"。
- **幂等**：已经带得出可核对条文要点的条目自动跳过（判据用详情页同一个解析器
  `parseQuotedSummary`，不另写口径）。少了这条，工具跑第二次会把刚补好的再清一遍。

## 四、生产执行记录（2026-09-24）

置换前现场（`deploy/audit-redraft-state.sql`，只读）：

| 指标 | 实测 |
| --- | --- |
| 条目总数 | 192 |
| 已有摘要 | 84（全部是合法 JSON） |
| 已截止 | 110 |
| 队列里待生成 | 0 |

金丝雀 3 条清空后重新生成，三条**全部**带出可核对的出处（worker 日志：`条目 41f2e22edef76d7e
摘要完成（model=mimo-v2.5，附件条文 3 份 / 7913 字）`）：`41f2e22e` 2/2 要点带出处、
`9924f329` 2/2、`b2611378` 1/1；线上页面 `https://cn101.top/notices/41f2e22edef76d7e` 可见
`data-testid="summary-key-points"` 与「出处：附件《水质 N,N-二甲基甲酰胺…（征求意见稿）》」。

放量：dry-run 给出的名单是 79 条池子里 49 条会真喂进条文（另 30 条没有可读条文，不动），
清空 49 条、备份 49 行 / 33,470 字符旧摘要，重跑速率实测约 1 条/分钟。

终值（49 条全部跑完，`deploy/audit-redraft-state.sql` 只读核对）：

- **要点带得出附件出处的条目：3 → 46**（全站 84 条有摘要里的 46 条）。放量的 49 条里
  **43 条产出至少一条可核对要点，6 条一条都没有** —— 模型那轮没给出能从条文里逐字对上的句子，
  程序侧就按设计把它丢了。所以覆盖率是 43/49 = 88%，报数不能按"49 条全中"算。
- **出处正确性 131 / 131**：页面上每句引用拿去与该条目的附件抽取正文比（去掉全部空白，与程序侧
  同一口径），131 句全部逐字命中，**0 句对不上**（第 7 段列的就是"对不上"的，跑完是 0 行）。
  这一段是独立复核，不是重复程序的说法。
- 失败面全零：`failed` 0、`failed_review` 0、队列 `queued_now` 0 —— 49 次带长输入的境外调用
  没有一条打到重试耗尽。
- 已截止的 110 条不受影响（入队过滤本来就排除它们，页面上仍写「未生成摘要」）。
- 重跑速率约 1 条/分钟（13:46 开始，49 条约一小时跑完），条文越长越慢。

重取一次的方法：`cat deploy/audit-redraft-state.sql | docker compose exec -T db psql -U zhurenweng -d zhurenweng`

## 五、踩到的三个坑（共同点：都是静默不对，不是报错）

1. **同步 ≠ 部署**。第一次 dry-run 跑出了**旧版**脚本的行为（没有幂等过滤，把刚补好的 3 条
   又列成候选）。原因：`sync-files-local.sh` 只写宿主机的 `/opt/zhurenweng`，而
   `docker compose run` 用的是**镜像里那份代码**。这条已写进 `deploy/README.md`
   （改完脚本要 `build` → `run` → `up -d`，否则常驻容器也还是旧镜像）。
2. **`compose run --rm` 会删掉容器内写的文件**。金丝雀那次脚本报"已备份"，宿主机上却查不到
   那个文件。当时从当天 12:00 的日备份 dump 里把 3 条旧摘要救出来（恢复进临时库
   `zw_dumpcheck`，取完 `DROP`），然后把备份改成**以 stdout 的 `#BACKUP` 行为权威**、写文件只是
   方便（失败不再中止），并在文档里明确调用方要么带 `-v` 要么 `| tee`。
3. **撤实现脚本与 `npm run build` 并行**。见下节。

## 六、顺带修的一处工具缺陷：撤实现被强杀会留下假代码

本轮最后一次 `check-test-pins.mjs` 被我扔在后台与 build 并行跑，之后中途终止 —— Windows 上
终止进程不跑 `process.on('exit')` 钩子，于是工作区里留下一处"撤掉实现"后的假代码
（`registered: true`），而**同一时刻 build 正在读源码**，它被编进 `.next`，e2e 当场报了一条与
本 issue 毫无关系的红（`summary-not-generated` 那段），看起来完全像是 #67 引入了回归。

修了三处：

- **留痕自愈**：改写源码前把 `{label, file, original, mutated}` 落到 `.pins-inflight.json`
  （已 gitignore），下次启动看到残留就把那个文件从"假代码"还原回原样。还原条件收紧成
  "当前内容与当时写入的假代码逐字节相同"才动手 —— 中途文件又被人工改过时**不动它**，只非零
  退出并提示 `git diff`，因为自动写回一份过期原文会连带抹掉别人的改动。
- **规则 4**：`from` 那串在目标文件里**第一次出现的地方必须就是要撤的那一处**（`String#replace`
  只换第一个匹配）。这条在"把脚本自己也当靶子"时必然破 —— 我第一版把 `recoverInflight();`
  写进 CASES，撤的是 CASES 里那行引用，用例永远为绿。当场靠"撤掉修复要真会红"自查出来，
  连验两次才真红。
- **头注**：这个脚本会改写工作区源码，跑它的时候不要同时跑任何读源码的东西。
- 顺手删掉**一条钉不住的 pin**：`clearSummaryForRedraft` 里那句 `if (ids.length === 0) return []`
  原本占了一个 pin 位，实测撤掉它 e2e 仍然全绿 —— drizzle 把空的 `inArray` 编成恒假条件而不是
  非法 SQL。保护留着（不该依赖驱动怎么编空集合），pin 位删掉并把原因写在 `CASES` 旁边：
  **留一条永远不红的 pin，比不留更糟**，因为下一轮会以为它被验证过。

pins 因此是 **85 → 88**（新增 3 条真会红的：清空却不置回 pending、置回时漏清模型名、崩溃不自愈）。

另外把「怎么把一条摘要放回队列」收成一份实现：复核队列的 `resetNoticeSummaryForRetry` 现在
委托给 `clearSummaryForRedraft`（原先两处各写一遍那两个 `set` 字段，少写一个字段条目就留在
`failed_review` 里谁也捡不起来）。

## 七、要回滚怎么做

备份在 `/var/backups/zhurenweng/pre-redraft-2026-09-24T13-43-43-721Z.jsonl`（同时也在
`/root/redraft-all.log` 的 `#BACKUP` 行里）。按 id 写回旧值并把状态置回 `done`：

```bash
cd /opt/zhurenweng
python3 - <<'PY' > /tmp/restore-redraft.sql
import json
for line in open('/var/backups/zhurenweng/pre-redraft-2026-09-24T13-43-43-721Z.jsonl'):
    r = json.loads(line)
    s, m = r['previousSummaryJson'] or '', r['previousModel'] or ''
    assert '$zw$' not in s and '$zw$' not in m, r['id']   # 美元引用不能自嵌套，撞上了就地失败
    print("update notices set ai_summary_json=$zw$%s$zw$, summary_model=%s, summary_status='done' "
          "where id='%s';" % (s, "'%s'" % m if m else 'null', r['id']))
PY
docker compose exec -T db psql -U zhurenweng -d zhurenweng -v ON_ERROR_STOP=1 -f - < /tmp/restore-redraft.sql
```

逐条 `update`，所以**部分回滚**就是只跑那几条（按 id 过滤那份 SQL）。回滚会把新生成的摘要覆盖掉
—— 这正是它的语义，别在跑完之后又跑一次置换工具（工具会认为新摘要已被跳过条件放过）。

## 八、未做（有意）

- **30 条没有可读条文的存量**（附件没抽出来 / 没附件 / 正文本身够长）不重跑：喂不进新输入，
  重跑只会得到另一份不知道好在哪的摘要，白花一次境外调用。
- **110 条已截止**不补（#4 的入队设计，页面文案已按 #58 改成「未生成摘要」而不是谎称生成中）。
- 重跑后**要点数量可能变少**（模型换了输出），这类差异没有自动判优的手段，只能靠出处可核对；
  抽查 3 条金丝雀的结论是「带出处的要点全部可核」。
