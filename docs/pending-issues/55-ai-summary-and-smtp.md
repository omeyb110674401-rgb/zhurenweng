# 55 · AI 摘要与邮件订阅上线（第六轮，配置为主 + 一处代码修复）

第五轮（#54）把线上体检的问题修完之后，站上还欠着两块**功能级门控关闭**：
AI 摘要（`GLM_API_KEY` 未填 → 详情页显示「AI 结构化解读尚未启用」，页脚按 #54 改成
不提 AI 的文案）与邮件订阅（`SMTP_*` 未填 → 按 #17 隐藏订阅入口、截止提醒不发信、
任务失败告警不发信）。本轮把两条都接上，并按老规矩以**生产实测**为准。

## 一、本轮唯一的代码修复：`SMTP_SECURE=true` 会被读成「不要 TLS 直连」

`resolveSmtpOptions` 的口径是 `SMTP_SECURE` 只认 `1`（隐式 TLS 直连）/ `0`（STARTTLS），
留空才按端口推断（465 → 直连）。但 `.env.example` 写的是 `SMTP_SECURE=true`，
**生产 `.env` 里也确实躺着一行 `true`** —— 而 `true !== '1'`，于是它被解析成
「显式关闭直连」：对 `smtp.qq.com:465` 这种隐式 TLS 端口发起 STARTTLS 握手必然失败，
且只在第一次真正发信那一刻才炸，错误现场离配置现场隔了一整个 SMTP 往返。

改法是在构造期拒绝含糊值而不是猜操作者的意思（与 `parseSmtpPort` 同一套路）：
`src/lib/adapters/smtp-mailer.ts` 新增 `parseSmtpSecure`，非 `1`/`0`/空白 直接抛
「SMTP_SECURE 只能填 1… 收到「true」…留空则按端口推断」。门控 `mailerReady()` 调的是
同一个解析函数，所以填错时订阅入口自动隐藏，不会出现「表单能提交但发信必失败」（#25 的口径）。
`.env.example` 与生产值同步改为留空，单测钉住三种输入。

## 二、运维脚本（新）：`.env` 的幂等写入与「密钥不上命令行」

- `deploy/set-env-keys.sh <KEY=VALUE 清单 | ->`：**在服务器上跑**。先删同名旧行再追加
  （同名键出现两次时 compose 取最后一次，手改容易留下「旧值在前」的迷惑现场）、
  改前备份、`chmod 600`、值含 `$` 直接拒绝（compose 会把它当变量引用展开）、
  收尾必过 `docker compose config --quiet`。全程只打印键名与值长度。
- `deploy/enter-smtp-credentials.sh`：给操作者本人在服务器终端里跑，用 `read -s`
  从终端读授权码（不回显、不入 history），值只经 stdin 交给上面那个脚本。
  固定 `smtp.qq.com:465` —— 见下面的端口实测。

## 三、AI 摘要走的是一条**临时**通道（欠着的合规债）

用户拍板先用一把 OpenCode「go」免费档 key 把功能跑出可见效果。`.env` 现行配置：

```
LLM_PROVIDER=openai
LLM_API_BASE=https://opencode.ai/zen/go/v1
LLM_MODEL=mimo-v2.5
LLM_TIMEOUT_MS=300000
LLM_EXTRA_HEADERS={"x-opencode-session":"zw-cn101-…","user-agent":"opencode/0.1.0"}
```

同一把 key 在付费档 `/zen/v1` 上是 `Insufficient balance`，所以 go 免费通道是唯一能跑的那条。
换服务商这件事本轮**没有改一行代码**，正是 #25 留 `LLM_PROVIDER=openai` 通用端点的目的。

两档模型各打了一次真实请求（`scripts/verify-llm-port.mjs` 加了「容器模式」：
环境里已有密钥就不再改写，直接按容器现状验，验的是「线上真的能用吗」而不是
「我配的这套能用吗」）：`glm-5.3-flash` 8.2s/次、749 tokens；`mimo-v2.5` **87.6s/次**。
两者五段式形状都合法、引用逐字命中 8/8。用户选 mimo 作默认，于是超时从 120s 提到 300s ——
87.6s 贴着 120s 上限，一次超时会白烧 3 次重试并把条目扔进人工复核队列。
代价是反过来：最坏情况单条可占住 4×300s ≈ 20 分钟。

## 四、端口与出网实测（决定 SMTP 只能用 465）

在 **web 容器内**跑的探针（`node:tls` 握手 + 读横幅）：

| 目标 | 结果 |
| --- | --- |
| `open.bigmodel.cn/api/paas/v4` | HTTP 401（无密钥），165ms —— 出网正常，只差 key |
| `smtp.qq.com:465` | TLS OK，102ms |
| `smtp.qq.com:587` | TCP OK（明文端口，需 STARTTLS） |
| `smtp.qq.com:25`、`smtp.163.com:25` | **超时**（国内云主机默认封 25 出站） |
| `smtp.exmail.qq.com` / `smtp.163.com` / `smtp.mxhichina.com` / `smtpdm.aliyun.com` :465 | TLS OK |

## 五、验收

**AI 摘要**（存量口径：库里 185 条中 77 条 `status≠closed` 且摘要为空，按 #4 已截止的 108 条不生成）

| 项 | 结果 |
| --- | --- |
| 容器内走生产端口 | `llmReady()=true`、`provider=openai`、`上报模型名=mimo-v2.5`、调用成功 87.6s、引用 8/8 逐字命中 |
| 详情页渲染 | 抽样两条 `summary_status=done`：`AI 生成，仅供参考` 标注在位、`summary-quote` 各 7/8 个、`summary-placeholder` 0 个 |
| 全站文案回翻 | 页脚出现「AI 生成内容将显著标注」、#54 那句「由程序按固定规则摘录」消失；首页 `meta description` 回到含 AI 的版本 —— **未重新 build，仅重启容器即生效**（正面验证 #54 的 `force-dynamic` 修复） |
| 消化节奏 | 摘要任务每轮上限 50 条、worker 每日一轮，所以存量不是一次跑完；`docker compose up -d worker`（启动即跑一轮）是排空手段 |

**邮件**（QQ 个人邮箱 + 授权码；`MAIL_FROM` 用「主人翁 \<地址\>」显示名，QQ 要求发件人与认证账户同址）

| 环节 | 结果 |
| --- | --- |
| 提交订阅 | `POST /api/subscriptions` → `303 → /subscribe?sent=1`（该路径只有在 nodemailer 拿到服务端受理后才走；失败会是 `?error=send_failed`） |
| double opt-in | 新行 `confirmed=0` → 用库里的 `confirm_token` `POST /subscribe/confirm/submit` → `303 → /subscribe/confirmed` → `confirmed=1` |
| 一键退订（RFC 8058） | `POST /unsubscribe/one-click?token=…` → `303 → /unsubscribe/done?ok=1`，`unsubscribed_at` 落库（`confirmed` 保持 1，活跃与否由退订标记决定） |
| 退订后重新订阅 | 行 `confirmed` 归 0、`unsubscribed_at` 清空（否则退订过一次就再也订不上）→ 再确认回 1 |
| 中文规则存储 | `keywords_json` 落库字节 `5b22e695b0e68dae225d` = `["数据"]`，UTF-8 完好 |
| 门控翻转 | 配好之后 `/subscribe` 表单出现、页脚「订阅提醒」入口恢复；配好前两者都不在（`暂未开放` 文案 0 次出现） |

一处**自己制造的假警报**值得记下：第一次用 `curl -F "keywords=数据"` 测试时，库里落下
4 个 `U+FFFD`（字节 `efbfbd`×4）—— 因为 Git Bash 把命令行里的中文按 **GBK** 发出，
4 个 GBK 字节不是合法 UTF-8，解码时被逐个替换。改成从文件逐字节送 UTF-8
（`-F "keywords=<file"`）后存储正确。不是应用缺陷，但同一次请求里 GBK 化的
`categories` 值**被白名单丢掉**（`categories_json=[]`）而不是写进库，
正好证明 #52 那道「只接受已知领域标签」的守卫在真实脏输入下有效。

## 六、未做（有意）与已知边界

- **合规债没还**：PRD 第 49 条要求面向公众的生成式服务用**已备案国产模型直连**。
  `mimo-v2.5` / `glm-5.3-flash` 本身是国产已备案模型，但这条路径把公示正文经
  `opencode.ai` 境外中继出境，且该网关的定位是给编码 agent 用的，随时可能限流或改规则。
  收敛只需改 `.env` 三行（换 GLM 直连则只填 `GLM_API_KEY`），代码不用动。
- **个人 QQ 邮箱是发信量的短板**：日发信量有上限、陌生收件方到达率不如域名邮箱。
  订阅者是个位数时无所谓；要对外推广就得换腾讯企业邮箱或阿里云邮件推送（两者 :465 已实测可连）。
- **`MAIL_FROM` 的显示名依赖 compose 对 `.env` 里 `<`、`>`、空格的解析**：本轮用
  `主人翁 <地址>` 发信成功，但这层解析没有测试覆盖（`docker compose config` 能渲染出来 ≠
  nodemailer 收到的就是这个值）。真要长期依赖，值得把它列进部署核查清单。
- **已截止的 108 条永不生成摘要**（#4 的既有口径，不是本轮引入）。存量里因此会长期
  存在「无摘要」的条目。**本轮的说法已被 #58 更正**：当时以为摘要区对它们显示 #22 的
  说明块，实测却是「摘要生成中」—— #22 的门只管「LLM 端口不可用」（`unavailable`），
  管不到「这条永远不会入队」。两种情况的诚实文案分别是 #58 新增的 `not-generated` 分支
  与原有的 `unavailable` 分支。
- **`summary_model` 是混合的**：切换模型前那一轮已按 `glm-5.3-flash` 生成了约 50 条。
  每行记着自己的模型，本就是这一列的用途，不做重刷（重刷等于多打 70+ 次境外请求）。
- **告警邮件未做人为触发**：与确认邮件共用同一个 `createMailerPort()` 路径，本轮已由
  真实确认邮件证明可发；`ALERT_EMAIL` 已配置，等一次自然失败再验（触发时会收到一封
  「任务失败告警」，内容是真实失败而非演练）。

## 七、一条部署操作教训

`docker compose up -d worker web` 与两条 `docker compose exec` 观察命令串在**同一条**
`workbench exec` 里跑，中途连接被掐断 —— 结果 web 容器停在 `created` 状态没被拉起，
**线上中断约一分钟**，且旧 worker 仍在跑旧环境（表现为 `up -d worker` 显示 "Running"
而实际没换）。重启类命令应当自己一条、短、不 sleep、不串观察命令，观察另开一条。
教训本身不是「别用 workbench」，而是**别让一条命令同时承担「改变状态」和「观察」**。
