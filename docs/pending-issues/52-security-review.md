# 安全与滥用面审计（第三轮）与 11 项修复

前两轮分别是「规范 / 标准」（#50，diff 范围）与「健康与健壮性」（#51，失败模式 +
构建依赖）。这一轮换轴：**信任边界** —— 公开站有后台登录、外发跳转、发信，
以及一个会跟随第三方 HTML 的抓取器。三路并行审查 + 逐条核验后落地。

## 一、审查发现（已逐条核验，非推测）

### A. 抓取侧信任边界（最重）

**A1 详情 URL 只校验协议，重定向不校验目标。**
`extract.ts` 的 `resolveUrl` 是唯一入口，只看 `http/https`；`crawl-notices.ts` 把列表
解析出的 URL 直接交给抓取层，普通路径的 fetch **自动跟随最多 20 跳且不看目标**，
WAF 分支手动跟随同样不校验。源站被挂马 / 改版返回 `http://169.254.169.254/…`
（或阿里云元数据 `100.100.100.200`）时 worker 会主动请求，正文还能以纯文本入库并
公开渲染 —— 一条数据外带通道。红检时的实测最能说明问题：**去掉守卫后 worker 真的
去请求了 169.254.169.254 并跟随了 302**（日志里是 `fetch failed`）。

**关键约束（决定了改法）**：不能用「同源白名单」收口。交通运输部「意见征集」栏目的
条目链接**跨域混排**（本部 mot.gov.cn / 民航局 caac.gov.cn / 国家铁路局 nra.gov.cn，
见 `mot.ts` 文件头），硬性同源会让这些条目静默退化为列表层数据 —— 正是 #30 / #51
反复对抗的「静默烂掉」失败模式。故改为「必须是公网 http(s) 目标」。

**A2 响应体无大小上限。** 只有 15s 超时 + `response.text()`。异常源持续输出大流量时
15 秒内就能把 worker 内存打满，而 worker 同时跑抓取 / 摘要 / 提醒，OOM 会中断整条
数据管线。（同仓的 LLM 适配器有 12,000 字符上限，说明有这意识，抓取层漏了。）

### B. 后台与会话面

**B1 会话 Cookie 无 `Secure`，全站无 HSTS。** Cookie 的值就是 `ADMIN_TOKEN`，
而浏览器在 `http://` 首跳会**先把 Cookie 发出去**（Caddy 的 301 发生在之后）；
共享密钥没有独立吊销手段，改 `ADMIN_TOKEN` 才能作废。
**B2 六个安全响应头一个都没有**（Caddyfile 只有 encode + reverse_proxy，
`next.config.ts` 没有 headers()），`X-Powered-By: Next.js` 照发 —— 后台页面
（停用源、人工补录按钮）可被任意站点 iframe 点击劫持。
**B3 `/admin/login` 零限流零锁定、失败无日志**，而 `.env.example` 的默认值是公开占位串。
**B4 `?token=` 被所有后台端点接受**，共享密钥会留在浏览器历史 / 书签 / 分享链接里
（README 当时还把它写成脚本用法）。

### C. 写路径滥用与数据完整性

**C1 订阅端点无限流**：任何人对任意邮箱反复提交都会真的发出一封本站的确认信
（拿别人的发信域当放大器，进黑名单后连正常确认信都投不出去）；`?updated=1`
是「该邮箱是否已确认订阅」的**枚举 oracle**；重复提交还会轮换他人待确认订阅的 token。
**C2 `GET /subscribe/confirm` 直接写库确认**：#34 早已在退订侧确立「邮件安全网关会
预取链接，有副作用的动作必须放 POST」的原则，确认侧没跟上 —— 预取即确认，
邮箱主人毫不知情还赔掉那个确认链接。
**C3 `/go` 机器判定只有 UA 一维**：Next 会用 GET 处理器自动实现 HEAD（`curl -I`、
链接校验器、监控探针都成了一次点击），`Purpose: prefetch` 同理 —— 库内那 46 行
机器点击的同类成因。
**C4 并发重复订阅撞唯一约束 → 公开端点 500**（先 select 再 insert 的 TOCTOU）。
**C5 `/go` 目标无协议白名单**（写路径都已守卫，属纵深防御缺口）。
**C6 重新订阅轮换退订 token**：旧邮件里的退订链接全部失效，削弱「每封邮件均可退订」。
**C7 点击两个口径非原子**：`notices.outbound_clicks` 与 `outbound_click_daily`
无事务包裹，第一条成功后第二条失败即漂移。

## 二、落地（11 项）

| # | 修复 | 关键取舍 |
| --- | --- | --- |
| 1 | `src/lib/net-guard.ts`：拒绝内网 / 环回 / 链路本地 / CGNAT / 保留段（含 IPv6 与 `::ffff:` 映射）、内部主机名、单标签主机名；fixture 源站 origin 显式放行 | 不做同源白名单（见 A1）；不做 DNS 解析（残留见 FOLLOWUPS） |
| 2 | 抓取层所有路径**手动跟随重定向**（≤5 跳），每一跳先过守卫；WAF cookie 只在同主机重放 | 保留「带 Set-Cookie 是挑战 / 不带是普通重定向」的既有区分（moj 的 e2e 是安全网） |
| 3 | 响应体上限 4 MiB：先看 `content-length` 再流式计数 | 列表超限 → 源级失败告警；详情超限 → 单条降级 + 沿用已入库详情（#30 的保全机制） |
| 4 | 会话 Cookie 加 `Secure`；`?token=` 改为「GET 换取会话 Cookie + 303 到去掉 token 的同地址」，写操作只看 Cookie | POST 不做换取：一次误点的链接不该触发写动作 |
| 5 | `next.config.ts` 下发五个安全头 + `poweredByHeader: false` | 不做 CSP（内联样式 + Next 内联脚本需 nonce 体系）；HSTS 不加 includeSubDomains / preload |
| 6 | `/subscribe/confirm` 拆成「GET 只读确认页 + POST `/submit` 动作」 | 与 `/unsubscribe` 的既有先例对称；邮件里的链接不变 |
| 7 | `/go`：HEAD 与 `Purpose/Sec-Purpose: prefetch\|prerender` 不计数；目标协议白名单 | 命中时照常 302，绝不打断跳转 |
| 8 | `src/lib/rate-limit.ts`（进程内固定窗口，按 `X-Forwarded-For` 首跳）+ 订阅与后台登录各接一个 | 阈值走 envInt（`SUBSCRIBE_RATE_LIMIT_PER_HOUR` 缺省 10、`ADMIN_LOGIN_RATE_LIMIT_PER_HOUR` 缺省 30），0 = 不限流；单实例前提见 FOLLOWUPS |
| 9 | 订阅 upsert 改 `ON CONFLICT DO NOTHING` + 落空回落更新分支 | 不捕获异常：唯一约束冲突的报错形状两方言不同，按方言分支会违反 ADR-0001 |
| 10 | 重新订阅只轮换确认 token，退订 token 保持稳定 | 退订 token 不是身份凭据，轮换的代价（旧邮件退订链接失效）大于收益 |
| 11 | compose 关键口令 `${VAR:?}` 必填 | **先核验线上 `.env` 三项均为 32 位随机值**才改；否则会把「静默用默认口令」换成「起不来」 |

另外把订阅结果文案统一成一句（去枚举 oracle），并给后台 429 加了与「令牌不匹配」
区分开的文案。

## 三、未做（有意，已登记 FOLLOWUPS）

- **CSP**：见上；**DNS 层 SSRF**：字面量判定不覆盖「公网域名解析到私网 IP」；
- **C7 点击口径漂移**：**已实测** drizzle 的 better-sqlite3 事务要求同步回调
  （`db.transaction(async …)` 抛「Transaction function cannot return a promise」），
  统一 db 句柄下做不到，按驱动分支会多出第二处方言代码。更彻底的替代是把
  `outbound_click_daily` 当唯一真源、总额改求和；
- **订阅规则可被第三方改写**：已与用户确认本轮只做「限流 + 统一文案」（限流堵住
  发信放大，统一文案去掉枚举信号），规则改写语义保留。完整修复要给 subscriptions
  加待确认规则暂存列 + 两方言迁移，属单独一轮；
- **限流的单实例前提**、**后台凭据的吊销**（共享密钥模型的固有属性）。

## 四、验收

- 单元 **176 → 196**（新增 `net-guard` 11 例表驱动、`rate-limit` 7 例含注入时钟、
  env 契约 2 例）；E2E **188 → 200**（新增 `crawl-transport-guard` 3、
  `security-headers` 4、`rate-limit` 3、`subscribe-concurrency` 2）；
  `eslint` 与 `tsc --noEmit` 干净。
- **六处红检**，逐一确认「红在哪一条用例」：
  1. 去掉抓取守卫 → `crawl-transport-guard` 第一轮红，日志显示 worker **真的去请求了**
     `169.254.169.254` 并跟随了 302（漏洞现场）；
  2. 确认页改回 GET 写库 → `GET 预取不得确认订阅` 红；
  3. 删掉 `X-Frame-Options` → 四条头用例全红（`应下发 x-frame-options`）；
  4. 去掉订阅限流调用 → `/error=rate_limited/` 与「另一个 IP 应被放行」红；
  5. 去掉 `ON CONFLICT DO NOTHING` → `UNIQUE constraint failed: subscriptions.email` 红；
  6. 去掉 HEAD 判定 → `HEAD 与预取请求不应计入北极星指标` 红。
- **一处自伤（本轮真踩了）**：并发订阅的第一版 e2e 是「并发发 5 个 HTTP 请求」，
  它**假绿** —— better-sqlite3 是同步驱动，一个请求从 select 到 insert 全在微任务里
  跑完，事件循环轮不到处理下一个连接，HTTP 层在 SQLite 上天然串行，根本进不了
  TOCTOU 窗口。改成直接 `Promise.all` 调用仓储函数（两个调用都在第一个 await 让出，
  两次 select 都看到「不存在」）才确定性复现。教训：**并发类测试必须验证它真的
  并发进了那个窗口，否则它测的是「顺序执行也正确」**。
- 线上核验（部署后，见下节）。

## 五、线上核验

- 五个安全头全部下发，`X-Powered-By` 消失；`/go` 自己的 `cache-control: no-store`
  与 `x-robots-tag: noindex` 仍在（未被统一加头挤掉）。
- `HEAD /go/<id>` → 302 + 正确 Location，且**点击数不变**；浏览器 GET 对照 +1；
  `Purpose: prefetch` 请求不计数。
- `GET /subscribe/confirm?token=<坏值>` → **200 渲染「确认链接无效」页**（此前是 303
  到结果页），带 noindex。
- `GET /admin?token=<真实值>` → 303 到 `/admin`（Location 里没有 token）+
  `Set-Cookie: …; HttpOnly; Secure; SameSite=Lax`；带其它查询参数时保留
  （`/admin?ok=review_saved`）；`POST /admin/sources?token=<真实值>` 无会话 → **401**。
- `docker compose config --quiet` 通过（`${VAR:?}` 必填语法在真实 `.env` 下能解析，
  缺项会当场拒绝启动）；线上 `.env` 的 `POSTGRES_PASSWORD` / `MEILI_MASTER_KEY` /
  `ADMIN_TOKEN` 均为 32 位随机值（非模板占位串）。
- **抓取回归（最要紧的一条）**：部署后 worker 对**十个真实政府源**跑完整一轮 ——
  178 条全部 `抓取完成`、**零 `详情失败`**、零守卫拒绝、零源失败告警。
  传输层重写没有误伤任何真实源：司法部的 WAF 挑战与 http→https 普通重定向、
  交通运输部的跨域详情（caac / nra）、发改委的链式接口跳转全部照常。
- 全站页面（首页 / feed / sitemap / robots / search / stats / subscribe / unsubscribe）
  全部 200。
- **一个操作细节（本轮踩到）**：会话 Cookie 加了 `Secure` 之后，服务器上本地排障用的
  `http://127.0.0.1:3000/admin` **不再能用 cookie jar 驱动** —— curl 不会把 `Secure`
  Cookie 发到 http 连接（实测拿到 401，一度以为是换取逻辑坏了）。排障要么走
  `https://<域名>`（真实路径，已验证换取 → 看板 200），要么直接用 `?token=` 换取一次
  再手工带 Cookie 头。`curl -I http://127.0.0.1:3000/` 这种「确认应用活着」的探针不受影响
  （不需要鉴权）。

## 六、一个过程观察

**「统一加头」最容易出的事是覆盖掉路由特意设的头。** `next.config.ts` 的 `headers()`
作用于所有响应，而 `/go` 的 `no-store` / `noindex` 是计数端点与收录面的关键 ——
被覆盖会静默漏计点击、甚至被收录。因此 `security-headers.test.mjs` 里专门有一条
「路由自己设的头不被挤掉」，而不是只断言首页带头。
