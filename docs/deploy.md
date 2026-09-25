# 部署手册（issue #13：国内云 + ICP 备案后上线）

适用：阿里云 ECS（Alibaba Cloud Linux 3 / Ubuntu 22.04+），单机 Docker Compose 编排
（caddy / web / worker / PostgreSQL / Meilisearch）。
开发机无 Docker，本地验收以 `npm run e2e` 为准（见 docs/adr/0001-local-dev-without-docker.md）。

## 0. 前置条件

- ECS：2 核 4G 起步、系统盘 ≥40G、**购买时长 ≥3 个月**（备案要求）、有公网 IP
- 安全组：放行 `22`（建议限本人 IP）、`80`、`443`
- 域名已完成 **ICP 备案**并在云解析添加两条 A 记录（`@` 与 `www`）指向该公网 IP
  （未备案域名不可解析到大陆服务器）

## 1. 服务器装 Docker

```bash
ssh root@<公网IP>
curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
systemctl enable --now docker
docker version && docker compose version
```

镜像加速（国内拉取 Docker Hub 官方镜像必备；写入 `/etc/docker/daemon.json` 后 `systemctl restart docker`）：

```json
{ "registry-mirrors": ["https://docker.m.daocloud.io", "https://docker.1panel.live", "https://hub.rat.dev"] }
```

## 2. 获取代码

**A. 服务器直接克隆** —— **当前不可用**：2026-09-21 起 GitHub 账号 `omeyb110674401-rgb`
被停用（仓库页与 codeload 均 404）。恢复推送通道或换托管后再启用。
```bash
git clone https://github.com/omeyb110674401-rgb/zhurenweng.git /opt/zhurenweng
```

**B. 本机打包上传**（整包通道，当前可用；在开发机 Git Bash 执行）
```bash
cd /d/Projects
tar --exclude=node_modules --exclude=.next --exclude=.git --exclude=data -czf zhurenweng.tar.gz zhurenweng
scp zhurenweng.tar.gz root@<公网IP>:/opt/
ssh root@<公网IP> "mkdir -p /opt/zhurenweng && tar -xzf /opt/zhurenweng.tar.gz -C /opt --strip-components=1"
```

**C. 增量同步单个文件**（已上线后改几个文件时用，**当前主用通道**）
```bash
bash deploy/sync-files-local.sh src/app/page.tsx src/lib/dates.ts
```
逐文件校验 sha256；传完仍需在服务器上重建镜像：
`cd /opt/zhurenweng && docker compose build web worker && docker compose up -d web worker`。
通道细节、历史脚本（`deploy-NN.sh`）为何不可用见 `deploy/README.md`。

## 3. 配置环境变量

```bash
cd /opt/zhurenweng
cp .env.example .env
vim .env   # 按模板逐项填写；POSTGRES_PASSWORD/MEILI_MASTER_KEY/ADMIN_TOKEN 换成强随机值
```

大模型服务商可切换（PRD「通过环境变量可切换服务商」）：默认 `LLM_PROVIDER=glm` 走智谱预设
（只填 `GLM_API_KEY`）；换任何 OpenAI 兼容端点则设 `LLM_PROVIDER=openai` 并填 `LLM_API_KEY` /
`LLM_API_BASE` / `LLM_MODEL`（可另加 `LLM_TIMEOUT_MS` 与 `LLM_EXTRA_HEADERS`）。**对外提供生成式
AI 服务的模型须为已备案的国产模型**（PRD 第 49 条），不要指向境外聚合服务。

> **现状（issue #55）**：线上走的是 `LLM_PROVIDER=openai` + `LLM_API_BASE=https://opencode.ai/zen/go/v1`
> + `LLM_MODEL=mimo-v2.5` 的**临时通道**（OpenCode 免费档网关，实测 87.6s/次，故 `LLM_TIMEOUT_MS=300000`）。
> 它把公示正文经境外中继出境，与 PRD 第 49 条不符，属已认账的合规债；收敛时只改这几行 `.env`，
> 代码不动。`LLM_EXTRA_HEADERS` 里的会话头是该网关要求的，换直连后应删掉。

邮件用个人 QQ 邮箱 + 授权码（issue #55）：`SMTP_HOST=smtp.qq.com`、`SMTP_PORT=465`、
`SMTP_USER` 与 `MAIL_FROM` 的地址**必须同一个**（QQ 拒收发件人≠认证账户的信），
`SMTP_PASS` 填邮箱设置里生成的**授权码**、不是网页登录密码。两条硬约束记在这里免得再踩：

- **只能用 465**：国内云主机一律封着 25 端口出站（`smtp.qq.com:25` 与 `smtp.163.com:25` 实测超时）。
- **`SMTP_SECURE` 只认 `1` / `0` / 留空**：留空按端口推断（465 → 隐式 TLS 直连）。填 `true`
  过去会被读成「关闭直连」→ 对 465 发 STARTTLS 必失败且只在发信那一刻炸；现在构造期直接报错。

### 3.1 改 `.env` 的正确姿势（密钥不进命令行、不进对话）

```bash
# 服务器上（可反复执行，同名键先删后加；自动备份 + chmod 600 + compose 校验）
bash /opt/zhurenweng/deploy/set-env-keys.sh /tmp/keys.txt      # keys.txt 是 KEY=VALUE 清单
bash /opt/zhurenweng/deploy/enter-smtp-credentials.sh          # 交互式录 QQ 授权码（read -s 不回显）
```

清单走文件或 stdin、不走命令行参数：命令行会进 shell history 与云助手的命令记录（控制台可查明文）。
值里不能含 `$`（compose 会当变量引用展开），脚本会拒绝。
端口类变量是**运行时**读取的，改完只需 `docker compose up -d web worker`（不必 rebuild）；
但**先在服务器上跑一次真实验证再重启 web**，否则 `mailerReady()` 一真、订阅入口立刻对外可见。

必填清单：`POSTGRES_PASSWORD`、`DOMAIN`、`SITE_URL`、`APP_BASE_URL`、`LLM_PROVIDER` + 对应密钥、
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM`、`MEILI_MASTER_KEY`、
`ADMIN_TOKEN`、`ALERT_EMAIL`、`ICP_NUMBER`（备案号，展示在站点所有页面页脚并链接工信部备案系统）。

其中 `DOMAIN` 供 Caddy 签发证书使用；`SITE_URL` / `APP_BASE_URL` 必须与其一致且为 `https://`。
`ICP_NUMBER` 在 `web` 的运行时读取，改后 `docker compose up -d web` 即生效（无需重新构建）。

## 4. 启动

```bash
docker compose up -d --build
docker compose ps          # 五服务应为 running / healthy
docker compose logs -f caddy web worker --tail=50
```

## 5. HTTPS（Caddy 自动签发）

`deploy/Caddyfile` 已配置：主域名反代到 `web:3000`，`www` 301 跳主域名，证书由
Caddy 向 Let's Encrypt 自动申请并续期（HTTP-01 校验走 80 端口）。

前置条件：DNS A 记录已生效、安全组放行 80/443。首次启动约 10~30 秒完成签发，
证书与账户密钥持久化在 `caddy-data` 卷，重启不重签。

```bash
docker compose logs caddy | grep -i -E "certificate|obtain|error"
```

如需证书到期通知邮件，在 `deploy/Caddyfile` 顶部加全局块：

```
{
	email you@example.com
}
```

改后 `docker compose restart caddy`。

## 6. 冒烟检查（备案通过、域名解析生效后）

```bash
curl -s -o /dev/null -w "home %{http_code}\n" https://<域名>/
curl -s -o /dev/null -w "feed %{http_code}\n" https://<域名>/feed.xml
curl -s -o /dev/null -w "admin %{http_code}\n" https://<域名>/admin        # 未带 token 应为 401
curl -sI http://<域名>/ | head -3                                          # 应 301 到 https
curl -s "https://<域名>/feed.xml" | head -20
```

首次抓取（手动跑一轮，之后由 worker 周期任务接管）：

```bash
docker compose run --rm -e WORKER_ONCE=1 worker npm run worker
```

## 7. 上线后核查

- 页脚备案号展示正确；订阅页隐私说明可见（仅存邮箱、可一键退订）
- AI 摘要显著标注「AI 生成，仅供参考，以官方原文为准」
- 摘要端口**走生产路径**验一次（容器模式：环境里已有密钥就不改写，验的是线上现状）。
  输入正文直接取站内详情页，所以给一个已入库的条目 id 即可：
  ```bash
  docker compose run --rm --no-deps -T \
    -e ZW_VERIFY_NOTICE_URL=http://web:3000/notices/00f8313ea7880fc0 \
    worker node scripts/verify-llm-port.mjs
  # 期望：门控 llmReady() = true、provider/model 与 .env 一致、引用逐字命中 N/N
  ```
- 邮件用一次**真实订阅**判定（成功与失败走不同落点，不用翻日志）：
  ```bash
  curl -s -o /dev/null -D - -m 40 -X POST -F "email=you@example.com" -F "keywords=<kw.utf8" \
    https://<域名>/api/subscriptions | grep -i '^location'
  # /subscribe?sent=1        → SMTP 已受理（nodemailer 只有拿到服务端受理才 resolve）
  # /subscribe?error=send_failed → 发信失败，原因在 docker compose logs web 里
  ```
  中文关键词**别从 Windows 终端直接敲**：Git Bash 按 GBK 送出，服务端 UTF-8 解码会得到
  `U+FFFD` 存进库（issue #55 实测踩过）。用 `-F "name=<文件"` 从 UTF-8 文件逐字节送。
  退订链路：`POST /unsubscribe/one-click?token=<库里的 unsubscribe_token>` 应回
  `/unsubscribe/done?ok=1` 并写下 `unsubscribed_at`。
- 管理后台看板：各源最近成功时间非空。告警（issue #58 后按轮次降噪）要这样验：
  人为让某源失败**一轮**只会在看板上留下「连续失败 1 轮」，**不发邮件**；
  连续两轮才收到该源那一封（此后每 7 轮一封）。想当场看到邮件，触发数据质量降级
  （一轮内过半条目失败）或任务级失败（把 docker-compose.yml 里 worker 的检索服务商临时改成
  一个未知值就能造出来，验完改回来）—— 这两类不等门槛。
  **别为了测试去手动多跑几轮抓取**：那是在多打政府站点；等一次自然调度即可（每日一轮）。
- 出站按钮 `/go/<id>` 正常 302 到官方原文（北极星指标埋点）
- 安全响应头（issue #52）——五条都应出现，且**不应**出现 `X-Powered-By`：
  ```bash
  curl -sI https://<域名>/ | grep -iE 'strict-transport|x-content-type|referrer-policy|x-frame-options|permissions-policy|x-powered-by'
  ```
- 后台会话 Cookie 带 `Secure`，且 `?token=` 只换取会话（不再直接放行）：
  ```bash
  curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://<域名>/admin?token=<ADMIN_TOKEN>"   # 应 303 到 /admin
  curl -sI -X POST "https://<域名>/admin/sources?token=<ADMIN_TOKEN>" | head -1                        # 应 401（写操作只看 Cookie）
  ```
- 改动部署配置（compose）后先验证解析，再重建 —— `${VAR:?}` 形式的必填项缺失会让
  `docker compose up` 直接拒绝启动：
  ```bash
  docker compose config --quiet && echo COMPOSE-CONFIG-OK
  ```

## 8. 日常运维

- **更新**：增量改几个文件走 `deploy/sync-files-local.sh`（当前主用通道），整包走第 2 节 B；
  `git pull` 依赖的 GitHub 通道自 2026-09-21 起不可用。传完在服务器上
  `docker compose build web worker && docker compose up -d web worker`
  - 注意：**删掉的路由文件要手工删**（同步脚本只传文件、不删文件）——App Router 里
    同一段同时存在 `page.tsx` 与 `route.ts` 会直接构建失败
  - 二进制资产（`public/og-image.png`、`favicon.ico`、`apple-icon.png`）由脚本按
    **原始字节**传输与校验（2026-09-21 修：压缩数据里可能恰好出现 `0x0D 0x0A` 字节对，
    先前的 CRLF 归一化会静默改坏内容 —— 而校验用的是同一套变换，所以还会「通过」）。
    传二进制时脚本会打印「二进制文件，按原始字节传输与校验」，没看到这句就要留神
- **限流阈值**（issue #52）：`SUBSCRIBE_RATE_LIMIT_PER_HOUR`（缺省 10）、
  `ADMIN_LOGIN_RATE_LIMIT_PER_HOUR`（缺省 30），单位次/小时，按客户端 IP 的固定窗口；
  计数在**进程内存**里，只对单实例部署有效（多副本时实际阈值 = 设定值 × 副本数）
- **备份（每天自动）**：`deploy/daily-backup.sh` 由 root 的 crontab 每天 19:30 UTC（北京 03:30）
  跑一次，产物在 `/var/backups/zhurenweng/`，保留 7 份。
  它不只是导出：每天把那份归档**真的恢复进临时库** `zw_backup_verify`，比对 6 项关键计数
  （条目数 / 有摘要数 / 附件行数 / 已抽字数量 / 订阅数 / 源数），对不上就非零退出 ——
  **备份没验证过 = 没有备份**。日志在 `/var/log/zhurenweng-backup.log`。
  - 安装（一次性，**`CRON_TZ=UTC` 不能省**）：
    `crontab -l 2>/dev/null | { echo 'CRON_TZ=UTC'; echo '30 19 * * * /bin/bash /opt/zhurenweng/deploy/daily-backup.sh >> /var/log/zhurenweng-backup.log 2>&1'; cat -; } | crontab -`
    宿主机时区是 `Asia/Shanghai`，而 cron 的时间字段**按宿主机时区解释**：只写 `30 19` 会在
    19:30 北京时间跑（= 11:30 UTC）。2026-09-24 首次安装正是这么写的，于是"每天自动备份"
    在装好之后一整天**一次都没触发**，09-25 才发现（`docs/pending-issues/68-*.md`）。
  - 怎么确认它真的在跑（`systemctl is-active crond` **证明不了这件事**）：
    `grep daily-backup /var/log/cron` 看触发记录、`ls -l /var/backups/zhurenweng/*.dump` 看产物、
    `tail -20 /var/log/zhurenweng-backup.log` 看 6 项校验是否全过。09-25 的实测：临时加一行
    `15 2 * * *` 走同一条代码路径，10:15:01 本地 = 02:15:01 UTC 触发，产物 1,234,520 字节、
    6 项计数全过，随后删掉临时行。
  - 手动补跑：`bash /opt/zhurenweng/deploy/daily-backup.sh`
  - **失败会发信**（issue #71）：脚本里挂的是**一条退出陷阱**（`set -e` 下命令失败同样会走它，
    所以不需要第二条 ERR 陷阱 —— 加了之后自证门当场判它"撤掉测试照样绿"，是多余的机制），
    失败时调 `scripts/alert-backup-failure.mjs`，复用 worker 的任务失败告警出口
    （收件人 ALERT_EMAIL；按 日历日 × 任务 去重，连续坏三天只发一封；告警自身失败也不影响退出码）。
    邮件内容带阶段名（导出 / 恢复校验 / 保留清理）与退出码，例如
    `每日数据库备份失败（阶段=恢复校验；退出码=1；「select count(*) from notices」线上 192 条 / 恢复后 191 条）`。
    注意它经 `docker compose run --rm worker` 发信，**用的是镜像里的代码**，
    改完这个脚本要 `docker compose build worker` 才算上线（见本文开头那条"同步 ≠ 部署"）
  - 为什么必须有：本文件先前只写了一条手工 `pg_dump`，实测结果就是**从没执行过** ——
    服务器上唯一一份备份停在 2026-09-20，比库旧 4 天且不含附件表（147 万字从未被备份）。
    同一类错误我在 09-24 又犯了一次（把"cron 装上了"当成"备份在跑"），所以这条写在前面：
    **写进文档的调度和写在 crontab 里的行，都要有一次真实触发的产物来证明。**
    卷 `db-data`、`meili-data`（含 `caddy-data` 的证书私钥）仍需整机快照，日备份不替代它
  - **仍是单点**：备份与库在同一块盘上。第二份副本要等托管/对象存储方案定了再加（异地一份
    拉不回本地：`workbench exec` 的输出通道不适合传 MB 级文件）
- **日志**：`docker compose logs -f caddy worker`
- **排障**：容器健康但域名不通时，先 `curl -I http://127.0.0.1:3000/`（绕过 Caddy 直连 web），
  再 `docker compose logs caddy`（证书失败多为 DNS 未生效或安全组未放行 80）

## 已知简化（可接受，未来按需加固）

- 数据库密码经内网连接，未启用 TLS
- Caddy 与 web 同机，未做双机高可用
- 证书签发未配置邮箱，故无到期提醒邮件（见第 5 节自行补）
