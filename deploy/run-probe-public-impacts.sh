#!/bin/sh
# Read-only probe launcher (issue #86 §13): mount the un-deployed source files
# into a throwaway worker container and run the probe. Writes NOTHING to the
# database and NOTHING into /opt/zhurenweng (mounts are read-only, sources come
# from /tmp/zw-probe). Output goes to /tmp/zw-probe/out.txt.
#
# 这份挂载清单是个**维护面**：探针的 import 变了，清单就得跟着变 ——
# 漏挂的表现是硬失败（`does not provide an export named …`），不是静默跑旧代码，
# 所以还算好查。2026-09-27 就漏了一次 `attachment-select.ts`（第十六节加了新导出）。
cd /opt/zhurenweng || exit 1
MOUNTS=""
for f in \
  scripts/probe-public-impacts.mjs \
  src/lib/attachment-select.ts \
  src/lib/attachment-feed.ts \
  src/lib/ports.ts \
  src/lib/summary-display.ts \
  src/lib/summary-diagnostics.ts \
  src/lib/summary-content.ts \
  src/lib/change-coverage.ts \
  src/lib/audience.ts \
  src/lib/adapters/openai-compatible-llm.ts \
  src/db/repo/summaries.ts \
  worker/jobs/summarize-notices.ts
do
  MOUNTS="$MOUNTS -v /tmp/zw-probe/$f:/app/$f:ro"
done
rm -f /tmp/zw-probe/out.txt
# 参数透传（`sh run-probe-public-impacts.sh --id 954dcc17`）：不透传的话"点名复核"会变成
# 又跑一遍全量 —— 那是真实的模型调用，不是免费的（第一次就这么多发起了三条，当场掐掉）
ARGS="$*"
[ -z "$ARGS" ] && ARGS="--limit 3"
nohup docker compose run --rm $MOUNTS worker node scripts/probe-public-impacts.mjs $ARGS > /tmp/zw-probe/out.txt 2>&1 &
echo "started pid $! with args: $ARGS"
