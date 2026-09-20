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

## 2. 获取代码（二选一）

**A. 服务器直接克隆**（网络通时最简）
```bash
git clone https://github.com/omeyb110674401-rgb/zhurenweng.git /opt/zhurenweng
```

**B. 本机打包上传**（GitHub 慢时推荐；在开发机 Git Bash 执行）
```bash
cd /d/Projects
tar --exclude=node_modules --exclude=.next --exclude=.git --exclude=data -czf zhurenweng.tar.gz zhurenweng
scp zhurenweng.tar.gz root@<公网IP>:/opt/
ssh root@<公网IP> "mkdir -p /opt/zhurenweng && tar -xzf /opt/zhurenweng.tar.gz -C /opt --strip-components=1"
```

## 3. 配置环境变量

```bash
cd /opt/zhurenweng
cp .env.example .env
vim .env   # 按模板逐项填写；POSTGRES_PASSWORD/MEILI_MASTER_KEY/ADMIN_TOKEN 换成强随机值
```

大模型服务商可切换（PRD「通过环境变量可切换服务商」）：默认 `LLM_PROVIDER=glm` 走智谱预设
（只填 `GLM_API_KEY`）；换任何 OpenAI 兼容端点则设 `LLM_PROVIDER=openai` 并填 `LLM_API_KEY` /
`LLM_API_BASE` / `LLM_MODEL`（可另加 `LLM_EXTRA_HEADERS`）。**对外提供生成式 AI 服务的模型须为
已备案的国产模型**（PRD 第 49 条），不要指向境外聚合服务。

必填清单：`POSTGRES_PASSWORD`、`DOMAIN`、`SITE_URL`、`APP_BASE_URL`、`GLM_API_KEY`、
`SMTP_HOST/PORT/USER/PASS/SECURE`、`MAIL_FROM`、`MEILI_MASTER_KEY`、`ADMIN_TOKEN`、`ALERT_EMAIL`、
`ICP_NUMBER`（备案号，展示在首页/搜索页页脚并链接工信部备案系统）。

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
- 管理后台看板：各源最近成功时间非空；配置 `ALERT_EMAIL` 后人为触发一次失败应收到告警
- 出站按钮 `/go/<id>` 正常 302 到官方原文（北极星指标埋点）

## 8. 日常运维

- **更新**：重新获取代码（`git pull` 或重传 tar 包）→ `docker compose up -d --build`
- **备份**：卷 `db-data`、`meili-data`（`caddy-data` 建议一并备份，含证书私钥）；
  `docker compose exec db pg_dump -U zhurenweng zhurenweng > backup.sql`
- **日志**：`docker compose logs -f caddy worker`
- **排障**：容器健康但域名不通时，先 `curl -I http://127.0.0.1:3000/`（绕过 Caddy 直连 web），
  再 `docker compose logs caddy`（证书失败多为 DNS 未生效或安全组未放行 80）

## 已知简化（可接受，未来按需加固）

- 数据库密码经内网连接，未启用 TLS
- Caddy 与 web 同机，未做双机高可用
- 证书签发未配置邮箱，故无到期提醒邮件（见第 5 节自行补）
