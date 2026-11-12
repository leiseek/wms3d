#!/usr/bin/env bash
# 备份（08 §6，D37）：pg_dump -Fc → <dir>/<db>-<UTC>.dump（权限 600）+ .sha256 + .json 清单；可选 GPG 加密；
# 本地保留 N 日 + M 周；可选 rclone 异地拷贝（BACKUP_REMOTE，脚本不内置任何外部服务）；写 ops_status['backup'] 供看板显示。
# 用法：backup.sh --db <name> [--dir <dir>] [--no-status] [--no-prune]
# 环境：BACKUP_DIR、BACKUP_RETAIN_DAILY(14)、BACKUP_RETAIN_WEEKLY(8)、BACKUP_GPG_RECIPIENT、BACKUP_REMOTE、BACKUP_RCLONE(rclone)
#       BACKUP_CONFIG=<env 文件>（生产：/opt/wms3d/etc/backup.env）；PGHOST/PGPORT/PGUSER
# 输出：最后一行 stdout 为备份文件路径。退出码：0 成功；1 失败；3 本地成功但异地拷贝失败。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-lib.sh
source "$DIR/backup-lib.sh"

DB="${BACKUP_DB:-}"; OUT="${BACKUP_DIR:-}"; STATUS=1; PRUNE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2;;
    --dir) OUT="$2"; shift 2;;
    --no-status) STATUS=0; shift;;
    --no-prune) PRUNE=0; shift;;
    -h|--help) sed -n '2,9p' "$0"; exit 0;;
    *) die "未知参数：$1";;
  esac
done
[ -n "$DB" ] || die "缺少 --db"
guard_db "$DB"
OUT="${OUT:-/workspace/wms3d-artifacts/backups/$DB}"
DAILY="${BACKUP_RETAIN_DAILY:-14}"; WEEKLY="${BACKUP_RETAIN_WEEKLY:-8}"
umask 077
mkdir -p "$OUT"

TS="$(utc_ts)"
FILE="$OUT/$DB-$TS.dump"
TMP="$FILE.partial"
trap 'rm -f "$TMP" "$TMP.gpg"' EXIT
log "开始备份 $DB → $FILE"
START=$(date +%s)
"$PG_DUMP" -Fc -Z 6 --no-password -d "$DB" -f "$TMP"
# 自检：能列出目录即说明归档完整可读
"$PG_RESTORE" -l "$TMP" >/dev/null || die "备份文件自检失败（pg_restore -l）"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always -r "$BACKUP_GPG_RECIPIENT" -o "$TMP.gpg" -e "$TMP"
  rm -f "$TMP"; FILE="$FILE.gpg"; mv "$TMP.gpg" "$FILE"
else
  mv "$TMP" "$FILE"
fi
chmod 600 "$FILE"
SHA="$(sha256sum "$FILE" | cut -d' ' -f1)"
echo "$SHA  $(basename "$FILE")" > "$FILE.sha256"
SIZE=$(stat -c %s "$FILE")
SERVER_VER="$(q "$DB" 'SHOW server_version')"
MIG="$(q "$DB" "SELECT COALESCE(max(created_at)::text,'') FROM drizzle.__drizzle_migrations" 2>/dev/null || echo '')"
cat > "$FILE.json" <<JSON
{"database":"$DB","file":"$(basename "$FILE")","createdAt":"$(date -u +%FT%TZ)","bytes":$SIZE,"sha256":"$SHA","encrypted":$([ -n "${BACKUP_GPG_RECIPIENT:-}" ] && echo true || echo false),"serverVersion":"$SERVER_VER","lastMigration":"$MIG","seconds":$(( $(date +%s) - START ))}
JSON
chmod 600 "$FILE.sha256" "$FILE.json"
log "本地备份完成：$SIZE 字节，sha256 $SHA"

# 保留策略见 backup-lib.sh prune_backups：最近 DAILY 个日期各保留最新一份 + 最近 WEEKLY 个 ISO 周各保留最新一份；其余删除（只删本库、本目录下的 .dump[.gpg] 及其旁文件）
[ "$PRUNE" = 1 ] && prune_backups "$OUT" "$DB" "$DAILY" "$WEEKLY"

# 异地拷贝（上线签字阻断项，08 §6）：只在配置了 BACKUP_REMOTE 时执行
RC=0; REMOTE_AT=null; REMOTE_CONFIGURED=false
if [ -n "${BACKUP_REMOTE:-}" ]; then
  REMOTE_CONFIGURED=true
  RCLONE="${BACKUP_RCLONE:-rclone}"
  if command -v "$RCLONE" >/dev/null 2>&1 && "$RCLONE" copy --no-traverse "$FILE" "$BACKUP_REMOTE" \
      && "$RCLONE" copy --no-traverse "$FILE.sha256" "$BACKUP_REMOTE"; then
    REMOTE_AT="\"$(date -u +%FT%TZ)\""; log "异地拷贝完成 → $BACKUP_REMOTE"
  else
    RC=3; log "异地拷贝失败（$BACKUP_REMOTE）——看板将显示红色警告，golive-check 不通过"
  fi
else
  log "警告：未配置 BACKUP_REMOTE，备份与数据同盘（上线前必须配置，scripts/golive-check.sh）"
fi

if [ "$STATUS" = 1 ]; then
  # 与 ws-a2 看板读取的 ops_status['backup'] 一致：{lastLocalAt,lastRemoteAt,remoteConfigured}；本次异地失败/未配置时保留上次异地成功时间
  NOW="$(date -u +%FT%TZ)"
  REMOTE_SQL=NULL; [ "$REMOTE_AT" != null ] && REMOTE_SQL="'$NOW'"
  q "$DB" "INSERT INTO ops_status (key, value, updated_at) VALUES ('backup', jsonb_build_object(
      'lastLocalAt', '$NOW', 'lastRemoteAt', $REMOTE_SQL::text, 'remoteConfigured', $REMOTE_CONFIGURED,
      'lastFile', '$(basename "$FILE")', 'lastRemoteOk', $( [ $RC = 0 ] && [ "$REMOTE_CONFIGURED" = true ] && echo true || echo false)), now())
    ON CONFLICT (key) DO UPDATE SET updated_at = now(), value = EXCLUDED.value ||
      CASE WHEN EXCLUDED.value->>'lastRemoteAt' IS NULL
           THEN jsonb_build_object('lastRemoteAt', ops_status.value->'lastRemoteAt') ELSE '{}'::jsonb END" >/dev/null \
    || log "警告：写 ops_status 失败（不影响备份文件）"
fi
echo "$FILE"
exit $RC
