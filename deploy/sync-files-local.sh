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
# 传输编码：默认「文件 → gzip -9 → base64」，远端 `base64 -d | gzip -d` 还原。
# 为什么要压缩：单条 workbench exec 命令受 Windows 命令行长度上限（约 32KB）约束，
# base64 又放大 4/3 —— 源码超过约 24KB 就传不上去，且失败表现是 **exit 126 且无任何
# 输出**（2026-09-21 传 tests/e2e/category-filter.test.mjs 时踩到，白白怀疑了半天网络）。
# 文本文件 gzip 后通常缩到 1/4 上下，因此单条命令就够；万一压缩后仍超限，退化为
# 「原始 base64 分块 append」（每块独立可解码，最后一次性校验 sha256）。
#
# 注意：本脚本只负责传文件；传完仍需在服务器上重建镜像并重启：
#   workbench exec -i <实例> --timeout 600 -c "cd /opt/zhurenweng && nohup docker compose build web worker > /tmp/build.log 2>&1 &"
set -euo pipefail

INSTANCE="REDACTED_INSTANCE_ID"
REMOTE_ROOT="/opt/zhurenweng"
# 单条命令里 base64 载荷的字符上限（给命令模板与路径留余量）
MAX_CMD_CHARS=20000
# 分块大小（仅退化路径使用）
CHUNK_CHARS=8000

if [ "$#" -eq 0 ]; then
  echo "用法：bash deploy/sync-files-local.sh <相对路径> [<相对路径> …]" >&2
  exit 1
fi

# 在服务器上执行一条命令，输出落到 /tmp/zw-sync-out.txt（workbench 会吞掉开头若干行，故取末尾）
run_remote() {
  workbench exec -i "$INSTANCE" --timeout 300 -c "$1" > /tmp/zw-sync-out.txt 2>&1
}

for file in "$@"; do
  if [ ! -f "$file" ]; then
    echo "文件不存在：$file" >&2
    exit 1
  fi
  # 二进制文件（含 NUL 字节：PNG / ICO / gzip 等）**不能**做换行归一：
  # 压缩数据里可能恰好出现 0x0D 0x0A 字节对，归一化会静默改掉内容，而校验用的是
  # 同一套变换 —— 于是校验会通过、文件却是坏的（2026-09-21 传 issue #53 的三张
  # 品牌图时发现：og-image.png 有 1 处、favicon.ico 有 3 处 CRLF 字节对）。
  if python -c "import sys; sys.exit(0 if b'\x00' in open(sys.argv[1],'rb').read() else 1)" "$file"; then
    normalize=0
    echo "（二进制文件，按原始字节传输与校验）$file"
  else
    normalize=1
  fi
  local_sum=$(python -c "
import hashlib,sys
data=open(sys.argv[1],'rb').read()
if sys.argv[2]=='1': data=data.replace(b'\r\n',b'\n')
print(hashlib.sha256(data).hexdigest())
" "$file" "$normalize")
  b64gz=$(python -c "
import base64,gzip,sys
data=open(sys.argv[1],'rb').read()
if sys.argv[2]=='1': data=data.replace(b'\r\n',b'\n')
print(base64.b64encode(gzip.compress(data,9)).decode())
" "$file" "$normalize")

  if [ "${#b64gz}" -le "$MAX_CMD_CHARS" ]; then
    run_remote "mkdir -p \"\$(dirname '$REMOTE_ROOT/$file')\" && echo $b64gz | base64 -d | gzip -d > '$REMOTE_ROOT/$file'"
  else
    echo "载荷压缩后仍为 ${#b64gz} 字符，退化为分块传输：$file" >&2
    b64raw=$(python -c "
import base64,sys
data=open(sys.argv[1],'rb').read()
if sys.argv[2]=='1': data=data.replace(b'\r\n',b'\n')
print(base64.b64encode(data).decode())
" "$file" "$normalize")
    # 分块路径同样要按类型决定是否 `tr -d '\r'`：文本要（远端落地为 LF），二进制绝不能
    if [ "$normalize" -eq 1 ]; then
      strip_cr="tr -d '\\r'"
    else
      strip_cr='cat'
    fi
    total=${#b64raw}
    offset=0
    first=1
    while [ "$offset" -lt "$total" ]; do
      part=${b64raw:$offset:$CHUNK_CHARS}
      offset=$((offset + CHUNK_CHARS))
      if [ "$first" -eq 1 ]; then
        redirect='>'
        first=0
      else
        redirect='>>'
      fi
      run_remote "mkdir -p \"\$(dirname '$REMOTE_ROOT/$file')\" && echo $part | base64 -d | $strip_cr $redirect '$REMOTE_ROOT/$file'"
      echo "  …已传 $offset/$total 字符" >&2
    done
  fi

  run_remote "sha256sum '$REMOTE_ROOT/$file' | cut -d' ' -f1"
  remote_sum=$(tail -1 /tmp/zw-sync-out.txt | tr -d '\r')

  if [ "$local_sum" != "$remote_sum" ]; then
    echo "校验失败：$file（本地 $local_sum / 服务器 $remote_sum）" >&2
    cat /tmp/zw-sync-out.txt >&2
    exit 1
  fi
  echo "已同步并校验：$file"
done

echo "全部同步完成。下一步在服务器上重建镜像并重启 web（见脚本头部注释）。"
