#!/bin/bash
# 部署 issue #32（无词元查询不再返回全库）：镜像同步 + 重建 web / worker 镜像
set -euo pipefail
cd /opt/zhurenweng
TMP=$(mktemp -d /tmp/deploy32.XXXXXX)

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

echo "=== 5. 同步结果自检（issue #32 的改动都要在） ==="
grep -n "export function hasSearchableQuery" src/lib/search/search-text.ts
grep -n "hasSearchableQuery" src/lib/search/meilisearch-search.ts src/lib/search/local-search.ts src/app/search/page.tsx
grep -n "fetchImpl" src/lib/search/meilisearch-search.ts | head -3
grep -n "search-unusable-query" src/app/search/page.tsx
ls -l tests/unit/search-query.test.mjs
ls -l .env

echo "=== 6. 重建镜像（后台，日志 /tmp/build-32.log） ==="
nohup docker compose build web worker > /tmp/build-32.log 2>&1 &
echo "build pid=$!"
sleep 15
tail -2 /tmp/build-32.log
echo "SYNC_AND_BUILD_STARTED"
