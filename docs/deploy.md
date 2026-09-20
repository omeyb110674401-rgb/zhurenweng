# 部署手册（issue #13：国内云 + ICP 备案后上线）

适用：阿里云 ECS（Ubuntu 22.04/24.04），单机 Docker Compose 编排（web / worker / PostgreSQL / Meilisearch）。
开发机无 Docker，本地验收以 `npm run e2e` 为准（见 docs/adr/0001-local-dev-without-docker.md）。

## 0. 前置条件

- ECS：2 核 4G 起步、系统盘 ≥40G、**购买时长 ≥3 个月**（备案要求）、有公网 IP、Ubuntu 22.04/24.04
- 安全组：放行 `22`（建议限本人 IP）、`80`、`443`
- 域名已完成 **ICP 备案**并解析到该公网 IP（未备案域名不可解析到大陆服务器）

## 1. 服务器装 Docker

```bash
ssh root@<公网IP>
curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun
systemctl enable --now docker
docker version && docker compose version
```

镜像加速（可选，控制台获取专属地址后写入 `/etc/docker/daemon.json` 并 `systemctl restart docker`）。

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

必填清单：`POSTGRES_PASSWORD`、`SITE_URL`、`APP_BASE_URL`、`GLM_API_KEY`、
`SMTP_HOST/PORT/USER/PASS/SECURE`、`MAIL_FROM`、`MEILI_MASTER_KEY`、`ADMIN_TOKEN`、`ALERT_EMAIL`。

## 4. 启动

```bash
docker compose up -d --build
docker compose ps          # 四服务应为 running / healthy
docker compose logs -f web worker --tail=50
```

## 5. 冒烟检查（备案通过、域名解析生效后）

```bash
curl -s -o /dev/null -w "home %{http_code}\n" https://<域名>/
curl -s -o /dev/null -w "feed %{http_code}\n" https://<域名>/feed.xml
curl -s -o /dev/null -w "admin %{http_code}\n" https://<域名>/admin        # 未带 token 应为 401
curl -s "https://<域名>/feed.xml" | head -20
```

首次抓取（手动跑一轮，之后由 worker 周期任务接管）：

```bash
docker compose run --rm -e WORKER_ONCE=1 worker npm run worker
```

## 6. 上线后核查

- 页脚备案号展示正确；订阅页隐私说明可见（仅存邮箱、可一键退订）
- AI 摘要显著标注「AI 生成，仅供参考，以官方原文为准」
- 管理后台看板：各源最近成功时间非空；配置 `ALERT_EMAIL` 后人为触发一次失败应收到告警
- 出站按钮 `/go/<id>` 正常 302 到官方原文（北极星指标埋点）

## 7. 日常运维

- **更新**：`git pull`（或重传 tar 包）→ `docker compose up -d --build`
- **备份**：卷 `db-data`、`meili-data`；`docker compose exec db pg_dump -U zhurenweng zhurenweng > backup.sql`
- **日志**：`docker compose logs -f worker`
- **HTTPS**：可用阿里云免费证书或 certbot 挂载到反代；如需 Nginx 反代另行添加

## 已知简化（可接受，未来按需加固）

- 迁移在 web/worker 启动时各自执行（首次并发启动有理论竞态）
- 数据库密码经内网连接，未启用 TLS
- `docker-compose.yml` 未含反向代理与证书自动续期
