#!/bin/bash
# 部署 issue #30（详情抓取失败不覆盖已入库详情层数据）：镜像同步 + 重建 web / worker
set -euo pipefail
cd /opt/zhurenweng
TMP=$(mktemp -d /tmp/deploy30.XXXXXX)

echo "=== 1. 取 codeload 源码包 ==="
curl -fsSL -o "$TMP/src.tar.gz" \
  "https://codeload.github.com/omeyb110674401-rgb/zhurenweng/tar.gz/refs/heads/main"
mkdir -p "$TMP/src"
tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" --strip-components=1
echo "解压完成：$(find "$TMP/src" -type f | wc -l) 个文件"

EXCLUDES=(--exclude=./.env --exclude=./.git --exclude=./node_modules --exclude=./.next --exclude=./data)

echo "=== 2. 清点两侧文件（排除 .env / 生成物） ==="
(cd "$TMP/src" && find . -type f \
  -not -path './.git/*' -not -path './node_modules/*' -not -path './.next/*' \
  -not -path './data/*' -not -name '.env' | sed 's|^\./||' | LC_ALL=C sort) > "$TMP/new.list"
find . -type f \
  -not -path './.git/*' -not -path './node_modules/*' -not -path './.next/*' \
  -not -path './data/*' -not -name '.env' | sed 's|^\./||' | LC_ALL=C sort > "$TMP/old.list"
echo "新包 $(wc -l < "$TMP/new.list") 个 / 线上 $(wc -l < "$TMP/old.list") 个"

echo "=== 3. 覆盖式同步 ==="
(cd "$TMP/src" && tar -cf - "${EXCLUDES[@]}" .) | tar -xf - -C /opt/zhurenweng
echo "=== 4. 删除上游已移除的文件（不动 .env） ==="
LC_ALL=C comm -13 "$TMP/new.list" "$TMP/old.list" > "$TMP/todel"
if [ -s "$TMP/todel" ]; then cat "$TMP/todel"; xargs -r -a "$TMP/todel" rm -f; else echo "（无）"; fi

echo "=== 5. 同步结果自检（issue #30 的改动都要在） ==="
grep -n "preserveStoredDetail" worker/jobs/crawl-notices.ts | head -3
grep -n "detailLoaded" worker/jobs/crawl-notices.ts | head -4
grep -n "本轮沿用已入库的详情数据" worker/jobs/crawl-notices.ts
ls -l tests/e2e/crawl-degradation.test.mjs
ls -l .env

echo "=== 6. 重建镜像（后台，日志 /tmp/build-30.log） ==="
nohup docker compose build web worker > /tmp/build-30.log 2>&1 &
echo "build pid=$!"
sleep 15
tail -2 /tmp/build-30.log
echo "SYNC_AND_BUILD_STARTED"
