#!/bin/bash
# 每日数据库备份 + 恢复校验（迭代 0，2026-09-24）
#
# 为什么必须有：这台机器之前唯一的 pg_dump 是 2026-09-20 的 `backup-pre-0008.sql`
# —— 比库旧 4 天，且早于 0009（附件表），也就是说 147 万字的附件抽取结果**从未被备份过**。
# 而源码也只有一份本地副本（GitHub 账号停用，63 个提交推不出去）。
# 一次云盘故障 = 业务数据与抽取结果全丢。
#
# 「备份没验证过 = 没有备份」：本脚本不是把文件写到盘上就算完，它每天把那份归档
# **真的恢复进一个临时库**，比对关键计数，对不上就非零退出（cron 的输出进日志，
# 失败会在第二天被看到）。只 `--list` 归档头是更弱的校验，这里要的是可恢复性。
#
# 安装（服务器上，一次性）。**`CRON_TZ=UTC` 这一行不能省**：宿主机时区是 Asia/Shanghai，
# 而 cron 的时间字段按宿主机时区解释 —— 只写 `30 19` 会在 19:30 **北京时间**跑（= 11:30 UTC），
# 与下面注释里写的时刻差 8 小时。2026-09-24 装的时候正是犯了这个错，第一次自动备份整整推迟了
# 一天多才被发现，过程与教训见 `docs/pending-issues/68-backup-cron-never-fired.md`。
#   crontab -l 2>/dev/null | { echo 'CRON_TZ=UTC'; echo '30 19 * * * /bin/bash /opt/zhurenweng/deploy/daily-backup.sh >> /var/log/zhurenweng-backup.log 2>&1'; cat -; } | crontab -
#   # 19:30 UTC = 北京时间次日 03:30，与抓取轮（约 13:45–14:5x UTC）错开十几个小时
#
# 装完怎么确认它真的会跑（别看 unit 状态，那只能证明调度器活着）：
#   grep daily-backup /var/log/cron          # 有没有触发记录
#   ls -l /var/backups/zhurenweng/*.dump     # 有没有产物
#   tail -20 /var/log/zhurenweng-backup.log  # 6 项计数校验是否全过
#
# 手动跑一次：bash deploy/daily-backup.sh
# 保留份数：KEEP（默认 7）—— 日备份 7 天足够覆盖「某天误操作 / 某天迁移跑坏」的回看窗口。
set -euo pipefail

ROOT="${ROOT:-/opt/zhurenweng}"
DEST="${DEST:-/var/backups/zhurenweng}"
KEEP="${KEEP:-7}"
DB=zhurenweng
DB_USER=zhurenweng
VERIFY_DB=zw_backup_verify

cd "$ROOT"
mkdir -p "$DEST"

STAMP=$(date -u +%Y-%m-%d-%H%M%S)
FILE="$DEST/zhurenweng-$STAMP.dump"

psql_db() { docker compose exec -T db psql -U "$DB_USER" -d "$1" -Atc "$2"; }

# ── 1. 导出（先写 .part 再改名：中途失败的半截文件不能被当成有效备份）────────
docker compose exec -T db pg_dump -U "$DB_USER" -Fc "$DB" > "$FILE.part"
mv "$FILE.part" "$FILE"

SIZE=$(stat -c %s "$FILE")
if [ "$SIZE" -lt 10240 ]; then
  echo "备份失败：归档只有 $SIZE 字节（小得不正常），不进入校验也不参与保留清理" >&2
  exit 1
fi

# ── 2. 恢复进临时库并比对计数 ────────────────────────────────────────────
# 每次重建这个库：上一次的残留会让恢复报「already exists」或让比对结果失真。
docker compose exec -T db dropdb -U "$DB_USER" --if-exists "$VERIFY_DB"
docker compose exec -T db createdb -U "$DB_USER" -T template0 -E UTF8 "$VERIFY_DB"
docker compose exec -T db pg_restore -U "$DB_USER" -d "$VERIFY_DB" --no-owner < "$FILE"

for query in \
  "select count(*) from notices" \
  "select count(*) from notices where ai_summary_json is not null" \
  "select count(*) from notice_attachments" \
  "select coalesce(sum(length(coalesce(extracted_text,''))),0) from notice_attachments" \
  "select count(*) from subscriptions" \
  "select count(*) from sources"; do
  live=$(psql_db "$DB" "$query")
  restored=$(psql_db "$VERIFY_DB" "$query")
  if [ "$live" != "$restored" ]; then
    echo "备份校验失败：「$query」线上 $live 条 / 恢复后 $restored 条" >&2
    exit 1
  fi
  echo "校验通过：$query ⇒ $live"
done

docker compose exec -T db dropdb -U "$DB_USER" "$VERIFY_DB"

# ── 3. 保留清理（只删命名符合本脚本产物形态的文件，不碰手工备份）────────────
ls -1t "$DEST"/zhurenweng-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "清理旧备份：$old"
done

echo "备份完成：$FILE（$SIZE 字节），已验证可恢复，保留最近 $KEEP 份"
