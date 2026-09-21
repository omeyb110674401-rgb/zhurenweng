# 代码健康与健壮性审计（第二轮）与 13 项修复

**缘起**：用户要求「继续审查代码健康和健全」。第一轮（issue #50）看的是 `origin/main...HEAD`
这份 diff 的规范与规格；这一轮看的是**整个仓库的健康度与失败模式**，范围不同。

两个独立子代理并行跑两个面：**运行时失败模式**（超时、静默失败、worker 韧性、告警覆盖、
优雅退出、无界增长、事务与并发、边界输入、资源泄漏）与**静态健全性 / 依赖 / 构建**
（类型缺口、未校验的外部数据、浮动 Promise、联合类型穷尽、依赖健康、Dockerfile 与 compose、
死代码）。承重结论我逐条读源码核验后才动手。

## 一、修复清单（13 项）

### 安全（1 项）

1. **`.env` 曾被烘进 web 镜像层（HIGH，已线上验证修好）**
   `Dockerfile.web` 用 `COPY . .` 拷整个仓库，而 `.dockerignore` 的 12 条排除清单里
   **没有 `.env`** —— `POSTGRES_PASSWORD` / `MEILI_MASTER_KEY` / `ADMIN_TOKEN` /
   `SMTP_PASS` / `GLM_API_KEY` 随镜像层分发（镜像可导出、可 `docker save`，事后删文件
   也不会从层里消失），而 `docs/deploy.md` 第 3 节正是让人把 `.env` 建在仓库根目录。
   同时 36 个 `.live-*` 本地核验快照（只在 `.gitignore` 里）也被拷进了镜像。
   → `.dockerignore` 逐项排除 `.env` / `.env.*` / `.live-*` / `tsconfig.tsbuildinfo` 等；
   线上重建后实测 **`/app/.env` 不存在**，并清掉旧悬空镜像（旧层含密钥）。

### 可用性与调度（4 项）

2. **PG 连接池没有超时（HIGH）**：`new Pool({connectionString})` 是「无限等」—— TCP 连上了
   但服务端不响应、或池子被占满时，查询会一直挂着。web 是 `force-dynamic` SSR，每个请求
   都要查库：池子一挂**整站一起卡死且没有任何日志或告警**；worker 的任务串行，一个挂住的
   查询就让整轮抓取停在那里。→ `connectionTimeoutMillis 5s` / `statement_timeout 15s` /
   `idle_in_transaction_session_timeout 15s` / `max 10`；迁移那条连接上单独关掉
   `statement_timeout`（等 advisory lock 的时长不该被 15s 判死）。

3. **worker 重入保护（MEDIUM-HIGH）**：`setInterval(() => void tick())` 没有守卫 ——
   一轮抓取远长于调度间隔（十个源 × 每条 400ms 礼貌间隔），会同时跑两轮：对政府站点是
   **双倍请求速率**（正是 #14 花力气避免的），对库是并发写同一批条目。另外 `tick()` 的
   拒绝没有兜底（未处理拒绝 → 进程死 → 重启后又是同一轮 → 重启循环）。
   → 加 `running` 守卫 + `guardedTick` 兜底。

4. **优雅退出 + 容器 PID 1（MEDIUM-HIGH）**：信号处理器原先 `process.exit(0)` 立刻退，
   会把在途轮次砍掉（源被标成「本轮成功」但只写了一半条目）；更根本的是 compose 的
   `sh -c "... && npm run worker"` 让 **PID 1 是 sh**，而非交互式 sh 不转发信号 ——
   SIGTERM 根本到不了 node，只能在宽限期后被 SIGKILL，优雅退出形同虚设。
   → worker 收到信号后先停调度、等在途轮次结束（上限 `WORKER_STOP_WAIT_MS`，默认 30s）；
   compose 两条 command 都改成最后一步 `exec`（worker 直接 `exec node worker/index.ts`），
   并显式 `stop_grace_period`（web 30s / worker 90s）。
   线上实测 PID 1 已是 `node worker/index.ts`。

5. **北极星路径不再被计数拖累（MEDIUM）**：`/go/[id]` 里 `recordOutboundClick` 抛错会让
   跳转返回 500 —— 库抖一下，读者就到不了官方原文页。**用计数失败惩罚用户的唯一动作是
   反的**。→ 计数写入失败只记日志、照常 302；条目真的不存在仍是 404。

### 不再静默烂掉（3 项）

6. **源数据质量降级要说话（HIGH）**：详情解析失败与单条入库失败被逐条吞掉（这是对的 ——
   一条坏数据不该拖垮整源），但旧代码因此照样打「抓取完成」并把源标成**健康**：源站改版
   让详情全部落空时，正文 / 截止日期 / 附件静默烂掉，健康看板全绿、告警不响（#30 只解决了
   「不覆盖」，没解决「没人知道」）。→ 逐条失败计数进完成日志；**过半失败且列表 ≥3 条**
   判降级：记源失败 + 发告警（文案写明「疑似源站改版或库异常，数据可能已停止更新」）。
   判据抽成 `src/lib/source-health.ts` 由单测钉死。

7. **单条入库失败不再连坐整源（MEDIUM）**：此前单条 `upsertNotice` 抛错会冒泡到源级
   catch —— 该源**剩下的条目全部不写**、源被标失败，并发一封把原因指错的告警。
   → 逐条 try/catch，只跳过那一条并记日志。

8. **SMTP 补超时（MEDIUM）**：nodemailer 默认 `socketTimeout` 10 分钟 /
   `connectionTimeout` 2 分钟 —— 黑洞 SMTP（防火墙丢包、服务商限流）会让**串行** worker
   每条提醒卡满默认超时，而提醒发送失败只记日志、没有任何告警。
   → 10s 建连 / 10s 问候 / 20s 单封。

### 边界与配置（3 项）

9. **环境变量整数解析（`src/lib/env-int.ts`）**：`Number('abc')` 是 NaN，而 NaN 静默穿过
   大多数用法 —— `setInterval(fn, NaN)` 的延迟按 0 处理（`WORKER_INTERVAL_MS=abc`
   会让 worker 对十个政府站点变成**热循环**）；`for (let i = 0; i <= NaN; i += 1)` 一次都
   不执行（`SUMMARY_MAX_RETRIES=abc` 让重试整个失效、每条直接转人工）。
   → 非法值**启动即报错**（与 `parseSmtpPort` 同一取舍）。

10. **边界输入不再 500**：`request.formData()` 对非表单请求体抛错，未捕获就是 500。
    订阅页是**公开**端点（现在 303 回 `?error=invalid_form`，并补了对应文案）、
    admin 登录页公开可达（现在返回同一张 401 引导页）。

11. **状态文案容错**：status 是 TEXT 列、仓储层直接 `as NoticeStatus`（断言不校验运行时值），
    库里一旦出现集合外的值，`Record<NoticeStatus, string>` 的索引给出 undefined ——
    页面上是空徽标、JSON-LD 里是 `"creativeWorkStatus": undefined`。
    → 两处标签表收成 `lib/notice-status.ts` 一份，未知值**原样显示**；摘要状态同样兜底。

### 工程卫生（2 项）

12. **CI 里那个叫 `Lint` 的 job 其实只跑单测** —— `npm run lint` 与类型检查**从未在 CI 里
    跑过**（唯一的类型门是 e2e job 里的 `next build`）。→ 补 `npm run lint` 与
    `npx tsc --noEmit`，job 名改为 `Lint & typecheck & unit`。

13. **死代码与开发机路径**：删掉 `PERIOD_BUCKET_ORDER` 与 `getSubscriptionByEmail`
    （注释都写着「在用」，实际无人引用）；两个 LLM 探针脚本的 `provider_config.json`
    路径改成 `ZW_PROVIDER_CONFIG` 环境变量覆盖（原先硬编码 `C:/Users/35258/...`）。

## 二、验收

- **单元 176**（+12：envInt 4 组、isSourceDegraded 4 组、状态文案 2 组、
  `.dockerignore` 与 compose `exec` 契约 2 组）；
- **E2E 188**（+3：新增 `crawl-source-degraded.test.mjs` 三轮 —— 详情齐全不误报 /
  详情全 404 判降级并发告警 / 详情恢复后回到健康）；
- **lint 干净**，**`npx tsc --noEmit` 干净**（这条以后由 CI 把关）；
- **红检**：把 `isSourceDegraded` 关掉 → 三轮里**只有「判降级」那一轮变红**
  （另两轮仍绿 = 判据两侧都被钉住，不是「凡失败就红」）；
- **线上核验**（重建镜像 + 重建容器之后）：
  - 新镜像里 **`/app/.env` 不存在**；旧悬空镜像已清（5 个 → 0，磁盘 28G 可用）；
  - worker 的 **PID 1 = `node worker/index.ts`**；compose 渲染
    `stop_grace_period: 30s / 1m30s`（由 compose 侧生效，裸 `docker stop` 仍走默认 10s）；
  - 首页 / 统计 / feed / sitemap / 搜索全部 200；`/go/<id>` → **302** 到官方原文，
    带 `cache-control: no-store` 与 `x-robots-tag: noindex`；
  - 10 个源**全部抓取完成**，日志干净：**0 条「详情失败」后缀、0 次误报降级**
    （降级判据在真实数据上没有狼来了）；收录 184 条、16 行机关数字之和 184；
  - `POST /api/subscriptions`（JSON 体）→ **303 `?error=invalid_form`**；
    `POST /admin/login`（JSON 体）→ **401**（修复前都是 500）。

## 三、未做（有意 / 记为后续，已登记进 `FOLLOWUPS.md`）

- **Dockerfile 单阶段 + root 运行**：瘦身与降权是真实收益，但改动面与部署风险不成比例，
  记为后续；
- **健康检查**：`docs/deploy.md` 让操作者「五服务应为 healthy」，而实际只有 db 有
  healthcheck、也没有 `/api/health` 端点；加它要先定「健康」的判据（库可写？检索可达？），
  记为后续；`web.depends_on.meilisearch` 也该从 `service_started` 收紧；
- **表增长无上限**：`outbound_click_daily` / `alert_sends` / `reminder_sends` 只增不删；
  sitemap 与 reindex 一次性载入全表（含正文）—— 184 条量级无碍，量级变大再说；
- **npm audit 4 个 moderate**：全部来自 `drizzle-kit → @esbuild-kit/esm-loader → esbuild`
  （dev-only，容器内不可达），且 `fixAvailable` 是**降级**到 `drizzle-kit@0.18`（会破坏
  配置），没有非破坏性修复；
- **tsconfig 的 `noUncheckedIndexedAccess` 等未开**：审计未发现现存缺陷（现有索引访问都有
  守卫），开启需要成片改动，记为后续；
- **提醒邮件的「先发后记」是刻意取舍**：at-least-once（重复提醒比漏提醒可接受），
  跨进程双发由「单实例部署 + 重入保护」覆盖，没有改成 claim-first。

## 四、过程教训（本轮真踩了）

**用整源根目录当 fixture 时，未被 fixture 覆盖的源会真实失败并产生副作用。**
我新写的 e2e 断言了「第一轮不该发任何邮件」，当场变红 —— 因为
`SOURCES_FIXTURE_BASE` 指向的 `fixtures/e2e-versions-degraded` 只提供 npc 一个源，
其余**九个源的列表页 404**，各自发了一封源级告警（这是正确行为）。
修法是按源收窄断言（`npcAlerts()` 过滤），而不是放宽断言。
**教训：这类测试的断言必须落到「被测源」上，否则 fixture 的覆盖缺口会被读成被测逻辑出错。**
（上一轮的红检哨兵坑已按记忆里的规矩避开了：注入一律用非空哨兵。）
