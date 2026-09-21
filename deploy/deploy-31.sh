#!/bin/bash
# 部署 issue #31（搜索结果如实报总数 + 分页）：镜像同步 + 重建 web / worker 镜像
set -euo pipefail
cd /opt/zhurenweng
TMP=$(mktemp -d /tmp/deploy31.XXXXXX)

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

echo "=== 5. 同步结果自检（issue #31 的改动都要在） ==="
grep -n "SEARCH_DEFAULT_PER_PAGE" src/lib/ports.ts
grep -n "totalHits" src/lib/search/meilisearch-search.ts
grep -n "count(\*) AS total" src/lib/search/local-search.ts
grep -n "SEARCH_PAGE_SIZE" src/app/search/page.tsx
grep -n "search-pagination" src/app/search/page.tsx | head -3
ls -l tests/e2e/search-pagination.test.mjs
ls -l .env

echo "=== 6. 重建镜像（后台，日志 /tmp/build-31.log） ==="
nohup docker compose build web worker > /tmp/build-31.log 2>&1 &
echo "build pid=$!"
sleep 15
tail -2 /tmp/build-31.log
echo "SYNC_AND_BUILD_STARTED"
