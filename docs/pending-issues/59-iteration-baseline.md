# issue #59：迭代基线 —— 备份可恢复性、第二个幽灵旋钮、以及六轮功能补全的顺序

对应提交：（本轮）

## 一、为什么开这一轮

上一轮评估（issue #58 之后）给出过一个判断：「PRD 的 14 条 user story 全部有实现」。
这个判断按「代码里有没有」成立，按「产品能不能兑现」**不成立** —— 用户指出
「功能并不完整，上周 commit 基本没什么实质性增强，除了附件读取」，重查后坐实：

| 实测项 | 结论 |
| --- | --- |
| `select count(*) from notices where version_of is not null` | **0 条**（187 条中）⇒ 条款对比（story 10 / M3）线上**完全不可达**，是从没人打开过的空壳 |
| `select count(*) from notices where status='resulted'` | **0 条** ⇒ PRD 的三态只有两态有数据；`resulted` 在类型/CSS/徽标里都存在，但**零写入路径** |
| `select count(*) ... where title ~ '反馈\|结果\|采纳'` | **0 条** ⇒ 不是「忘了写状态」，而是**采集口径根本不收结果类公告** —— 做三态要先扩采集面 |
| `notice_attachments` 按状态聚合 | ok 70 行 / **1,477,508 字**、pending 17、no_draft_text 10、too_large 1、**blocked 0**；覆盖 49 条 open 条目（= open 的 **62%**） |
| `attachmentTextFeedsSummary()` 的调用者 | **零**（全仓 grep 只有定义）⇒ `ATTACHMENT_TEXT=on` 与 `shadow` 当前行为完全相同 |
| 服务器 `crontab -l` | `no crontab for root`；唯一 `pg_dump` 停在 2026-09-20（早于 0009 附件表）⇒ **147 万字从未被备份过** |

所以本轮不做新功能，先把「已付成本却没兑现」和「说了没做」的两件事收口，并把后续六轮
的顺序定下来（第六节）。

## 二、本轮改了什么

### 1. 第二个幽灵旋钮：`ATTACHMENT_TEXT` 的缺省从 `on` 改成 `shadow`

#58 刚以「存在、每次被写、没人读」为理由删掉了 `sources.schedule_config_json`，
而同一个毛病在配置面还留着一个：`attachment-mode.ts` 未设置时缺省 `'on'`、
`docker-compose.yml` 回退值 `:-on`、`.env.example` 也写着 `on`，注释还教操作者
「shadow 跑一轮看成功率再转 on」—— 可是 `on` 那条路径压根没接线，改它毫无效果。

改法：三处缺省统一成**今天真会生效的那一档** `shadow`，并在
`src/lib/attachment-mode.ts` 的文档注释里写明「为什么不是 on」与「第 5 步接上后三处一起改回」。
生产 `.env` 本来就显式写着 `shadow`（实测），所以这次改动不影响线上行为 —— 它修的是**契约的谎**。

### 2. 每日备份 + 每日恢复校验：`deploy/daily-backup.sh`

不是「跑个 pg_dump 写到盘上」：脚本每天把归档**真的恢复进临时库** `zw_backup_verify`，
比对 6 项关键计数（条目数 / 有摘要数 / 附件行数 / 已抽字数量 / 订阅数 / 源数），
任一项不一致就非零退出；先写 `.part` 再改名，避免半截归档被当成有效备份；
小于 10KB 直接判失败；保留 7 份。

`docs/deploy.md` 第 8 节原来那条「手工 `pg_dump`」被换成了安装命令与失败口径 ——
那条建议 existed 四年没救过任何东西，因为**没人会每天手工执行它**。

### 3. #58 上线前的两条只读前置核查（已跑，全绿）

- `select count(*) from sources where schedule_config_json <> '{}'` ⇒ **0**（DROP COLUMN 安全）
- `select count(*) from notices where source_id='govcn'` ⇒ **0**（DELETE 的保险条件成立）
- 唯一 `healthy=0` 的行就是 `govcn` ⇒ 0010 的「播种 2 轮」只会播种它，删掉它之后没有副作用

## 三、测试

- 单测 `tests/unit/config-guards.test.mjs` 新增 describe「附件档位（ATTACHMENT_TEXT）」4 例：
  缺省 shadow 且抽取仍跑 / `off` 两侧都关而 `on` 只放开摘要读 / 空串与空白按未设置处理且大小写不敏感 /
  非法档位报错不静默降级。
- 单测 `tests/unit/deploy-env-contract.test.mjs` 新增一条**三方缺省一致**断言：
  代码 `attachmentMode()` 未设置时的返回值 == `.env.example` 写的值 == compose 的 `:-` 回退值。
  这条断言的作用是把三处改动**绑死**：将来第 5 步接线要改回 `on`，只改一处就红。
- 自证 `scripts/check-test-pins.mjs` 新增 3 条（缺省写回 on / shadow 也放开摘要读 /
  compose 回退值漂移），门总数 **35/35 全红**。此后 #57 第 5/6 步接线又加到 **41/41**，
  缺省也已改回 `on`（三处一致断言绑死）。
- `npx tsc --noEmit` 通过；`npm run test:unit` **296 通过 / 0 失败**。

## 四、待授权执行（本轮未做，顺序即验收顺序）

1. 传 `deploy/daily-backup.sh` 上服务器 → 手动跑一次 → 确认 6 项校验通过并留下 `.dump` 产物；
2. 安装 root crontab（`30 19 * * *`，UTC；日志 `/var/log/zhurenweng-backup.log`）；
3. 跑 `deploy/cleanup-govcn-source.sql` 的 DELETE（保险条件已实测成立）；
4. 同步 #58 的 48 个文件 + `docker compose build web worker && up -d` ⇒ 迁移 0010/0011 自动生效；
5. 按 `58-source-signal-and-honest-copy.md` 第九节回查表读回 `sources`；
6. **等下一轮自然调度**（不手工多跑）验证：慢源首轮仍绿且不发信、连续两轮才红且恰好一封。

## 五、明确不在本轮做

- ~~把缺省改回 `on`~~ **已做**（`3b599f1`：#57 第 5/6 步接线后三处一起改回 `on`，并由 `tests/e2e/summary-draft-input.test.mjs` 证明两档产出的摘要确实不同）；
- 备份的第二份异地副本：`workbench exec` 的输出通道不适合传 MB 级文件，等托管/对象存储方向定下来；
- 镜像多阶段与降权、`/api/health`、表增长上限（#51 挂账，单独一轮）；
- 境外 AI 通道换国产直连（PRD 第 49 条合规债，只改 `.env`，但要单独授权与单独实测耗时）。

## 六、后续六轮迭代的顺序（已与用户确认）

| 轮次 | 目标 | 对应缺口 |
| --- | --- | --- |
| 0 | 本轮：备份可恢复 + 旋钮诚实 + #58 上线 | 存续风险 |
| 1 | **条文进摘要、条文给读者**（#57 第 5~8 步） | 147 万字未接入（62% open 条目受益） |
| 2 | 「已出结果」三态：先**只读探测 10 个源有没有结果公告**，再决定做完整闭环还是按实测收缩 PRD | `resulted` 零数据零写入 |
| ~~3~~ | **已按实测撤销**（见 FOLLOWUPS 的 #59/#10 行）：生产跑 `audit-versions.mjs` 证明 186 个分组全是单成员、连宽松法案名分组都零候选 ⇒ 放宽算法只会造出 0 条链。条款对比要成立只能靠回填历史旧页（同案多轮间隔数月），那要单独决定 | `version_of` 0 条的成因不是规则太严 |
| 4 | 订阅与通知闭环：按机关订阅、订「全部新条目」、每日新公示通知、改规则入口、提醒档位窗口化 | 转化漏斗末端 |
| 5 | 发现层与诚实化收尾：可选排序、「只看未截止」、附件文件名/机关进检索、渠道抽不到的说明、RSS 子 feed | 排序只有一套、索引只三字段 —— **第 1 刀排序 / `?open=1` / `?since=` / 「新」角标见 #62，第 2 刀 RSS 子 feed 见 #63**，其余分刀继续 |
