#!/bin/bash
# 端到端验证（issue #23）：证明「.env 里填 GLM_API_KEY」真的会到容器并改变界面状态。
# 只重建 web（worker 不动，避免用哑 Key 触发真实摘要任务、污染重试计数）。
# 哑值仅用于链路验证，脚本结束（含异常）一定会还原 .env 并重建 web。
set -uo pipefail
cd /opt/zhurenweng
URL=http://127.0.0.1:3000/notices/ba2c483c3bfefe37
BAK=/tmp/env.bak23
cp .env "$BAK"

restore() {
  cp "$BAK" .env
  chmod 600 .env
  docker compose up -d web >/dev/null 2>&1
  sleep 8
  echo "=== 已还原 .env（GLM_API_KEY 复空）并重建 web ==="
  echo -n "容器内 GLM_API_KEY 长度（1 = 空）: "
  docker compose exec -T web printenv GLM_API_KEY | wc -c
  echo -n "摘要区标记: "
  curl -sS -m 20 "$URL" | grep -o 'data-testid="summary-[a-z-]*"' | sort -u | tr '\n' ' '
  echo
  echo -n ".env 权限: "; ls -l .env | awk '{print $1}'
}
trap restore EXIT

echo "=== 1. 临时填入哑 Key（仅为验证链路，不是真 Key） ==="
sed -i 's|^GLM_API_KEY=.*|GLM_API_KEY=plumbing-check-not-a-real-key|' .env
grep -c '^GLM_API_KEY=plumbing-check-not-a-real-key$' .env
docker compose up -d web 2>&1 | tail -2
sleep 10

echo "=== 2. 容器是否拿到哑 Key（长度应为 1 + 29） ==="
docker compose exec -T web printenv GLM_API_KEY | wc -c

echo "=== 3. 界面状态是否随之变化（应出现 summary-placeholder「生成中」） ==="
curl -sS -m 20 "$URL" | grep -o 'data-testid="summary-[a-z-]*"' | sort -u | tr '\n' ' '
echo
echo "=== 4. 恢复到第 1 步之前的预期：见下方 restore 输出 ==="
