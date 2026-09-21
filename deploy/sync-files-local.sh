#!/bin/bash
# 增量把本地改动过的文件推到生产服务器（GitHub 不可用时的部署通道）。
#
# 背景：常规部署走 `deploy/deploy-*.sh`，它从 codeload.github.com 取源码包 ——
# 2026-09-21 起该账号被 GitHub 停用（codeload 与仓库页均 404），这条通道断了。
# 本脚本改用「本地文件 → base64 → workbench exec 写入服务器」的增量通道：
# 只传改动过的文件，逐文件校验 sha256，因此不受仓库可达性影响。
#
# 用法（在开发机仓库根目录）：
#   bash deploy/sync-files-local.sh src/db/repo/notices.ts tests/e2e/category-filter.test.mjs
#
# 注意：本脚本只负责传文件；传完仍需在服务器上重建镜像并重启：
#   workbench exec -i <实例> --timeout 600 -c "cd /opt/zhurenweng && nohup docker compose build web worker > /tmp/build.log 2>&1 &"
set -euo pipefail

INSTANCE="REDACTED_INSTANCE_ID"
REMOTE_ROOT="/opt/zhurenweng"

if [ "$#" -eq 0 ]; then
  echo "用法：bash deploy/sync-files-local.sh <相对路径> [<相对路径> …]" >&2
  exit 1
fi

for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "文件不存在：$file" >&2
    exit 1
  fi
  local_sum=$(python -c "
import hashlib,sys
print(hashlib.sha256(open(sys.argv[1],'rb').read().replace(b'\r\n',b'\n')).hexdigest())
" "$file")
  b64=$(python -c "
import base64,sys
data=open(sys.argv[1],'rb').read().replace(b'\r\n',b'\n')
print(base64.b64encode(data).decode())
" "$file")

  workbench exec -i "$INSTANCE" --timeout 300 -c \
    "mkdir -p \"\$(dirname '$REMOTE_ROOT/$file')\" && echo $b64 | base64 -d | tr -d '\r' > '$REMOTE_ROOT/$file' && sha256sum '$REMOTE_ROOT/$file' | cut -d' ' -f1" \
    > /tmp/zw-sync-out.txt 2>&1
  remote_sum=$(tail -1 /tmp/zw-sync-out.txt | tr -d '\r')

  if [ "$local_sum" != "$remote_sum" ]; then
    echo "校验失败：$file（本地 $local_sum / 服务器 $remote_sum）" >&2
    cat /tmp/zw-sync-out.txt >&2
    exit 1
  fi
  echo "已同步并校验：$file"
done

echo "全部同步完成。下一步在服务器上重建镜像并重启 web（见脚本头部注释）。"
