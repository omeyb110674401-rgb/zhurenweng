#!/usr/bin/env bash
# 在**生产服务器上**执行：把一份 KEY=VALUE 清单幂等地写进 /opt/zhurenweng/.env。
#
# 为什么不手工 `echo K=V >> .env`：
#  - 同名键出现两次时 compose 取**最后一次**，手改容易留下「旧值在前、新值在后」的
#    迷惑现场（排查时看第一行会得出反的结论）。这里先删后加，任何键在文件里只有一行。
#  - .env 装着数据库口令、检索主密钥与后台令牌，改动前自动备份并收紧到 600。
#  - 收尾必过 `docker compose config --quiet`：compose 用 ${VAR:?} 声明了必填项，
#    手抖写坏当场报错，而不是下次 `up` 时才发现站点起不来。
#
# 密钥走文件 / stdin，不走命令行参数：命令行会进 shell history、云助手的命令记录
# （控制台里可查、明文）和会话日志。
#
# 用法（在服务器上）：
#   bash deploy/set-env-keys.sh /tmp/keys.txt
#   printf 'SMTP_PASS=%s\n' "$secret" | bash deploy/set-env-keys.sh -
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/zhurenweng/.env}"
SRC="${1:?用法：bash deploy/set-env-keys.sh <KEY=VALUE 清单文件>（- 表示从 stdin 读）}"

TMP_KEYS=$(mktemp)
trap 'rm -f "$TMP_KEYS"' EXIT

if [ "$SRC" = "-" ]; then
  cat > "$TMP_KEYS"
else
  [ -f "$SRC" ] || { echo "清单文件不存在：$SRC" >&2; exit 1; }
  cp "$SRC" "$TMP_KEYS"
fi
chmod 600 "$TMP_KEYS"

# 收集键名并校验形状（值一律不打印）
KEY_NAMES=()
n=0
while IFS= read -r line || [ -n "$line" ]; do
  n=$((n + 1))
  line=${line%$'\r'}
  case "$line" in ''|\#*) continue ;; esac
  if ! printf '%s' "$line" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*='; then
    echo "清单第 ${n} 行不是 KEY=VALUE 形状（KEY 只允许字母数字下划线）" >&2
    exit 1
  fi
  KEY_NAMES+=("${line%%=*}")
done < "$TMP_KEYS"

[ "${#KEY_NAMES[@]}" -gt 0 ] || { echo "清单里没有任何 KEY=VALUE 行" >&2; exit 1; }

# compose 的 .env 解析里 `$` 是变量引用起点：口令带 `$` 会被静默改写，这里直接拒绝
while IFS= read -r line; do
  case "$line" in ''|\#*) continue ;; esac
  case "${line#*=}" in *\$*) echo "值里含 \$（键 ${line%%=*}）：compose 会把它当变量引用展开，请换掉该字符" >&2; exit 1 ;; esac
done < "$TMP_KEYS"

STAMP=$(date +%Y%m%d-%H%M%S)
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak-${STAMP}"
  chmod 600 "${ENV_FILE}.bak-${STAMP}"
  echo "已备份：${ENV_FILE}.bak-${STAMP}"
fi

# 先删同名旧行，再把新行追加到文件末尾
PATTERN=$(IFS='|'; printf '^(%s)=' "${KEY_NAMES[*]}")
grep -Ev "$PATTERN" "$ENV_FILE" > "${ENV_FILE}.tmp" || true
cat "${ENV_FILE}.tmp" > "$ENV_FILE"
rm -f "${ENV_FILE}.tmp"
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in ''|\#*) continue ;; esac
  key=${line%%=*}
  val=${line#*=}
  printf '%s\n' "$line" >> "$ENV_FILE"
  printf '已写入 %s（值长度 %s）\n' "$key" "${#val}"
done < "$TMP_KEYS"

chmod 600 "$ENV_FILE"

cd "$(dirname "$ENV_FILE")"
if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
  docker compose config --quiet && echo "COMPOSE-CONFIG-OK（必填项与插值均通过）"
else
  echo "跳过 docker compose config 校验（本机无 docker 或不在 compose 项目目录）" >&2
fi
