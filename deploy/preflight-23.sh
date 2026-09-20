#!/bin/bash
# 部署前核查（issue #23）：确认线上 compose 就是旧 bug、且没有仓库外手改
set -uo pipefail
cd /opt/zhurenweng || exit 1
echo "=== 1. 当前 compose 的 LLM 变量行（应为旧 bug：LLM_API_KEY） ==="
grep -n 'LLM_API_KEY\|GLM_API_KEY' docker-compose.yml || echo "(未匹配)"
echo
echo "=== 2. 仓库外手改检查：近 7 天被改动的非生成物文件 ==="
find . -type f -newermt '-7 days' \
  -not -path './node_modules/*' -not -path './.next/*' -not -path './data/*' \
  -not -path './.git/*' -not -path './fixtures/*' 2>/dev/null | head -20
echo
echo "=== 3. 运行中的服务 ==="
docker compose ps --format '{{.Service}}  {{.Status}}' 2>&1 | head -10
echo
echo "=== 4. .env 权限与关键项是否已填（只看有没有值） ==="
ls -l .env
awk -F= '/^(GLM_API_KEY|SMTP_HOST|MAIL_FROM|WORKER_INTERVAL_MS)=/{v=substr($0,index($0,"=")+1); print $1 (length(v)>0 ? "=SET" : "=EMPTY")}' .env
echo
echo "=== 5. 站点容器当前拿到的 LLM 相关环境变量名（不含值） ==="
docker compose exec -T web printenv 2>/dev/null | grep -oE '^(GLM|LLM)[A-Z_]*' | sort -u || echo "(exec 失败)"
