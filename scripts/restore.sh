#!/usr/bin/env bash
# 恢复（08 §6）：<dump> → 一次性库（缺省新建 t_<ws>_restore_<rand> / 生产 wms_restore_<rand>）→ 全量对账 → 报告。
# 不会覆盖已有非空库；切换生产库是人工步骤（见 infra/RUNBOOK.md §5）。
# 用法：restore.sh <file.dump[.gpg]> [--target <db>] [--keep] [--report <file.json>]
#   --keep    保留恢复库（缺省对账后删除）
# 退出码：0 恢复且对账通过；1 失败；4 恢复成功但对账发现差异。stdout 最后一行：对账 JSON。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=backup-lib.sh
source "$DIR/backup-lib.sh"

FILE=""; TARGET=""; KEEP=0; REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2;;
    --keep) KEEP=1; shift;;
    --report) REPORT="$2"; shift 2;;
    -h|--help) sed -n '2,7p' "$0"; exit 0;;
    -*) die "未知参数：$1";;
    *) FILE="$1"; shift;;
  esac
done
[ -f "$FILE" ] || die "备份文件不存在：$FILE"
if [ -f "$FILE.sha256" ]; then
  (cd "$(dirname "$FILE")" && sha256sum -c --quiet "$(basename "$FILE").sha256") || die "sha256 校验失败：$FILE"
  log "sha256 校验通过"
else
  log "警告：缺少 $FILE.sha256，跳过完整性校验"
fi
TARGET="${TARGET:-$(scratch_name)}"
guard_db "$TARGET"
SRC="$FILE"; TMPD=""
cleanup() { [ -n "$TMPD" ] && rm -rf "$TMPD"; return 0; }
trap cleanup EXIT
if [[ "$FILE" == *.gpg ]]; then
  TMPD="$(mktemp -d)"; chmod 700 "$TMPD"; SRC="$TMPD/restore.dump"
  gpg --batch --yes -o "$SRC" -d "$FILE"
fi

EXISTS="$(q postgres "SELECT 1 FROM pg_database WHERE datname='$TARGET'")"
CREATED=0
if [ -n "$EXISTS" ]; then
  TABLES="$(q "$TARGET" "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
  [ "$TABLES" = 0 ] || die "目标库 $TARGET 已存在且非空（$TABLES 张表），拒绝覆盖"
else
  q postgres "CREATE DATABASE $TARGET OWNER wms_owner" >/dev/null
  CREATED=1
fi
START=$(date +%s)
log "恢复 $(basename "$FILE") → $TARGET"
if ! "$PG_RESTORE" --exit-on-error --no-password -d "$TARGET" "$SRC"; then
  if [ "$CREATED" = 1 ] && [ "$KEEP" != 1 ]; then q postgres "DROP DATABASE IF EXISTS $TARGET WITH (FORCE)" >/dev/null; fi
  die "pg_restore 失败"
fi
# 运行时角色可连接（与 dev-db.sh create 一致）
q "$TARGET" "GRANT CONNECT ON DATABASE $TARGET TO wms_app" >/dev/null || true
SECS=$(( $(date +%s) - START ))
JSON="$("$PSQL" -v ON_ERROR_STOP=1 -qAtX -d "$TARGET" -f "$DIR/reconcile.sql")"
BAD="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(Object.values(j.checks).reduce((a,b)=>a+Number(b),0))' "$JSON")"
OUTJSON="$(node -e 'const j=JSON.parse(process.argv[1]);j.restoreSeconds=Number(process.argv[2]);j.source=process.argv[3];j.kept=process.argv[4]==="1";console.log(JSON.stringify(j))' "$JSON" "$SECS" "$(basename "$FILE")" "$KEEP")"
[ -n "$REPORT" ] && { echo "$OUTJSON" > "$REPORT"; chmod 600 "$REPORT"; }
log "恢复耗时 ${SECS}s；对账问题数 $BAD"
if [ "$CREATED" = 1 ] && [ "$KEEP" != 1 ]; then q postgres "DROP DATABASE IF EXISTS $TARGET WITH (FORCE)" >/dev/null; log "已删除恢复库 $TARGET"; elif [ "$KEEP" = 1 ]; then log "保留恢复库 $TARGET"; fi
echo "$OUTJSON"
[ "$BAD" = 0 ] || exit 4
