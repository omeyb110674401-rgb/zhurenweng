# 主人翁（zhurenweng）

政府公示与征求意见信息聚合网站：把分散在官方渠道的国家级公示 / 征求意见稿聚合起来，
用 AI 摘要帮助公众「**发现 → 读懂 → 行动**」，行动指引永远指向官方渠道提交意见。

- PRD：`docs/prd/v1.md`
- 架构裁决：`docs/adr/0001-local-dev-without-docker.md`（开发与测试环境脱离 Docker）

## 技术栈

- **Web**：Next.js（App Router）+ TypeScript，服务端渲染为主
- **Worker**：与 web 同仓的 Node 后台任务进程（`worker/`），任务经注册表调度
- **数据访问**：Drizzle ORM，双方言（开发 / 测试 = SQLite 文件库，生产 = PostgreSQL）；
  SQL 只用双方言交集子集，JSON 一律存 TEXT 列
- **测试**：node:test 两层 —— 单元层（`npm run test:unit`，规则表等纯函数，Node 原生
  类型擦除直接 import TS，无需构建）与端到端层（`npm run e2e`：`next build` + 本地
  fixture 源站 + stub LLM / stub 邮件，从 HTTP 层驱动真实管线缝）；`npm test` 依次
  跑两层，**不依赖 Docker 与任何外部服务**

## 目录结构

```
src/app/        Next.js 应用（列表 / 详情 /go/<id> 出站跳转）
src/db/         数据层：schema（sqlite / postgres 镜像）、client、repo
src/lib/        端口接口（ports.ts）、日期工具（dates.ts）与适配器（stubs）
src/sources/    源适配器注册表 + adapters/（数据接入唯一扩展点）
worker/         worker 进程：registry.ts（任务注册表）+ index.ts（主循环）+ jobs/（抓取等任务）
fixtures/       各源页面快照，fixtures/<source>/list.{html,json} 与详情快照
public/         静态资源（og-image.png；favicon / icon.svg / apple-icon.png 走 src/app 的文件约定）
tests/e2e/      端到端测试（node:test）与 fixture 源站 helper
scripts/        fixture 源站 CLI、迁移 CLI、品牌资产生成（gen-brand-assets.mjs）
drizzle/        按方言生成的迁移（sqlite/、pg/）
```

## 本地启动

要求 Node.js >= 22.18（本项目在 Node 24 开发）。

```bash
npm install
npm run dev            # http://localhost:3000
```

默认使用 SQLite 文件库（`data/zhurenweng.db`，已在 .gitignore），首次访问自动建表。
常用环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DB_DRIVER` | `sqlite` | `sqlite` 或 `postgres` |
| `DATABASE_URL` | `data/zhurenweng.db` | SQLite 文件路径或 PG 连接串 |
| `LLM_PROVIDER` | `stub` | `stub`（固定摘要，可注入失败）/ `glm`（智谱 GLM 预设，PRD 默认）/ `openai`（任何 OpenAI 兼容端点） |
| `GLM_API_KEY` / `GLM_API_BASE` / `GLM_MODEL` | （空）/ `https://open.bigmodel.cn/api/paas/v4` / `glm-4-flash` | 智谱预设配置（`LLM_PROVIDER=glm` 时必填 Key，其余有默认值） |
| `LLM_API_KEY` / `LLM_API_BASE` / `LLM_MODEL` | （空） | 通用 OpenAI 兼容端点（`LLM_PROVIDER=openai` 时三项都必填）：换服务商/换模型只改环境变量，不动代码 |
| `LLM_TIMEOUT_MS` / `LLM_EXTRA_HEADERS` | （空） | 单次请求超时（缺省 60000）/ 额外请求头 JSON 对象（部分网关要求客户端带会话头） |
| `LLM_STUB_FAILURES` / `LLM_STUB_CALLS_FILE` | （空） | stub LLM 注入失败（前 N 次调用抛错，或 `always`）/ stub 调用日志 JSONL（跨进程断言调用次数） |
| `SUMMARY_MAX_RETRIES` / `SUMMARY_RETRY_DELAY_MS` | `3` / `500` | 摘要失败重试次数 / 指数退避基数（毫秒） |
| `MAILER_PROVIDER` | `stub` | `stub`（捕获邮件）/ `smtp`（nodemailer 生产实现） |
| `MAILER_OUTBOX_FILE` | （空） | stub 邮件追加写入的 JSONL 文件，供跨进程断言 |
| `SEARCH_PROVIDER` | `local` | `local`（本地实现：SQLite FTS5 / PG ILIKE 退化）/ `meilisearch`（生产检索后端，issue #8） |
| `MEILI_HOST` / `MEILI_API_KEY` | （空） | `SEARCH_PROVIDER=meilisearch` 时的服务地址与 API 密钥（`MEILI_HOST` 必填；兼容 docker-compose 的 `MEILI_URL` / `MEILI_MASTER_KEY` 命名） |
| `MEILI_INDEX_UID` / `MEILI_TASK_TIMEOUT_MS` | `notices` / `10000` | Meilisearch 索引 uid / 异步索引任务等待上限（毫秒） |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | （空） | `MAILER_PROVIDER=smtp` 时的 SMTP 接入配置（`SMTP_SECURE=1` 走 TLS 直连，端口 465 默认 TLS） |
| `APP_BASE_URL` | `http://localhost:3000` | 邮件内确认 / 退订 / 详情链接的站点基础地址 |
| `SITE_URL` | `http://localhost:3000` | RSS feed 内站点链接 / 条目链接的对外绝对地址（issue #6，与 `APP_BASE_URL` 各司其职，见「RSS Feed」） |
| `FIXTURES_DIR` / `FIXTURE_SERVER_PORT` | `fixtures/` / `4170` | fixture 源站目录与端口 |
| `LIST_PAGE_SIZE` | `50` | 首页每页条数（issue #19）。列表按倒计时排序分页，合计与总页数取真实总数；改后 `docker compose up -d web` 即生效（无需重建） |
| `WORKER_INTERVAL_MS` / `WORKER_ONCE` | `60000` / （空） | worker 调度间隔（生产 compose 设为每日） / 单轮模式 |
| `CRAWL_TIMEOUT_MS` | `15000` | 单次抓取请求的总预算（毫秒，issue #58）。`AbortSignal.timeout` 同时掐表头与响应体，所以「连上了但对端不再吐字节」也会被按时掐断，错误消息带上这个毫秒数与 URL。**个别慢源请在适配器里按源声明**（`src/sources/adapters/npc.ts` 的 `fetch.timeoutMs: 30000`），不要抬全局值 —— 它是九个源共用的上限 |
| `SOURCES_FIXTURE_BASE` | （空） | 设置后所有源适配器的列表页 URL 重写为 `<base>/<源ID>/<listFixturePath ?? list.html>`（列表为接口的源用 list.json；测试注入 fixture 源站，不设则抓取真实源站） |
| `ADMIN_TOKEN` | （空） | 管理后台 `/admin` 共享密钥（issue #12）。未配置时恒 401；配置后凭会话 Cookie 访问，`?token=` 用于换取会话（issue #52），详见「管理后台与健康告警」 |
| `ALERT_EMAIL` | （空） | worker 任务失败告警收件邮箱（issue #12）。未配置则不发送告警 |
| `SUBSCRIBE_RATE_LIMIT_PER_HOUR` | `10` | 订阅提交的限流阈值（次/小时，按客户端 IP 的固定窗口；0 = 不限流，issue #52）。订阅端点会真的发信，不限流时等于把本站当发信放大器 |
| `ADMIN_LOGIN_RATE_LIMIT_PER_HOUR` | `30` | 后台登录的限流阈值（同上，issue #52）。计数在**进程内存**里，只对单实例部署有效 |

本地验证抓取管线（fixture 注入）：

```bash
npm run fixtures   # 终端 1：本地 fixture 源站 http://127.0.0.1:4170
SOURCES_FIXTURE_BASE=http://127.0.0.1:4170 WORKER_ONCE=1 npm run worker   # 终端 2：单轮抓取
```

## 运行测试

```bash
npm run test:unit      # 单元层：规则表等纯函数，秒级，无需构建
npm run e2e            # 端到端层：next build + 进程内生产应用 + fixture 源站
npm test               # 等价命令：依次跑上面两层
```

**Windows 上从 Git Bash 跑**（CLAUDE.md 的环境约定）：PATH 里排在前面的
`C:\Windows\System32\bash.exe` 是 **WSL 启动器**，而
`tests/e2e/backup-failure-alert.test.mjs` 要用**仓库里那份真 bash 脚本**
（`deploy/daily-backup.sh`）验证 trap 行为 —— 走 WSL 桩会报出一条与备份逻辑毫无关系的红
（issue #71 的用例在 PowerShell 里必红、Git Bash 里全绿）。用例现在自己解析可用的 bash
（`tests/e2e/helpers/bash.mjs`：先试 Git Bash 的常见安装位置，再试 PATH 上的 `bash`，
**能用才采用**），所以两个 shell 都能跑。Git Bash 装在非默认位置时用 `ZW_BASH` 指过去；
**给了却不可用会当场报错**，不会悄悄退回自动探测（写错的覆盖值应当吵，而不是变成
一个「改了没效果」的旋钮）。

**三个门都带前置检查**（`package.json` 的 `prebuild` / `pree2e` / `pretest:unit` → 
`scripts/check-pins-clean.mjs`）：`check-test-pins.mjs` 靠「撤掉实现、要求测试变红」自证，
所以它运行期间工作区里**真的躺着被撤掉的实现**；被强杀时只留下 `.pins-inflight.json` 留痕，
而自愈要等它**自己下一次启动**。在那之前跑测试会得到一批与被测改动毫无关系的红
（2026-09-25 实测：5 条 `crawl-timeout-guard` 失败，看着像抓取层回归，其实只是那行
`signal: AbortSignal.timeout(...)` 被撤掉了）。现在这个状态会在门的入口被报出来并给出
还原命令：`node scripts/check-test-pins.mjs --recover-only`。
**跑 `check-test-pins.mjs` 本身要留足超时** —— 它要为上百条用例逐个撤实现再跑测试，
**实测约 120 秒**（三次量测都在这个量级）。⚠ 这个数比看起来要命：第一次跑到一半被杀掉的
超时**正好也是 120s** —— 卡在边界上等于抛硬币，跑得完就没事，差一秒就把假代码留在工作区。
**别把超时设在这个值附近。** 以上是在 `.next` 已建好的前提下量的，冷树下指向 e2e 的
那几条没测过。
验证**单条** pin 用 `--only <label 里的子串>`：它只跑匹配的几条，
结论行会写明"**不是**全套的 N 条"（所以不能拿它声称"N/N 全绿"）。
被强杀留下留痕时先 `--recover-only` 还原。详情见 `docs/pending-issues/FOLLOWUPS.md`
与 `scripts/check-test-pins.mjs` 的头部注释。

一条命令完成：`next build` → node:test 启动**进程内生产模式应用**（随机端口）+
本地 fixture 源站，环境注入 SQLite 临时库与 stub LLM / stub 邮件，从 HTTP 层断言：

- 首页 200，含「主人翁」品牌与公示列表空态；
- fixture 源站按 `fixtures/<source>/` 目录服务快照（404 / 路径穿越防护）；
- stub LLM 返回固定结构化摘要、stub 邮件按 JSONL 捕获发出的邮件；
- **issue #3 全链路场景**（`tests/e2e/npc-pipeline.test.mjs`）：真实 worker 进程
  抓取 `fixtures/npc/` 快照 → 幂等入库 → 列表页倒计时 / 排序 / 状态徽标 →
  详情页字段与 AI 摘要展示（已截止条目保持占位）→ `/go/<id>` 302 至官方原文并
  计数 → 重复抓取条目数不变。
- **issue #4 摘要双路径场景**（`tests/e2e/summary-pipeline.test.mjs`）：stub LLM
  全部失败 → 每条目首调 + 3 次重试（调用日志精确计数）→ `failed_review` 转人工
  复核占位，且不再自动重试；追加新条目 → 成功路径 → 详情页参与导引摘要 + 显著
  AI 标注 + 各段原文引用（一键跳官方原文）+ 摘要抽到的地址并入页面上唯一的
  「意见提交方式」块 + 占位消失。
- **issue #5 多源聚合场景**（`tests/e2e/sources-aggregation.test.mjs`）：在 npc
  之上新增司法部（`moj`）与生态环境部（`mee`，issue #14 起替代已下线的中国政府网
  「意见征集」栏目）两个源适配器（列表时间轴 / 正文句截止日期 / 两套详情模板等
  不同版式，证明适配器模式只需适配器文件 + 注册数组条目 + fixture 目录，核心代码
  零改动）：三源条目并存于聚合列表且按截止日期全局排序互不串扰、各源详情字段
  独立解析，同一原文 URL 出现在两个源列表时按原文 URL 唯一键去重只入库一条，
  重复抓取幂等。
- **issue #18 M2 扩源场景**（`tests/e2e/sources-expansion.test.mjs`）：交通运输部 /
  市场监管总局 / 工业和信息化部 / 教育部四源（`fixtures/e2e-sources/`）—— 覆盖
  「接口列表自带征集期」「隐藏字段毫秒时间戳截止日期」「静态列表状态标注」
  「标题取 title 属性」四类接入形态，并锁定状态推导次序（截止日期优先于源标注、
  解析不到时退回源标注）与栏目内非征求意见条目（答记者问 / 结果反馈）的过滤。
- **issue #7 邮件订阅与截止提醒场景**（`tests/e2e/deadline-reminders.test.mjs`）：
  `/subscribe` 表单校验 → double opt-in 确认邮件（outbox 断言）→ 未确认时
  触发提醒任务不发送 → 确认后触发：截止前 7 天 / 3 天各一封，内容含标题、
  剩余天数、截止日期、站内详情与官方原文链接（关键词命中标题 / 正文与领域
  命中标签均覆盖）→ 重跑不重发（`reminder_sends` 去重）→ 规则外条目不发 →
  一键退订立即生效，退订后新条目不再发送。
- **issue #6 全量 RSS feed 场景**（`tests/e2e/feed.test.mjs`）：worker 抓取
  `fixtures/e2e-feed/` 快照（含标题带 `&` / `<` 的条目）→ `/feed.xml`
  channel 结构（自动发现链接 + 页面可见入口）→ item 字段（发布日期倒序、
  详情页绝对链接、`guid isPermaLink=false`、RFC 822 pubDate、description
  含机关 / 截止日期 / 官方原文 / 显著标注的 AI 摘要片段）→ `&` / `<` 转义
  且全文档无裸 `&` → 补插 205 条合成条目后上限恰 200 条且顺序稳定。
- **issue #8 站内搜索场景**（`tests/e2e/search.test.mjs`）：worker 单轮抓取
  fixture → 索引同步（入库钩子 + 全量重建日志）→ 首页搜索框 → 标题关键词
  命中（「国家公园法」）→ 正文关键词命中（「监督检查」）→ AI 摘要文本命中
  → 结果项复用列表条目展示（状态 / 机关 / 截止日期 / 详情链接）→ 无关
  关键词空态 → `q` 为空重定向回列表 → 更新条目正文重新抓取后新关键词命中。
- **issue #10 版本链与条款对比场景**（`tests/e2e/version-diff.test.mjs`）：
  worker 抓取 `fixtures/e2e-versions/` 快照（同一法案两轮公示 + 无关单轮
  条目）→ 版本链自动关联（标题规范化 + 同机关）→ 第 2 轮详情页「对比上一版」
  入口（首轮 / 无关条目不显示）→ 对比视图轮次横幅（第 2 轮 + 上一轮日期）→
  新增 / 删除 / 修改三态高亮至少各一处（修改行含行内删除 / 新增片段）→
  无上一版条目的对比视图友好空态 → 重复抓取版本链不漂移。
- **issue #11 数据统计场景**（`tests/e2e/stats.test.mjs`）：真实 worker 抓取
  `fixtures/e2e-stats/` 三源快照（发布 / 截止日期全用令牌，公示期差值恒定）
  → 空库空态 → HTTP 调 `/go` 构造点击（今天 3 次 + mock.timers 回拨时钟
  昨天 3 次）→ 统计页概览 / 各部门公示量 / 最近 6 个月趋势矩阵 / 公示期
  长度分布四桶 / 点击 Top 榜回链详情页 / 按日期聚合逐项断言 → 重复抓取
  幂等不重算。
- **issue #12 管理后台与健康告警场景**（`tests/e2e/admin.test.mjs`）：仅复制
  npc fixture（moj / mee 404 天然构造部分源失败）→ 未带 token 401 引导页、
  错误 token 恒 401、登录 303 下发 HttpOnly Cookie 后可访问 → 看板展示各源
  最近成功时间与最近错误（HTTP 404）→ 失败源与摘要失败各触发一封告警邮件
  （stub outbox 断言收件人与错误摘要）→ 摘要失败条目进复核队列 → 重置重试
  （stub 恢复）自动补齐摘要 → 另一条人工编辑摘要保存 done → 手动补录条目
  走同一入库 / 摘要 / 索引管线（列表 / 检索 / 摘要断言 + 同 URL 幂等更新 +
  表单校验）→ 同日重复失败与任务级失败（非法 SEARCH_PROVIDER）均按
  （日 × 任务 × 源）去重 → 源停用后抓取跳过、看板即时反映、未授权 POST 401。

本地手动验证订阅提醒全链路：

```bash
npm run fixtures   # 终端 1：本地 fixture 源站 http://127.0.0.1:4170
APP_BASE_URL=http://localhost:3000 npm run dev                        # 终端 2：应用（/subscribe 订阅）
SOURCES_FIXTURE_BASE=http://127.0.0.1:4170 APP_BASE_URL=http://localhost:3000 WORKER_ONCE=1 npm run worker   # 终端 3：单轮抓取 + 提醒
```

## 邮件订阅与截止提醒（issue #7，维度扩展见 issue #60）

- **订阅**（`/subscribe`）：邮箱 + 范围 + 关键词 / 领域 / 发布机关，double opt-in —— 提交后
  先发确认邮件（`/subscribe/confirm?token=…`），点击确认订阅才生效；未确认的
  订阅绝不接收任何提醒。重复提交同邮箱只更新规则（不重复建行），并轮换确认
  token 使旧链接失效。
- **订阅范围**（issue #60）：`scope='rules'` 按条件命中，或 `scope='all'` 订全部新公示。
  范围是**表单里显式选的单选**，放在条件之前，且明写「选这项时下面三项不再生效」——
  刻意不采用「规则为空就当订全部」：空规则更常见的原因是漏填，把漏填解释成"要全部"，
  用户是在收了一堆邮件之后才发现自己没设过条件。反过来，空条件且不选全部 ⇒ 拒绝提交。
- **机关维度**（issue #60）：候选取自库里实际出现过的发布机关（`listNoticeAgencies()`，
  不写死清单）；匹配对条目的**参与机关逐个精确相等**（联合发文 `司法部、中国民用航空局`
  两个机关都能单独命中），两侧都过 `canonicalAgency` 归一。不做子串 ——
  订「司法部」不该收到「司法部办公厅」。提交侧不做白名单过滤：新部委第一次出现时，
  正是用户最想收到的那条。
- **新公示通知**（worker 任务 `notify-new-notices`，issue #60 第 3 刀）：本轮新收录且命中规则的
  公示，每位已确认订阅者**一封汇总**（不是一条一封 —— 个人 SMTP 有日发信上限，
  而"新增三条就三封信"是退订的经典诱因）。「新」的判据是 `notices.first_seen_at`
  （建行时写入、更新永不覆盖），**不是** `fetched_at`（每天被 upsert 覆盖，用它会把老条目天天重发）。
  存量条目该列为 NULL 且刻意不回填 ⇒ 永不通知，这是"刚确认订阅的老邮箱不会被历史条目轰炸"的落点。
  去重键（条目 × 订阅）写在邮件真的发出之后；一封最多 20 条，**没列进的溢出条目不写标记**，
  下一封再带来（否则用户永远看不到它们，而我们以为通知过了）。
- **提醒**（worker 任务 `send-deadline-reminders`，每日调度）：对**已到档且该档未发过**的
  「征求意见中」条目发提醒（档位 d7 / d3，剩余天数由 `daysUntil` 按东八区日历算）。
  旧口径是「剩余天数正好等于 7 / 3」，配每日一轮调度就意味着**那天任务没跑成这一档就永久消失**
  （静默、无日志、事后不可察觉），issue #60 改为窗口 + 已发标记，漏的那天下一轮补发一次。
  补发的那一封在措辞上明写「原定提前 7 天，实际剩 5 天」，不冒充按点提醒。
  已过截止的条目一封都不发（库列 `status` 是抓取缓存，可能还写着 `open`，见 issue #43）。
- **匹配同源**（issue #60）：订阅页校验、截止提醒、新公示通知共用
  `matchesSubscriptionRules`（`src/lib/subscription.ts`）—— 分家的表现是
  「我明明订了却收不到」，不报错也没有日志。
- **去重**：`reminder_sends` 表以（条目 × 提醒档 d7/d3 × 订阅）为复合主键，
  同一条目同一档对同一订阅只发一次，任务重复运行不重发；单条失败不写标记、下一轮重试。
- **退订**：所有邮件底部带一键退订链接（`/unsubscribe?token=…`），点击立即
  生效，之后不再收到任何邮件。
- **改订阅要再确认一次**（issue #60 第 4 刀）：已确认的人再次提交，新规则先进
  `subscriptions.pending_rules_json`，**点确认之后才套用**——确认前站内仍按旧规则发信。
  这条修的是「知道某人邮箱就能静默改写其订阅」（FOLLOWUPS #52 挂账）：共享密钥模型下限流挡不住
  有意的重复提交，能挡住的是让每次改动都经过一次只有邮箱持有人能点的确认。
  邮件底部另有「查看或修改我的订阅」（`/subscribe?token=<退订 token>`，只读预填，
  无效 token 按普通订阅页渲染、不带出任何人的订阅内容）。
- **合规**：仅存储订阅邮箱，不建用户账号；确认 / 提醒邮件均可一键退订。

数据库迁移在应用首连时自动应用（`drizzle/<driver>/`）。

- **CI 现在不执行任何检查**（issue #70）：`.github/workflows/ci.yml` 配的是 lint 与 e2e 两个
  job，但触发条件是 `push` / `pull_request`，而 GitHub 账号自 2026-09-21 停用、提交推不出去
  ⇒ 这套 CI 从那天起一次都没跑过（**这是从"没有推送"推出来的，不是从 Actions 页面看到的**）。
  实际的门是**本地手动跑 + 在 commit message 里写清跑到了什么数**：`npx tsc --noEmit`、
  `npm run build`、`npm run lint`、`node --test tests/unit/**`、`npm run e2e`，
  外加 `node scripts/check-test-pins.mjs`（撤掉实现要真会红的自证清单）。
  恢复托管后第一件事就是把 CI 重新跑绿一次，别把"配置文件还在"当成"检查还在跑"。

- **手工补迁移时，`meta/_journal.json` 的 `when` 必须严格递增**（issue #66）：drizzle
  对**存量库**只执行 `when` 晚于「最后一条已应用记录」的迁移，写早了就**静默跳过** ——
  日志说「迁移已应用」、退出码 0，库里少一列。全新库一次全跑，所以本地测试看不见这条路径；
  守卫在 `tests/e2e/migrations-integrity.test.mjs`（结构：`when` 递增；行为：两阶段迁移
  复现「停在旧版」的库再向后跑），并已进 `check-test-pins`。

## RSS Feed（issue #6 建立，issue #63 起支持子 feed）

- **端点**（`GET /feed.xml`，或 `GET /feed.xml?category=…&open=1&since=7`）：RSS 2.0，
  每次请求实时读库生成（`force-dynamic`，
  不缓存），Content-Type `application/rss+xml; charset=utf-8`；XML 生成零依赖
  （转义 / 拼接逻辑见 `src/lib/feed.ts`）。
- **子 feed（issue #63）**：querystring 复用首页那套筛选参数与同一份 SQL 条件
  （`parseHomeQuery` + `filterConditions`），因此「页面上看到哪几条」与「订到的是哪几条」
  同口径。频道标题与描述在有条件时写明条件并指回全量地址，`atom:link rel="self"`
  带上条件（阅读器据此区分两份订阅）。首页仅在筛选生效时给「只订这一批（RSS）」入口。
  **刻意不吃 `sort` 与 `page`**：RSS 阅读器按 `pubDate` 自己排、feed 也没有分页，
  收下不生效的参数就是假旋钮；未知参数值不生效时频道标题也不加条件（标题不撒谎）。
- **channel**：标题「主人翁 —— 政府公示信息聚合」、站点链接、描述、语言
  `zh-cn`、`lastBuildDate` 与 `atom:link rel="self"`。
- **item**：全量条目按**发布日期倒序**、上限 200 条；`link` 为站内详情页
  **绝对 URL**，`guid isPermaLink="false"` 为条目 ID，`pubDate` 为 RFC 822，
  `description` 含发布机关、截止日期、官方原文链接与 AI 摘要片段
  （仅摘要就绪时出现，并显著标注「AI 生成，仅供参考，以官方原文为准」；
  特殊字符按 XML 转义）。
- **站点地址**：feed 内绝对 URL 的基础由 `SITE_URL` 提供（默认
  `http://localhost:3000`，取值口径见 `src/lib/site-url.ts`，robots / sitemap /
  canonical 共用）。它与 `APP_BASE_URL`（订阅邮件内链接的基础地址，
  issue #7）**各司其职**：前者面向 RSS 阅读器与站外引用，后者面向邮件接收者，
  两者部署形态不同（如邮件走独立发信域名）时可分别配置；默认值一致，本地
  开发无需设置。

## 可发现性（robots / sitemap / 页面元数据）

- **`GET /robots.txt`**：允许收录全部公示内容；屏蔽 `/admin`（站长看板）、
  `/go/`（302 跳转端点，收录只会给爬虫制造重定向噪音）、`/api/`（提交端点），
  并声明 sitemap 绝对地址。
- **`GET /sitemap.xml`**：首页 + 统计页 + **全部条目详情页**（`lastModified`
  取抓取时间）；已截止条目同样收录 —— 它们是有效的公示存档页。不含 `/go/`。
  两者都实时读取库与 `SITE_URL`（`force-dynamic`），收录量级为每月数十条。
- **页面元数据**：根布局设 `metadataBase`（= `SITE_URL`）与站点级 Open Graph；
  条目详情页各自生成 `title`（公示标题）、`description`（状态 · 截止日期 ·
  机关 + 正文首段）、`canonical` 与 `og:url` —— 转发到社交平台或出现在搜索
  结果里时，展示的是这条公示本身而不是站点通用标题。
- **图标与分享图**（issue #53）：`src/app/icon.svg`（浏览器标签页主源）、
  `src/app/favicon.ico`（16/32/48 三尺寸，`/favicon.ico` 此前 404 —— Next 不会把
  该地址映射到 `icon.svg`）、`src/app/apple-icon.png`（iOS 主屏）、
  `public/og-image.png`（1200×630 分享卡）、`src/app/manifest.ts` 与
  `viewport.themeColor`。**改设计就重跑** `node scripts/gen-brand-assets.mjs`
  （产物提交；脚本用仓库已有的 `next/og` 光栅化，无新增依赖、无构建期 wasm）。
- **分享图必须显式声明**：`OG_IMAGE`（`src/lib/page-metadata.ts`）要在每一处
  自定义了 `openGraph` 的页面里带上 —— **Next 的文件约定 `opengraph-image.tsx`
  产出的图会被页面自己的 `openGraph` 整块覆盖**，统计页与详情页曾因此完全没有
  分享图（e2e 的 `brand-assets` 场景钉住了这条）。
- **自定义 404**（`src/app/not-found.tsx`）：中文说明 + 站内检索 + 回列表入口
  （Next 默认 404 是英文且没有回站路径）。

## 前端呈现层（issue #53）

- **零客户端 JS 是设计前提**：全站 `'use client'` 计数为 0，所有交互经 URL 与
  服务端渲染（筛选是 GET 表单、翻页是链接、倒计时在渲染期算一次）。因此站点没有
  loading 态与防重复提交，倒计时是快照 —— 页面同时展示确切截止日期作为兜底。
- **样式**：单一 `src/app/globals.css`，设计令牌只有 5 个颜色变量；断点集中在文件
  末尾的「响应式」一节（`max-width: 560px` 详情字段单列、`max-width: 420px` 公示期
  分布换行、`pointer: coarse` 把触控目标提到 40px）。**触控目标只在手指设备上放大**，
  鼠标环境保持紧凑外观。
- **无障碍约定**：`layout.tsx` 输出跳转主内容链接，每个页面的 `<main>`（含后台的
  自包含文档）都带 `id="main-content"`；每页恰好一个 `h1`；禁用态分页带
  `aria-disabled`；表单错误横幅在页面级可见。新增页面时请照抄这三条。
- **页脚统一**：`src/app/_lib/site-footer.tsx` —— 免责声明 + 页内导航 + 备案号。
  备案号要**全站可见**（此前只有 3 个页面有，属合规缺口）；订阅入口与首页导航同门控
  （`mailerReady()`），邮件端口未配置时不渲染指向 `/subscribe` 的链接。
- **表单失败回填**（`src/lib/subscribe-draft.ts`）：校验失败时把已填内容放进短命
  HttpOnly cookie（120 秒、`Path=/subscribe`、不带 Secure —— 本地与 e2e 跑在 http 上），
  页面读它做默认值。**邮箱绝不进 URL**（地址栏、历史、访问日志与 Referer 都会留痕）。

## AI 摘要器（issue #4）

worker 注册表中的 `summarize-notices` 任务（`worker/jobs/summarize-notices.ts`）
对 `ai_summary_json` 为空、状态 `pending` 且**未截止**的条目调用 LLM 端口
（`LlmPort`，输入 = 公告正文 **+ 附件里抽出的草案条文**），输出**参与导引**结构化摘要
（这是什么 / 影响谁 / 谁能提 / 逾期会怎样 / **草案条文要点** / 截止日期 / 如何提意见 +
提交渠道清单），每段附**原文引用片段**，连同 `summary_model`
落库（`notices.ai_summary_json`，形状见 `src/lib/summary-content.ts`）。
条文要点只在**附件正文真的进了提示词**时才存在：抓取到的公告正文平均只有 443 字，
从壳里概括条文必然编造（issue #55/#56 因此删过这一段，issue #57 换了输入后重新启用）。
抽到的渠道**不在摘要卡里渲染**，而是并入页面上唯一的「意见提交方式」块（issue #56，见下）。
一条都取不到时该块不再留白，而是说明**为什么取不到**（正文没抓到 / 正文里没有可识别句式 /
渠道可能在附件里而附件可读、读不出或还没抽），判据是纯函数 `src/lib/channel-guidance.ts`，
仍然不编一条渠道、也不说「这条没写受理方式」（issue #64）。

- **条文输入的预算**（`src/lib/attachment-feed.ts`，由 `feedPlanForSummary()` 执行，
  `worker/jobs/summarize-notices.ts`）：每条公示最多 3 份附件、**按受众面分两档** ——
  标准档（行业专业）每份 8,000 字、合计 ≤ 12,000 个汉字；重档（公众广域）每份 16,000 字、
  合计 ≤ 24,000 个汉字，且每一份都有**保底份额**（标准 1,500 / 重档 4,000），
  装不下时不许把后面那份挤成几百字的残片（issue #86 第 3 刀）。
  截取是**结构感知**的（优先保留「第 X 条」锚点窗口，不是取前 N 字）；
  「全都装得下」时一份都不截。仍然只发一次 LLM 请求。
- **喂进去的那一截要落库**（`notices.summary_diagnostics_json.feed`，issue #86 第 3 刀）：
  每份附件的角色、原件汉字数、实际送进去的字符与汉字数、配额、是否被截，
  以及**一个字都没喂进去的那些**。此前这一截从来不落库，于是"模型没读到"与"我们没喂"
  在库里长得一模一样（#79 卡住的原因）。查法：`scripts/audit-draft-window.mjs <noticeId>`
  （它在生产容器里跑，判据与生产同一份实现）。
- **出处由程序反查，不由模型自报**（`buildQuotedSummary` 第三参）：每条要点的引用必须在本轮
  真正喂进去的条文里逐字找到（比对待空白，因为 PDF 抽取带换行），短于 8 字不算出处，
  **核对不上就丢弃这一条要点** —— 于是「页面上出现条文要点」的必要条件是附件正文进过提示词，
  与模型听不听话无关。反查到的附件名随要点落库，详情页每条要点下面写着「出处：附件《…》」。
- **「改了哪几处」这张表：行由程序定**（`src/lib/change-table.ts`，issue #86 第 2 刀 +
  第二十节第 3 小节）：按"数分母用的那一份正文"（全部附件正文 + 正文本身就是条文时的那一份）
  按中文句读切句，**每一句官方条目一行**；模型写出、且引用通过逐字反查的行照旧渲染，
  写不出的那一行只报事实（「本站检测到这一处改动表述，但没能给出可核对的说明」＋那一句原文），
  标题句（不含条款内容、下面挂着子条目）不单独成行。这样表的**结构**不再由模型决定 ——
  曾经同一份输入跑四遍列出 8 / 2 / 3 / 8 行，而读者看不出来（覆盖度那行只说"检测到 14 处、
  列出 2 处"，没有任何办法把缺的那些找出来）。数分母与造表**用同一个字符串**
  （`worker/jobs/summarize-notices.ts` 里同一个局部变量），两个数不可能分家；
  这一版之前落库的行没有 `changeTable` 键 ⇒ 页面退回"只列模型写出的行"。
  覆盖度那一句由 `changeTableNote` 写，页面与验收脚本 `scripts/show-notice-summary.mjs` 共用。
- **「可能的争议点」（L3 判读）**（issue #86 第 1 刀）：全站唯一一段**推断**内容，
  只给「公众广域」渲染、每条必须挂一句逐字原文（反查不到整条不落库、出处由程序算）、
  块级免责声明、一行都没有时整块不渲染。展示门控的判据在 `src/lib/impact-display.ts`
  —— 页面 `.tsx` 里的分支进不了自证框架（e2e 跑的是构建产物，撤源码不红）。
- **档位 `ATTACHMENT_TEXT`**（`src/lib/attachment-mode.ts`，缺省 `on`）：`off` 完全不跑；
  `shadow` 照常下载解析并写库出审计数、但摘要**不读**（页面一字不变，用于先验证成功面）；
  `on` 摘要读。三处缺省（代码 / `.env.example` / compose 回退值）必须同值，
  且 `shadow` 与 `on` 的产出差异由 `tests/e2e/summary-draft-input.test.mjs` 钉住 ——
  这一档曾经没有调用者，属于 issue #58 定性的「幽灵旋钮」，接线后才改回 `on`。

- **翻档位不影响存量**（issue #67）：入队条件是「摘要列为空」，所以 `shadow → on` 之后只有
  **新入库**条目会带上条文要点，已有的摘要一条都不会自动重跑（有意为之：不覆盖人工复核过的
  结果，也不会每天重烧一遍调用）。要让存量也补上得显式置换 ——
  `scripts/reset-summaries-for-redraft.mjs`（默认只读列名单，`--apply --limit 3` 是金丝雀，
  `--all` 要显式写；清空前把旧摘要**连模型名**一起备份，判据复用 `draftSourcesForSummary()`
  所以"会不会喂进条文"与真跑时同源；已经带出可核对要点的条目自动跳过，工具因此可重复跑）。
  2026-09-24 用它置换了 49 条，过程与两处坑记在 `docs/pending-issues/67-summaries-redraft.md`。

- **失败策略**：单条条目失败后重试 `SUMMARY_MAX_RETRIES` 次（默认 3，指数退避），
  仍失败置 `summary_status=failed_review` 转人工复核，worker 不再自动重试；
  已截止条目不生成摘要。
- **详情页**（`src/app/_lib/summary-view.tsx`，判据在 `src/lib/summary-display.ts`）：五分支
  优先级固定（issue #58）—— 库里已有摘要**永远照常渲染**（参与导引卡片 + 显著
  「AI 生成，仅供参考，以官方原文为准」标注 + 各段引用块，点击跳官方原文；空段整段不出现，
  issue #55 线上真有一条空的「影响谁」）→ LLM 端口不可用 → 「暂未启用」→ `failed_review` →
  「摘要生成中（待人工复核）」→ **已截止且 pending → 「未生成摘要」**（入队条件永不放行，
  说「生成中」是承诺一件不会发生的事；线上 108 条曾长期挂着这句）→ 其余 → 「摘要生成中」。
- **渠道只有一个渲染位置**（issue #56）：`mergeSubmissionChannels`（`src/lib/notice-brief.ts`）
  把程序逐字抽取的渠道当权威源，摘要抽到的按值判重后追加，并逐行标「摘要补充」——
  两块各列一份的结果是同一个邮箱一屏出现两遍、且第二份出处更弱。可点链接保守：
  整段是干净邮箱/纯号码/域名才给 `mailto:` `tel:` `https:`，值里混了说明文字就退回纯文本
  （假可点击比不可点击更坏）。
- **服务商切换**：`LLM_PROVIDER=stub`（默认，测试永远走 stub）或 `glm`（生产，
  智谱开放平台 OpenAI 兼容端点，`GLM_API_KEY` / `GLM_API_BASE` / `GLM_MODEL`
  配置，模型被要求只输出 JSON，解析做防御性校验）。本地不配 Key 联调 GLM 适配器
  的行为可参考 stub 的失败注入（`LLM_STUB_FAILURES`）。

## 站内全文检索（issue #8）

- **可插拔检索后端**（ADR-0001 第 2 条）：`src/lib/ports.ts` 的 `SearchPort`
  （`index` / `remove` / `search`），经 `createSearchPort()` 按 `SEARCH_PROVIDER`
  创建；worker 钩子与搜索页只依赖接口，不感知具体后端。
- **索引字段**：标题、AI 摘要各段 text 拼接（原文引用 quote **不入索引**）、
  正文纯文本（`src/lib/search/search-text.ts` 统一构建，本地与 Meilisearch
  两个后端共用同一文档形状）。
- **本地实现（默认 `SEARCH_PROVIDER=local`，开发 / 测试零外部依赖）**：
  SQLite 方言走迁移 0004 建立的 FTS5 虚表 `notices_fts`。unicode61 分词器对
  连续汉字只建一个长词、无法子串命中，故索引写入前在相邻汉字之间插空格、
  查询把中文片段还原为同规则短语 —— 短语相邻性等价原文本连续子串（中文按
  子串语义命中任意长关键词），英文 / 数字走前缀匹配；结果按 BM25 相关性排序，
  索引孤儿行与 `notices` 表联查兜底。PostgreSQL 方言不建本地索引结构，检索
  退化为对 `notices` 的 ILIKE（应用层按同一字段语义复核候选行）。
- **Meilisearch 适配器（`SEARCH_PROVIDER=meilisearch`，生产）**：原生 fetch
  直连 REST API（零新增依赖），首次使用自动建索引（`primaryKey=id`，重复
  写入幂等更新）并设置可搜索属性（title > summary > body）；异步索引任务
  轮询等待至成功，失败 / 超时抛出带详情的异常，由调用方决定降级。配置
  `MEILI_HOST` / `MEILI_API_KEY`（兼容 docker-compose 的 `MEILI_URL` /
  `MEILI_MASTER_KEY`）。开发机没有 Docker / Meilisearch，本适配器不做本地
  集成验证，生产部署阶段联调（ADR-0001 已知风险）。
- **索引同步（双层）**：抓取任务在每源入库 / 更新后、摘要任务在摘要落库后
  **即时同步受影响条目**（失败仅记日志降级，不打断主管线）；worker 注册表
  末位的 `reindex-notices` 任务每轮**全量重刷**兜底。一次性全量重建入口：
  `node scripts/reindex-search.mjs`（更换检索后端 / 手动修复索引用）。
- **搜索 UI**：列表页头部搜索框（GET 表单提交 `/search?q=…`，零客户端 JS）
  + `/search` 结果页；结果项复用列表条目展示（状态徽标 / 截止倒计时 /
  发布机关 / 发布与截止日期），按相关度排序；空结果给友好提示，`q` 为空
  重定向回列表页，检索后端故障渲染错误态而非 500。

## 领域分类浏览与筛选（issue #9）

- **领域标签体系**（`src/lib/categories.ts`，单一词表）：首批 10 个领域
  （立法与司法 / 经济与产业 / 科技与互联网 / 教育与科研 / 医疗卫生 /
  生态环境 / 交通运输 / 市场监管 / 社会保障 / 数据与网络安全），每个领域
  一组关键词，命中条目标题或正文即打上该领域标签；多领域同时命中则多标签，
  无任何命中则不打标签（不设「其他」兜底，未打标条目仍出现在未筛选列表、
  检索与 RSS 中）。词表刻意避开「司法部」「邮政编码」「科技与法制司」这类
  机关名 / 高频泛词（详见该文件模块注释），宁缺勿滥；词表避不开的机关名与
  专有名词由**排除语境**兜底（`KEYWORD_CONTEXT_EXCLUSIONS`：真实数据里
  「国家法律法规数据库」的「数据」、「工业和信息化部」的「信息化」都不算
  命中，裸词仍命中）。法案 / 条例草案按「草案」标记进「立法与司法」。
- **单一打标入口**：`upsertNotice` 在调用方未提供 `categoryTags` 时按关键词
  规则自动打标（更新路径同样按最新标题 / 正文重算）——抓取管线与后台手动
  补录（issue #12）共用该入口，任何写入方零改动即获得打标；适配器可经
  `NormalizedNotice.categoryTags` 直接给出权威领域（优先采用，关键词规则
  兜底）。订阅领域选项（issue #7 的 `CATEGORY_OPTIONS`）改为引用同一词表，
  条目标签与订阅领域永不漂移。
- **列表页筛选条**（首页，纯 URL 驱动、零客户端 JS）：
  - **领域标签云**：10 领域链接 + 「全部领域」，激活态高亮（`aria-current`），
    切换领域时保留机关 / 关键词筛选；
  - **发布机关下拉**：选项来自库内去重机关（`listNoticeAgencies`），精确
    匹配（「司法部」≠「司法部立法一局」）；
  - **关键词框**：标题 / 正文包含匹配（不区分大小写），与站内检索（FTS
    相关性排序）互不影响——筛选框在首页按倒计时顺序过滤，搜索页按相关度；
  - 三维度可任意组合且全部落在 querystring（`/?category=…&agency=…&q=…`），
    可直接分享；结果计数与当前筛选摘要随页展示；无结果渲染空态并提供
    「清除全部筛选」入口；未知领域参数不生效（避免任意串触发无效筛选）。
- **排序与收录范围（issue #62）**：筛选条上方一排普通链接给四个排序档
  （`?sort=deadline|published|newest|clicks`，默认档不写进链接）与两个范围维度
  （`?open=1` 只看未截止、`?since=N` 最近 N 天收录），以及来源下拉 `?source=`（issue #65）。三条口径值得记：
  `?open=1` 按**展示口径**判（库里 `status` 是抓取时的缓存，刚过截止的条目仍写 `open`，
  见 issue #43）；`?since=` 用 `first_seen_at` 而不是每天被覆盖的 `fetched_at`；
  越界的 `since` **不生效而不是夹取**（夹窄会少给条目且看不出来）。排序不进 `hasFilter`
  （结果集合没变，不该因此多出一批 noindex 变体），另两个维度进。档位清单在
  `src/lib/notice-sort.ts`、时间窗口在 `src/lib/notice-recency.ts`，SQL 实现在
  `src/db/repo/notices.ts` 的 `ORDERS`（`Record<NoticeSortKey, SQL[]>`，少一档编译不过）。
- **与倒计时排序叠加**：不带 `?sort=` 时筛选只过滤行、不改变排序——过滤结果始终是未筛选
  列表（征求意见中在前、截止日期升序）的同序子序列；这一条从 issue #9 起保持不变。
  每一档排序的末位都强制唯一键 `asc(id)`（issue #54：排序不唯一时 `LIMIT/OFFSET`
  会在页边界重复一行、挤掉另一行）。仓库层新增
  `listNoticesFiltered` / `listNoticeAgencies`（`src/db/repo/notices.ts`），
  排序表达式与 `listNotices` 共用同一常量；不改动既有查询函数语义。
- **单元**：`tests/unit/categories.test.mjs` —— 规则表逐条钉死：关键词命中标题 /
  正文、两种排除语境（专有名词「数据库」与机关名「工业和信息化部」）、无兜底标签、
  词表自洽（标签唯一、取值校验）。
- **E2E**：`tests/e2e/category-filter.test.mjs` —— 三源 fixture 入库后逐条
  断言标签（覆盖关键词命中标题与命中正文两类、排除语境两条），领域 / 机关 /
  关键词 / 组合过滤、无结果空态与排序子序列断言。

## AI 摘要区的可用性门控（issue #22）

与订阅入口门控（issue #17）同一个问题、同一个解法：**未配置的能力不该对外表现为
「正在进行」**。生产上线时 `LLM_PROVIDER=glm` 但 `GLM_API_KEY` 未配置，摘要任务每轮
构造端口即失败，库里的摘要状态永远停在 `pending` —— 详情页因此**永远显示
「摘要生成中」**，承诺一件不会发生的事。

判定在 `src/lib/llm-availability.ts`（口径与 `glm-llm.ts` 的构造校验一致：glm 端口
缺 API Key 即不可用），三处生效：

- **详情页摘要区**：已有摘要照常渲染（**绝不隐藏库内已有内容**，含重刷期间仍是旧五段式的行）；未生成时按
  端口可用性二选一 —— 可用 → 「生成中」占位（进行时状态是可信的），不可用 →
  「暂未启用」说明块（`data-testid="summary-unavailable"`，如实说明并把人引向官方原文）；
- **worker 摘要任务**：端口未配置时**整轮跳过**并说明原因，不再表现为
  「任务 summarize-notices 失败」—— 此前每轮一条失败日志，配置了 `ALERT_EMAIL`
  时还会每天一封任务级告警邮件，而这件事并不会因为重试而好转；
- 配置补齐后无需改代码：`GLM_API_KEY` 一填，占位与说明块自动回到正常形态。

- **E2E**：`tests/e2e/summary-availability.test.mjs` —— 两阶段用同一个库（先 stub 生成
  摘要，再切成「glm 缺 key」）：不可用时未生成摘要的条目显示说明块而非占位、已有摘要
  照常渲染、worker 跳过而非失败、切回可用后占位回归。

## 发布机关：归一与多发布机关匹配（issue #21）

`agency` 是**忠实于源站的显示值**（适配器取标题前缀或栏目常量），所以同一机关会有多种
写法、联合发文是一个复合串。源扩到 8 个后生产库 150 条出现了 **18 种机关写法**，其中
三类是真问题（都是实测出来的，不是假设）：

- **同一机关两种写法**：交通运输部栏目里「中国民用航空局关于《民用航空空中交通管理
  规则》…」与「中国民航局关于《运输机场运营许可规定》…」——同一主办机关的两条公告；
- **联合发文无法按参与机关检索**：「司法部、中国人民银行、金融监管总局、中国证监会、
  国家外汇局」——选「司法部」看不到它，选「中国人民银行」连选项都没有；
- **同一栏目两种机关名**：生态环境部栏目的 xxgk 模板带「发布机关」字段（生态环境部
  办公厅，29 条），hdjl 模板没有该字段、取适配器常量（生态环境部，1 条）。

做法（`src/lib/agencies.ts` + `notices.agency_keys`，迁移 0008）：

- `canonicalAgency`：**别名表**把已知的同一机关写法收敛到规范名（目前只有实测到的那
  一对，不做猜测性归一）；
- `splitAgencies` / `leadAgencyOf`：复合串按顿号 / 空白拆成参与机关集合与牵头机关；
- `agencyKeysOf`：参与集合的**竖线包夹串**（`|司法部|中国人民银行|`）入库到
  `agency_keys`，让「按任一参与机关筛选」用一条 `LIKE '%|X|%'` 精确表达
  （与 `category_tags_json` 的筛选同一套路数）。竖线包夹同时避免子串误命中
  —— 查「司法部」不会命中「司法部办公厅」。
- **`agency` 列本身不变**：详情页、feed、列表展示的仍是源站原样的机关文本，
  联合发文照样完整显示五个机关；变的只是「可被哪些机关筛到」与统计口径。
- **筛选**（`listNoticesFiltered`）：`agency = X` **或** `agency_keys LIKE '%|X|%'`
  —— 旧行（迁移后尚未重抓，`agency_keys` 为空）仍按原值精确匹配，向后兼容。
- **机关下拉**（`listNoticeAgencies`）：列的是**参与机关**，不再是复合串 —— 联合发文的
  每个参与机关都能单独选中（下拉里从 18 个选项变成 7 个可选项 + 更短的文本）。
- **统计口径**（`getAgencyTotals` / `getAgencyMonthlyCounts`）：按**牵头机关**归并，
  联合发文归到第一个机关名下，**每条只计一次**（各部门合计 = 条目总数，不重复计数）。
  刻意**不做**内设机构向部本级的折叠：「市场监管总局特种设备局」「生态环境部办公厅」
  是源站自己署的发文机关，是真实信息。

- **单元**：`tests/unit/agencies.test.mjs` —— 别名收敛、复合串拆分（顿号 / 空白 / 混用 /
  去重保序）、牵头机关、竖线包夹串（含「司法部」不命中「司法部办公厅」的反向断言）。
- **E2E**：`tests/e2e/category-filter.test.mjs` —— 任一参与机关（中国人民银行 /
  金融监管总局 / 中国证监会 / 国家外汇局）都能筛到联合发文、复合串原值仍精确命中、
  生态环境部栏目三套模板机关名统一；`tests/e2e/stats.test.mjs` —— 各部门公示量按
  牵头机关归并且合计等于条目总数。

## 首页分页与真实合计（issue #19）

源扩到 7 个后库内超过 50 条，暴露了列表页的两个缺陷：**硬编码 50 条上限且无翻页**
（其余条目从首页不可达），以及「共 N 条」显示的是**本页条数**而非全量（假合计）。

- **合计取真实总数**：仓库层新增 `countNoticesFiltered`（`src/db/repo/notices.ts`），
  与 `listNoticesFiltered` 共用同一组 `filterConditions` —— 两处 WHERE 必须一致，
  否则合计与实际能翻到的行数会打架。`count(*)` 在双方言下返回类型不同
  （PostgreSQL 的 bigint 走字符串），统一 `Number()`。
- **分页**：`limit` + `offset`（排序由 `AGGREGATION_ORDER` 决定，是确定性的，
  故 offset 分页不重复不漏行）；每页条数由 `LIST_PAGE_SIZE` 控制（默认 50）。
  页码参数非法 / 越界一律夹到有效范围（`?page=999` 落到末页而不是空页）。
- **链接**：翻页与筛选都是普通链接，保留全部筛选条件；**切换筛选时页码归 1**
  （筛选链接不写 `page`）；单页结果不渲染分页控件。
- **E2E**：`tests/e2e/pagination.test.mjs` —— 用 `LIST_PAGE_SIZE=3` 把三源 fixture
  的 9 条切成 3 页：合计是真实总数、逐页翻完等于全量且无重复、顺序与未筛选的
  倒计时顺序一致、筛选后合计与总页数按筛选结果算、越界与非法页码夹到有效范围。

## 版本历史与条款对比（issue #10）

- **版本链**（`notices` 自引用两列，迁移 0005 双方言）：`version_of` 指向
  **上一轮**条目 id，`version_seq` 为轮次序号（1 = 首轮公示）；首版 /
  未关联条目 `version_of` 为空。选直接前驱指向而非链根指向：对比上一版
  只需一次主键查询。
- **关联规则**：标题规范化键（去空白与标点、取书名号内法案主体、去含轮次词
  的括号段与征求意见套语，见 `src/lib/versions.ts`）+ **同一发布机关**。
  抓取管线幂等入库（`upsertNotice`）时自动触发，任何写入方无需感知。
- **整链重算**（`src/db/repo/versions.ts`）：每有条目入库 / 更新，同分组的
  全部条目按发布日期升序重新编号（缺失沉底、同日按 id 兜底）—— 任意顺序
  入库（先抓到第二轮、后抓到首轮）都收敛到正确链序，重算幂等（值不变不写
  库），标题 / 机关变化离开旧分组时旧链自动缝合。
- **对比视图**（`/notices/[id]/diff`）：详情页对存在上一版的条目展示轮次
  提示与「对比上一版」入口；对比页显著提示「这是第 N 轮征求意见稿，与上一轮
  （日期）对比」，正文按条款（章 / 条 / 款项归属 / 段落）切分后呈现
  新增 / 删除 / 修改三态高亮，修改行再标行内删除 / 新增片段
  （`src/lib/notice-diff.ts`：零依赖自实现 —— LCS 锚定 + 同编号 / 相似度
  配对 + 字符级片段，无分词器依赖）。无上一版的条目访问对比视图给出友好
  空态；差异为自动比对，页面注明以官方原文为准。
- **检索一致性**：版本链不改变索引字段（标题 / 摘要 / 正文），issue #8 的
  索引同步钩子无需调整；两条目成为版本链不影响其各自的检索命中。
- **生产实况（issue #35 审计，2026-09-21）**：全库 178 条里 `version_of` 非空的
  为 **0 条** —— 这不是关联失效，而是收录窗口（约 9 个月）内确实不存在同案多轮公示：
  按「标题规范化键 × 机关」分组 177 个组全部是单成员，用更松的「法案名」（标题里
  最长的《…》，去括号段与标点）分组也**没有任何组有第二个成员**。审计脚本
  `scripts/audit-versions.mjs`（只读，可重跑）会同时报告脏链（version_of 指向
  非同组条目），当前为 0。

## 数据质量审计脚本（只读，生产容器里跑）

规则类改动（正则、词表、抽取器）合并前先跑一遍，前后 diff 就是回归证据；
新增的抽取逻辑也应顺手补一个审计脚本，让「线上到底有多少条命中」有据可查。

| 脚本 | 查什么 | 用法 |
| --- | --- | --- |
| `scripts/audit-briefs.mjs` | 结构化速读：各源渠道命中率、在线渠道域名分布（噪声检测） | `docker compose run --rm -v /tmp/x.mjs:/app/scripts/x.mjs worker node scripts/x.mjs --samples 6` |
| `scripts/audit-versions.mjs` | 版本链：分组数、应链未链的候选、脏链 | 同上（换成该脚本名） |
| `scripts/audit-attachments.mjs` | 附件链接有效性：逐个 HEAD/Range-GET 探测，按状态码与源汇总 | 同上（约 340 个 URL × 250ms，需要几分钟） |
| `scripts/audit-attachment-shape.mjs` | 附件数据形状：名字质量、魔数校验（是不是网页伪装成附件）、重复 URL | 同上 |

**必须挂到 `/app/scripts/` 下**（挂 `/tmp` 会 `ERR_MODULE_NOT_FOUND: pg`）。
附件有效性审计的 2026-09-21 基线：340 个引用中 309 个 2xx、31 个 403 ——
全部来自工信部，文件挂在对非白名单客户端一律拦的 `jyhwzhq.miit.gov.cn`
（连根路径都 403），而官方页面链接的就是同一批 URL；我们**不隐藏**这些链接
（用户浏览器未必同样被拦），但在附件块里给出「回官方原文页获取」的出路。

## 数据统计页（issue #11）

- **页面**（`GET /stats`，列表页头部「数据统计」入口）：服务端实时渲染
  （`force-dynamic`，零客户端 JS）。
- **部门公示量趋势**：各发布机关公示量（`GROUP BY agency`）+ 最近 6 个
  日历月趋势矩阵（机关 × 月，含行小计与全部机关合计行）。月份取自 ISO
  日期字符串截取 `substr(published_at, 1, 7)`（SQLite / PostgreSQL 交集
  子集，不用方言专属日期函数），窗口裁剪与补零在应用层完成。
- **公示期长度分布**：截止日期 - 发布日期的天数按 ≤7 / 8-15 / 16-30 / >30
  天分桶（条形图纯 CSS）。双方言交集内无可移植的天数差 SQL 函数，天数差
  在应用层按日历日计算；缺失发布或截止日期的条目不参与分布。
- **出站提意点击聚合（北极星指标）**：概览累计点击 + 条目点击 Top 10
  （每项链接回站内详情页）+ 按日期聚合。点击写入两条腿：既有
  `notices.outbound_clicks` 总计数（issue #5）+ `outbound_click_daily`
  按（条目 × 本地日历日）聚合表（迁移 0005，复合主键 upsert 幂等），
  按日期聚合即对该表 `GROUP BY click_date` 求和。
- **各来源收录量（issue #65）**：按 `notices.source_id` 聚合的收录量、未截止量与
  **最近一次新收录**（`max(first_seen_at)`），两格数字可钻取（`/?source=…`、
  `/?source=…&open=1`），条数与表格一致（issue #36 的不变式）。「未截止」与首页
  `?open=1` 共用同一份 SQL 判据（`openCondition()`），两处绝不允许分家。
  这一列存在的理由是**源健康看板看不见的那类故障**：一个源可以天天抓取成功、
  看板全绿，却连续几周一条新的都不送（改版 / 换址 / 选择器失效）——
  停在两周以前的那一行就是它。登记表里零收录的源也照列（被聚合结果挤掉的
  正是要看的那行）；条目引用了已注销的源时标「未在源登记表」，不静默归并。
- **隐私边界**：点击数据只有条目 ID 与日期两个维度，纯计数聚合，
  无 IP、无 Cookie、无账号（`/go` 端点保持不变）。

## 管理后台与健康告警（issue #12）

### 访问保护（`/admin`）

- 共享密钥 = 环境变量 `ADMIN_TOKEN`，**未配置时所有 `/admin*` 请求一律 401**
  配置指引页。配置后两种放行方式：登录表单（`POST /admin/login`，令牌正确则
  303 回 `/admin` 并下发 HttpOnly + Secure + SameSite=Lax 会话 Cookie，7 天有效）
  或 `?token=` **换取**会话（见下）；`POST /admin/logout` 退出。
- **`?token=` 只换取会话，不再直接放行**（issue #52）：带 token 的 GET 会下发会话
  Cookie 并 303 到去掉 token 的同地址 —— 共享密钥因此不会留在浏览器历史 / 书签 /
  分享出去的链接里（它没有独立吊销手段，改 `ADMIN_TOKEN` 才能作废）。**写操作一律
  只看 Cookie**，URL 里的凭据不能触发写动作。脚本 / curl 用法（两行）：
  ```bash
  # 1) 换取会话（-c 保存 Cookie）
  curl -s -c /tmp/zw-jar "https://cn101.top/admin?token=$ADMIN_TOKEN" -o /dev/null
  # 2) 用会话读看板 / 发写操作
  curl -s -b /tmp/zw-jar https://cn101.top/admin | head
  curl -s -b /tmp/zw-jar -X POST https://cn101.top/admin/sources -d 'id=moj&action=disable'
  ```
- 登录限流（issue #52）：按客户端 IP 的固定窗口（`ADMIN_LOGIN_RATE_LIMIT_PER_HOUR`，
  缺省 30 次/小时），超限回 429 且文案与「令牌不匹配」区分开。
- 令牌比较为常量时间（双方各做 SHA-256 后 `timingSafeEqual`）；后台为自包含
  HTML + 表单 POST（零客户端 JS、零认证依赖），写操作未授权一律 401。

### 三个功能

- **源健康看板**：每个抓取源一行 —— 健康 / 异常、**连续失败轮数**、启用 / 停用、最近成功抓取
  时间、当前错误信息与时间。两根正交的判据都在 `src/lib/source-health.ts`：一轮内过半条目
  失败即降级（issue #51，当场判红），跨轮连续失败满 2 轮才判红（issue #58，抖动不再让看板
  每天红一次）。「连续失败」这一列是降噪的补偿 —— 首轮失败不发信，但必须看得见。
  错误列只描述**当前**故障态（成功即清空，issue #58 的口径变更）：曾停摆的历史在每轮日志与
  告警邮件里，第二封邮件还明确带着上一轮的原始错误。
  启停开关（`POST /admin/sources`）即时生效：抓取任务整轮跳过停用源。
- **摘要人工复核队列**：`summary_status='failed_review'` 的条目两种处置 ——
  「重置并重试」清空摘要列并置回 pending（摘要任务下一轮自动重新生成）；或
  直接编辑参与导引各段与渠道清单保存为 done（`summary_model=manual`，详情页立即展示
  并同步检索索引）。
- **手动补录**：结构化表单（标题 / 发布机关 / 原文 URL / 发布与截止日期 /
  正文纯文本）→ 与爬虫完全相同的管线：以原文 URL 为唯一键幂等 upsert
  （条目 id 同为 URL 的 SHA-256 前缀）、状态推导一致、入库即同步检索索引、
  摘要列保持 pending 由摘要任务自动生成 AI 摘要。条目登记在专用源
  「manual（人工补录）」下，看板可见。

### 失败邮件告警

- 三类失败发告警到 `ALERT_EMAIL`（未配置则整体跳过）：源抓取失败（按源）、
  条目摘要重试耗尽转人工复核（按条目所属源）、任务级整任务抛错（源显示 `—`）。
  邮件含任务名、源、发生时间与错误摘要（600 字截断）。
- **去重落表**：`alert_sends` 按（本地日历日 × 任务名 × 源）复合主键 ——
  同一天同一源同一任务类型只发一封，worker 重启后依然有效；邮件发送失败不落
  去重标记，下一轮任务再失败时重试发送。
- **抓取类告警按轮次降噪**（issue #58）：日历日去重管不住「每日一轮的偶发超时」——
  它会每天红一次、每天一封，直到永远。于是发信前先过轮次门槛：连续失败第 1 轮**只记录
  不发信**（看板有「连续失败 1 轮」），满 2 轮必发（真出事最坏晚一天），此后每 7 轮重发
  一次封顶；数据质量降级（一轮内过半条目失败）不等门槛、当场发；恢复不发信。
  判据在 `shouldAlertForSourceFailure`，任务级与摘要类告警不受该门槛影响。

## 接入的源（issue #14 三源 + issue #18 扩至七源 + issue #28 第九源 + issue #29 第十源，均对着活站校准）

| 源 ID | 栏目与真实列表地址 | 传输处置 | 列表 / 详情结构要点 |
| --- | --- | --- | --- |
| `npc` | 全国人大网「法律草案征求意见」<br>`http://www.npc.gov.cn/flcaw/flca-list?flag=0&type=0&page=1&per_page=100` | **只能用 http**：`www.npc.gov.cn` 的 HTTPS 在 TLS 握手阶段即被拒（`sslv3 alert handshake failure`；换 TLS1.2 / 降 SECLEVEL / `--insecure` 均无效，**不是证书链问题**）。风险：明文传输；缓解：只读官方公开信息、不带凭据、不基于该内容做任何鉴权或写操作。**注意附件也走 http**（issue #86 第十八节起，`NPC_DRAFT_ATTACHMENTS=on` 时会下草案 PDF）：站点对浏览器也只提供 http 入口，我们不额外降低标准；正文入库后按内容哈希缓存（同一份不再重下）。**另声明按源超时 30s**（`fetch.timeoutMs`，issue #58：该接口实测偶发超过全局 15s，抬全局值会让九个源为最慢那一个买单）**与按源附件预算 64 MB / 120 秒**（`fetch.attachmentBudget`：实测那条 43,254,307 字节的草案，下载 43.5 秒 —— 全局的 4 MB / 15 秒两处都会把它挡在门外） | 列表与正文都是 JSON 接口（页面为前端渲染）；正文取自 `/flcaw/flca/<id>/info/`，用户可见链接仍是 `userIndex.html?lid=<id>`；接口不提供发布机关；**附件在 `/flcaw/flca/<id>/fjxx/`**（600 字节 JSON，只取 `fileName`；同 JSON 里的 `path` 实测 404），文件本体是 `/flcaw/flca/<id>/attachment.pdf` —— 开关关着时一个请求都不发 |
| `moj` | 司法部「立法意见征集」<br>`https://www.moj.gov.cn/pub/sfbgw/lfyjzj/lflfyjzj/` | **WAF cookie 挑战**：首包 302 + `Set-Cookie`（CT6T/CT6TS）且 Location 指回同一地址，需带 cookie 重放一次才 200（抓取层 `fetch.cookieChallenge`，仅本源生效） | 列表 `ul.newsMsgList_zzy > li`（标题被截断，完整标题取自详情 `h1`）；发布日期在 `.sT`；截止日期只在正文句「征求意见时间为 X 至 Y」；机关取自标题前缀（详情页无发布机关行） |
| `mee` | 生态环境部「意见征集」<br>`https://www.mee.gov.cn/hdjl/yjzj/` | 无特殊要求（爬虫 UA 直接 200） | 列表 `li > a + span.date`，链接混用栏目内相对路径与 `../../xxgk2018/…` 跨目录相对路径；详情两套模板（栏目内页 `h2.neiright_Title`，政府信息公开页 `h1` + 「发布机关」字段）；截止日期在正文句；附件是正文内的相对 `.pdf` 链接 |
| `mot` | 交通运输部「意见征集」<br>`https://www.mot.gov.cn/hudong/yijianzhengji/index.html` | 无特殊要求（静态 HTML） | 列表 `ul.news-list li.news-item > a.news-link`，状态标注 `[进行中]/[已结束]` 是真实列表判据（状态位为空的是混入的答记者问 / 反馈情况，被过滤）；条目链接跨域混排（民航局 / 铁路局站点，其详情页不属本源模板 → 保留列表层字段）；截止日期在详情正文「意见反馈截止日期为…」 |
| `samr` | 市场监管总局「征集调查」<br>`https://www.samr.gov.cn/hd/zjdc/` | 无特殊要求；列表是站内 TRS jpaas 接口<br>`/api-gateway/jpaas-publish-server/front/page/build/unit`（GET + queryData，返回 `{data:{html}}` 片段） | 列表行自带**征集期**（`2026-09-17至2026-10-17`）与状态列 —— 起作发布日期、止作截止日期（多数详情正文没有截止句）；正文 `.Three_xilan_07`；附件不在正文里，在「附件下载」清单 `ul.contentLeft0102box`（该 class 出现两次，前一个是空占位） |
| `miit` | 工业和信息化部「意见征集」<br>`https://www.miit.gov.cn/gzcy/yjzj/` | 无特殊要求；列表同上 TRS jpaas 接口（参数不同） | 截止日期在列表隐藏字段 `span.endtime` 的**毫秒时间戳**（与详情正文「请于…前反馈意见」互为印证）；正文 `#con_con`；附件是正文内的 pdf 链接；标题多为「关于公开征求…的公示」，机关兜底为部本级 |
| `moe` | 教育部「征求意见」<br>`http://www.moe.gov.cn/jyb_xwfb/s248/` | 无特殊要求（静态 HTML） | 列表 `#list li`，**标题必须取 `title` 属性**（联合发布条目的链接文本被截断）；状态标注在标题前缀；正文 `.moe-detail-box .TRS_Editor`（页面尾部的 `#detail-editor` 只是「责任编辑」一行，不是正文）。**该栏目自 2024-02 起未再更新**（历史归档，52 条全部已截止），接入理由见适配器文件头 |
| `ndrc` | 国家发展改革委「意见征求」<br>`https://www.ndrc.gov.cn/hdjl/yjzq/` | 无特殊要求；**正文需链式跳转**（见下方「链式跳转」） | 列表 `ul.u-list > li > a[title] + span`，标题带 `【进行中】` 前缀 / `[已结束]` 后缀（两种都剥离）；条目链接是数据服务域名下的前端渲染页 `sa.html#/<shortKey>`；正文与截止日期（「此次公开征求意见的时间为 X 至 Y」）都在 `getArticleDetail` 接口返回的 `articleContent` 里，附件是正文 HTML 内的绝对链接；接口返回的标题含 `<BR>` 换行标签，入库前剥掉 |
| `mohurd` | 住房城乡建设部「征求意见」<br>`https://www.mohurd.gov.cn/gongkai/fdzdgknr/zqyj/index.html` | 无特殊要求（爬虫 UA 直接 200）；列表是站内 TRS jpaas 接口（与 samr / miit 同族，参数不同）。**中文查询参数必须用 UTF-8 百分号编码**——Windows 上用 `curl --data-urlencode "tagId=内容1"` 会编成 GBK，接口匹配不到 tag 就返回 `success:false`，曾被误判成站点加了「授权读取」校验（详见适配器文件头） | 列表行 `li.long-deta` **直接带截止日期**（`span.date-info`「截止日期 X」），本源没有状态列也没有发布日期列（发布日期由详情 `meta PubDate` 补）；正文 `.editor-content`；附件在 `.editorContent-download`，链接是下载接口 `/document/download?fileUrl=…`**没有扩展名**，故按容器 + 路径收集而非按扩展名。**只取接口第 1 页（20 条）**：分页参数只在前端脚本里消费（`pageNo`/`page`/`limit` 回传均被忽略），而列表按截止日期降序 → 新条目截止日必然更大、永远落在第 1 页顶部，掉出第 1 页的都是已入库的旧条目 |
| `cac` | 国家网信办「网信@你」<br>`https://www.cac.gov.cn/hdfw/wxan/A093802index_1.htm` | 无特殊要求（爬虫 UA 直接 200，静态 HTML） | 栏目**不在首页导航里**（挂在「互动服务 → 网信@你」，首页那栏只是 3 条切片），单页 20 条、无第二页（`…index_2.htm` 404），覆盖最近约 9 个月。列表 `#loadingInfoPage li`（标题取 `title` 属性），**没有截止日期也没有状态列** —— 两者都从详情正文抽；详情 `h1.title` / `#pubtime`（带时分的「2026年09月18日 17:00」）/ 正文 `#BodyLabel`（尾部内联 `pagestat` 脚本由 blockText 剔除）；附件是 `downloadfile.jsp?filepath=…&fText=…`**无扩展名**下载接口（名字取 `fText`）。**栏目混排通知公告**（实测 20 条里 8 条是征求意见），适配器按标题 `征求…意见` 过滤，否则招聘公告、结果公示会混进来 |
第三源为何不是中国政府网：原 `govcn`（中国政府网「政策 → 意见征集」）实测**已下线**
（`/zhengce/yjzj/**` 全 404；政策频道仅剩最新政策 / 国务院公报 / 政策解读 / 图解政策，
政策文件库路径对爬虫一律 403）。本产品承诺「聚合征求意见稿 + 截止提醒」，故换用真实
在运营、可抓取且含截止日期的部委征求意见栏目（issue #14）。

PRD M2 的「部委直爬源扩展至 8 个」**已达成**；issue #28 补上住房城乡建设部、
issue #29 补上国家网信办（PRD M1 源清单点名的最后两个），现共 **10 个源**。

国家网信办的接入留档（issue #29）：它的征求意见条目挂在「互动服务 → 网信@你」，
**首页导航里没有入口**，早先按「首页导航 + 常见路径探测」得到的是「候选路径全 404」
的错误结论。教训写在 `src/sources/registry.ts` 的注册表注释里 —— 政府站点的征求意见
栏目常挂在互动 / 交流类二级栏目下，排查应先做全站链接扫描（含首页各处 widget 的 href）
再逐层进入二级栏目。

**状态推导次序**（issue #18）：截止日期是事实、优先；解析不到时采用源自身标注
（`NormalizedNotice.status`，来自列表的状态列 / 标题标注）；都取不到才兜底「征求意见中」。
否则跨域条目与详情缺截止句的条目会被误判为进行中。

### 链式跳转（issue #20）

有些源的正文地址要一跳一跳才拿得到。国家发展改革委实测：列表条目是前端渲染页
`sa.html#/<shortKey>` → `access-url` 接口返回文章页地址 → 文章页只是空壳、
正文在 `getArticleDetail` 接口里。

- **契约**：`SourceAdapter.resolveDetailUrl(body, pageUrl)` 返回**下一跳地址**，
  返回 null 表示「当前 body 即详情内容」。`detailContentUrl` 给首跳（同步）。
  跳数上限 `MAX_DETAIL_HOPS = 4`，超限报错降级 —— 适配器若因页面改版始终返回
  下一跳，不会把整轮抓取拖死。
- **每一跳的请求都由抓取层发出**（不是适配器自己 fetch）：源级传输处置
  （`fetch.cookieChallenge`）、UA、超时、fixture 地址重写集中在抓取层一处；
  适配器自己发请求还会让 E2E 打到真实站点（ADR-0001）。适配器只做
  「从这一跳的 body / 地址推出下一跳地址」这件纯计算的事。
- **下一跳地址相对当前跳地址推导**（不硬编码域名）：生产落在真实站点、
  E2E 里落在 fixture 目录内，同一份代码两条路都通。E2E 里按条目分目录
  （`ndrc/i1/…`）—— fixture 源站按路径映射、不认查询串，而真实站点所有条目
  共用同一路径、只靠 `?shortKey=` 区分。
- **失败降级**：链断掉（如 access-url 响应缺 articleId）只记日志、不中断整源 ——
  条目仍以列表层数据入库（状态退回源标注）；若该条目**已入库过详情层数据**，
  本轮沿用旧值而不是写成 null（issue #30：整行覆盖写会让一次网络抖动抹掉正文，
  并让已截止条目因截止日期丢失翻回「征求意见中」）。E2E 有专门锚点。

抓取礼貌性：详情请求之间固定间隔 400ms（`worker/jobs/crawl-notices.ts` 的
`DETAIL_FETCH_INTERVAL_MS`），避免政府站点 WAF 限流封 IP。

## 如何添加 fixture 源

见 `fixtures/README.md`。要点：

1. `fixtures/<source>/` 放入列表页 / 详情页 HTML 快照（`<source>` 即源 ID）；
2. 在 `src/sources/registry.ts` 的 `sourceAdapters` 数组登记适配器；
3. 在 `tests/e2e/` 为该源新增端到端场景，经 `SOURCES_FIXTURE_BASE` 把抓取指向
   fixture 源站。

## 扩展点约定（并行切片必须遵守）

新增能力一律通过各自模块内的**注册表 / 工厂**接入，不在核心代码硬编码：

| 扩展点 | 位置 | 接入方式 |
| --- | --- | --- |
| 源适配器 | `src/sources/registry.ts` | 适配器加入 `sourceAdapters` 数组 |
| worker 任务 | `worker/registry.ts` | 任务加入 `jobs` 数组 |
| LLM 提供商 | `src/lib/ports.ts` 的 `createLlmPort()` | 新分支返回适配器（环境变量切换） |
| 邮件提供商 | `src/lib/ports.ts` 的 `createMailerPort()` | 同上 |
| 检索后端 | `src/lib/ports.ts` 的 `createSearchPort()` | 新分支返回适配器（`SEARCH_PROVIDER=local \| meilisearch`） |

代码约定：`src/lib`、`src/db`、`worker` 内的相对导入使用显式 `.ts` 扩展名
（这些文件也会被 Node 24 类型剥离直接运行）；页面文件用 `@/` 别名。

## 数据库与迁移

- schema 双方言镜像：`src/db/schema/sqlite.ts` 与 `src/db/schema/postgres.ts`
  （列名与语义必须一致，修改需同步两文件）；
- 迁移按方言分别生成并提交：

```bash
npm run db:generate        # SQLite   → drizzle/sqlite/
npm run db:generate:pg     # PostgreSQL → drizzle/postgres/
npm run db:migrate         # 对当前 DB_DRIVER 的库应用迁移
```

> ⚠️ `db:generate` / `db:generate:pg` **目前在非交互 shell 里跑不动**（2026-09-26 实测）：
> drizzle-kit 的元数据快照只到 `0008`，journal 却已经到 `0016`，于是它每次都要交互式确认
> "这是不是重命名"（`Error: Interactive prompts require a TTY`）。`0009` 起各条迁移是**手写**的
> （照 `drizzle/<dialect>/0015_add_notice_genre.sql` 的形状加一条 SQL，再往 `meta/_journal.json`
> 追加一项、`when` 必须比上一条大 —— 否则存量库会被静默跳过，见
> `tests/e2e/migrations-integrity.test.mjs` 里 2026-09-24 那次事故的记录）。

## docker-compose（生产对齐）

`docker-compose.yml` 编排 web / worker / PostgreSQL / Meilisearch 四服务，与 PRD
部署方案一致。**注意：开发机没有 Docker，该文件在开发机不可运行**，仅供生产部署
对齐（ADR-0001）；**本地**的验收标准是 `npm run e2e` 全绿 + compose 文件与服务
清单一致（CI 目前不执行，见「订阅与通知」一节那条），所以这两个数只有人跑才算数。
相关 Dockerfile（`Dockerfile.web` / `Dockerfile.worker`）同样未在本地
实际构建过，部署时按环境微调。
