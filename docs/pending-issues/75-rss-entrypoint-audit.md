# 75 — RSS 这条读者入口从没被产物验证过（补齐三条入口的最后一洞）

## 一、为什么做这一条

首页关键词框、`/search`、`/feed.xml` 是本站三条"读者直接用得着"的入口。前两条在 issue #72
里各用产物验过一次（检索抽样 32/32 可搜到、两套点击口径 113 = 113 无漂移），**RSS 一直没有**：
它只在 e2e 里被断言过"生成的 XML 形状对"，从没验过**线上那个端点今天吐出来的条目集合等不等于库里的**。

这属于本阶段反复抓到的同一族坏法（#68 cron 从未触发、#70 提醒实际发出 0 封、#71 失败只写进没人读的日志）：
配置在、代码在、没人验过产出。RSS 的静默坏法尤其不好察觉 —— 端点返回 200、XML 也打得开，
只是里面少了一批条目，或者链接指向了错的宿主。读者的表现不是"报错"，是"最近好像没什么新东西"，
或者"点了没反应"，而站点这边一切正常。

## 二、做了什么

| 文件 | 作用 |
| --- | --- |
| `src/lib/pipeline-health.ts` | 判据（纯函数）：`parseFeedSample` 从 XML 取回 guid/pubDate/link 并做结构体检；`feedExpectedIds` 定"今天该出现在 feed 里的那批 id"；`rssFeedHealth` 出四态结论；`auditRssFeed` 取一次线上 feed 并与库里比对 |
| `scripts/audit-rss-feed.mjs` | 只读专用审计（可单独跑、可接 cron）：打印结论与逐条差异，`fail` 时非零退出 |
| `scripts/audit-pipeline-health.mjs` | #74 那张健康表多一行 `RSS feed 产物`，与专用审计**共用同一份判据** |
| `docker-compose.yml` | worker 服务补注入 `SITE_URL` —— 探针要知道"读者去取哪个地址"、以及链接的合法宿主是谁。未配则这一行报 `unknown`，不猜 |
| `tests/unit/pipeline-health-rss.test.mjs` | 10 条单测（样本用真正的生成器 `buildFeedXml` 产出再解析回去） |

判据分四问，因为它们要去查的地方完全不同：

1. **结构**（启发式）：未配对的 `<item>`、裸 `&`、XML 控制字符 ⇒ 阅读器会整份拒收。
   写这条时发现本仓库的生成器只转义 `&<>"'`，所以标题里真混进一个控制字符就会原样写进 feed ——
   探针能抓住它（单测就是拿真生成器造的这个样本）。**刻意不叫它"XML 校验"**：本仓零依赖自拼 XML，
   探针也只有正则数开合，结论里明写"启发式"，不假装做过解析器级验证。
2. **集合**：库里有、feed 里没有 ⇒ `fail`。库内条目 ≤ `FEED_MAX_ITEMS` 时基数是全量（今天 192 条），
   超过之后只比对发布日期最新的那 30 条 —— 第 200 名附近受排序并列影响，逐条比对会误报（注释里写着）。
3. **ghost guid**：feed 里有、库里没有 ⇒ `fail`。
4. **链接宿主**：`link` 不以 `SITE_URL` 开头 ⇒ `fail`。这是 #7/#20 那一族（构建期环境值被固化）
   在 feed 侧的对应洞：宿主漂移了，读者点进去就是死链，而页面自己看不出任何问题。
   `SITE_URL` 没配时这一项**不判**（拿内部地址去判"不指向本站"会造出假红灯）。

探针没取到（端点 5xx、超时、没配地址）一律 `unknown`，detail 里带着原因 —— 与 #74 同一口径：
把"我不知道"折叠成"没问题"是这类检查最危险的失败方式。

## 三、自证（撤掉实现必须真的会红）

`scripts/check-test-pins.mjs` 新增 4 个 case，全部指向新单测（本轮全门：**97/97 撤掉实现都真的变红**）：

| 撤掉的东西 | 红灯来自哪条断言 |
| --- | --- |
| `if (input.feed.ok === false)`（取不到也报健康） | 探针没取到 ⇒ unknown，且 detail 带原因 |
| `if (input.missingIds.length > 0)`（feed 少条目不翻红） | "feed 少了一条" 那条断言 |
| 裸 `&` 那一支检测 | "未配对的 item、裸 &、控制字符各判结构不对" |
| 排序方向（拿最旧的一截当基数） | "超上限 ⇒ 只比对最新那 30 条"（deepEqual 整个基数） |

顺手改掉的一处冗余：`rssFeedHealth` 第一版同时收 `fetchError: string | null` 与 `sample: FeedSample | null`，
于是有一支 `if (sample === null)` 在生产路径上永远走不到（`auditRssFeed` 里两者恰好互斥）——
把它改成一个判别联合（`feed: {ok:true, sample} | {ok:false, error}`），只留一支早退，
那支才钉得住。这与 #71 撤掉 ERR trap + ALERTED 双重防线是同一条规矩：**能被抽掉而不红的机制不该留着**。

## 四、线上取证：读者今天从 RSS 拿到的东西是对的

**2026-09-25 当场实测**（零生产写入：本机直接取公开端点 + 生产库只读拉一份 id/日期快照，
用工作区这份判据算结论）：

```
HTTP 200 application/rss+xml; charset=utf-8 cache=no-store bytes=83183
判定 ok ｜ 192 条 item，guid 与库里对得上、链接指向本站（结构只做启发式检查）
feed 192 条 / 库里 192 条 ｜ 缺 0 ｜ ghost 0 ｜ 外链 0
频道标题「主人翁 —— 政府公示信息聚合」 pubDate 缺失 0 条
```

也就是：三条读者入口现在全部有产物证据 —— 检索（#72 抽样 32/32 可搜到）、点击两口径
（#72，113 = 113 无漂移）、RSS（本节）。库里 192 条含 110 条已截止，全量 feed 装的就是全部，
与 `FEED_MAX_ITEMS = 200` 的上限还差 8 条余量（超上限后判据自动切成"只比最新 30 条"，见第二节）。

这次取证的**两处限定**要一起记着，别把它当成"什么都验完了"：

1. 那次跑的是工作区里的判据。**2026-09-25 已部署并复跑**（用户打字授权）：同步 6 个文件 +
   `docker compose build worker` + `up -d worker`，容器里 `printenv SITE_URL` = `https://cn101.top`，
   镜像里已有 `scripts/audit-rss-feed.mjs`；探针在容器内再跑一次仍是
   `✓ 192 条 item / 库内 192 条`，且健康清单多出 `RSS feed 产物` 一行（总结论 warn，唯一 warn 是"可发订阅者 0 人"）。
2. `feed.xml` 走的是 SSR（`force-dynamic` + `no-store`），这份快照只代表取的那一秒。
   它是"今天是对的"的证据，不是"以后不会静默坏掉"的防线 —— 后者要靠部署之后接上定时跑。

部署后的复跑法（两条都在服务器上）：

```
docker compose build worker && docker compose up -d worker        # 让镜像里有这条探针
docker compose run --rm worker node scripts/audit-rss-feed.mjs
docker compose run --rm -v /var/backups/zhurenweng:/var/backups/zhurenweng:ro worker node scripts/audit-pipeline-health.mjs
```

## 五、有意不做

- **不做子 feed 的全覆盖探针**：`/feed.xml?category=…` 的条件一致性在 e2e 里已经钉着（与首页共用
  `parseHomeQuery` + `filterConditions`），线上再抽样一次只是重复；探针只量全量 feed 这一条读者实际订的路径。
- **不引入 XML 解析依赖**：为一个运维探针换整套 XML 库不成比例，且生成侧本来就是零依赖自拼。
- **暂不接 cron 告警**：#74 的健康报告也还没接（同样等授权）；接法就是拿它的非零退出码喂给
  `scripts/alert-backup-failure.mjs` 那条已上线的信道，等 #71 部署完之后一并决定要不要每天发。
