#!/usr/bin/env bash
# 备份 → 恢复 → 对账 演练（ws-f 验收；08 §6 RTO ≤ 1h）。只读源库，恢复到一次性库，结束删除。
#  1. 源库逐表指纹（行数 + 有序内容 md5）与对账
#  2. backup.sh（--no-status，避免改动源库导致指纹漂移）
#  3. restore.sh --keep → 恢复库逐表指纹，必须与源库完全一致；对账必须 0 问题
#  4. 权限复核：wms_app 能读、不能改台账（REVOKE 随备份恢复）
#  5. 反向对照：在恢复库人为制造一处台账/余额不一致，对账必须报出（证明检查有效）
# 用法：backup-drill.sh [--db <源库，缺省 .env.local 的库>] [--report-dir <dir>]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
if [ -f "$ROOT/.env.local" ] && [ -z "${WMS_WS:-}" ]; then
  # shellcheck disable=SC1091
  set -a; source "$ROOT/.env.local"; set +a
fi
# shellcheck source=backup-lib.sh
source "$DIR/backup-lib.sh"

SRC_DB="${DATABASE_URL##*/}"; REPORT_DIR="/workspace/wms3d-artifacts/ci"
while [ $# -gt 0 ]; do
  case "$1" in
    --db) SRC_DB="$2"; shift 2;;
    --report-dir) REPORT_DIR="$2"; shift 2;;
    *) die "未知参数：$1";;
  esac
done
guard_db "$SRC_DB"
TS="$(utc_ts)"
WORK="$(mktemp -d "/tmp/wms3d-drill-${SRC_DB}-XXXX")"; chmod 700 "$WORK"
SCRATCH="$(scratch_name)"
cleanup() {
  q postgres "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$REPORT_DIR"

fingerprint() {
  local db="$1" t
  for t in $(q "$db" "SELECT quote_ident(schemaname)||'.'||quote_ident(tablename) FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY 1"); do
    echo "$t $(q "$db" "SELECT count(*)||' '||md5(COALESCE(string_agg(x::text, E'\n' ORDER BY x::text), '')) FROM $t x")"
  done
}

T0=$(date +%s)
log "① 源库 $SRC_DB 指纹与对账"
fingerprint "$SRC_DB" > "$WORK/src.fp"
SRC_REC="$("$PSQL" -v ON_ERROR_STOP=1 -qAtX -d "$SRC_DB" -f "$DIR/reconcile.sql")"

log "② 备份"
DUMP="$(BACKUP_REMOTE='' "$DIR/backup.sh" --db "$SRC_DB" --dir "$WORK/backups" --no-status --no-prune | tail -1)"

log "③ 恢复到 $SCRATCH 并对账"
set +e
REST_JSON="$("$DIR/restore.sh" "$DUMP" --target "$SCRATCH" --keep | tail -1)"; REST_RC=$?
set -e
[ "$REST_RC" = 0 ] || die "restore.sh 退出码 $REST_RC：$REST_JSON"
fingerprint "$SCRATCH" > "$WORK/dst.fp"
if diff -u "$WORK/src.fp" "$WORK/dst.fp" > "$WORK/fp.diff"; then FP_OK=true; else FP_OK=false; fi
TABLES=$(wc -l < "$WORK/src.fp")
ROWS=$(awk '{s+=$2} END {print s+0}' "$WORK/src.fp")

log "④ 权限复核（wms_app）"
PERM_READ=false; PERM_LEDGER_LOCKED=false
"$PSQL" -qAtX -U wms_app -d "$SCRATCH" -c "SELECT count(*) FROM locations" >/dev/null 2>&1 && PERM_READ=true
if ! "$PSQL" -qAtX -U wms_app -d "$SCRATCH" -c "UPDATE stock_movements SET qty_delta = qty_delta WHERE false" >/dev/null 2>&1; then PERM_LEDGER_LOCKED=true; fi

log "⑤ 反向对照：制造一处余额漂移"
HAS_BAL="$(q "$SCRATCH" "SELECT count(*) FROM stock_balances")"
if [ "$HAS_BAL" -gt 0 ]; then
  q "$SCRATCH" "UPDATE stock_balances SET on_hand = on_hand + 1 WHERE ctid = (SELECT ctid FROM stock_balances LIMIT 1)" >/dev/null
else
  q "$SCRATCH" "INSERT INTO stock_balances (warehouse_id, location_id, sku_id, on_hand)
                SELECT l.warehouse_id, l.id, (SELECT id FROM skus ORDER BY code LIMIT 1), 1 FROM locations l ORDER BY l.code LIMIT 1" >/dev/null
fi
NEG="$("$PSQL" -v ON_ERROR_STOP=1 -qAtX -d "$SCRATCH" -f "$DIR/reconcile.sql")"
NEG_DETECTED="$(node -e 'console.log(JSON.parse(process.argv[1]).checks.ledger_mismatch>0)' "$NEG")"
TOTAL=$(( $(date +%s) - T0 ))

REST_OK="$(node -e 'const j=JSON.parse(process.argv[1]);console.log(Object.values(j.checks).every(v=>Number(v)===0))' "$REST_JSON")"
PASS=false
[ "$FP_OK" = true ] && [ "$REST_OK" = true ] && [ "$PERM_READ" = true ] && [ "$PERM_LEDGER_LOCKED" = true ] && [ "$NEG_DETECTED" = true ] && PASS=true
REPORT="$REPORT_DIR/backup-drill-$SRC_DB-$TS.json"
node -e '
const [src, rest, neg, fp, tables, rows, pr, pl, nd, total, pass, dump, bytes] = process.argv.slice(1);
console.log(JSON.stringify({ kind: "backup-drill", source: JSON.parse(src), restored: JSON.parse(rest),
  fingerprintsEqual: fp === "true", tables: +tables, rows: +rows,
  permissions: { appCanRead: pr === "true", appLedgerReadOnly: pl === "true" },
  negativeControlDetected: nd === "true", negativeControl: JSON.parse(neg).checks,
  dumpFile: dump, dumpBytes: +bytes, totalSeconds: +total, rtoTargetSeconds: 3600, pass: pass === "true" }, null, 2));
' "$SRC_REC" "$REST_JSON" "$NEG" "$FP_OK" "$TABLES" "$ROWS" "$PERM_READ" "$PERM_LEDGER_LOCKED" "$NEG_DETECTED" "$TOTAL" "$PASS" "$(basename "$DUMP")" "$(stat -c %s "$DUMP")" > "$REPORT"
[ "$FP_OK" = true ] || { echo "指纹差异：" >&2; cat "$WORK/fp.diff" >&2; }
log "演练报告：$REPORT"
echo "backup-drill: pass=$PASS 表=$TABLES 行=$ROWS 指纹一致=$FP_OK 对账通过=$REST_OK wms_app 读=$PERM_READ 台账只读=$PERM_LEDGER_LOCKED 反向对照检出=$NEG_DETECTED 用时=${TOTAL}s"
[ "$PASS" = true ]
