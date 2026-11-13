#!/usr/bin/env bash
# backup.sh / restore.sh / backup-drill.sh 共用：连接参数与安全护栏（08 §6）。被 source，不单独执行。
# 连接：标准 libpq 环境变量 PGHOST/PGPORT/PGUSER（缺省为本机开发实例 127.0.0.1:55432 / postgres）；
# 生产（infra/native）在 /opt/wms3d/etc/backup.env 里设置 PGHOST=/run/wms3d、PGUSER=postgres 等。
# shellcheck disable=SC2034
_BL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ws-config.sh
source "$_BL_DIR/ws-config.sh"
if [ -n "${BACKUP_CONFIG:-}" ]; then
  # shellcheck disable=SC1090
  set -a; source "$BACKUP_CONFIG"; set +a
fi
export PGHOST="${PGHOST:-$WMS_PG_HOST}" PGPORT="${PGPORT:-$WMS_PG_PORT}" PGUSER="${PGUSER:-postgres}"
PG_DUMP="${PG_DUMP:-pg_dump}"; PG_RESTORE="${PG_RESTORE:-pg_restore}"; PSQL="${PSQL:-psql}"

die() { echo "错误：$*" >&2; exit 1; }
log() { echo "[$(date '+%F %T %Z')] $*" >&2; }
utc_ts() { date -u +%Y%m%dT%H%M%SZ; }
q() { "$PSQL" -v ON_ERROR_STOP=1 -qAtX -d "$1" -c "$2"; }

valid_db() { [[ "$1" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || die "非法库名：$1"; }

# 开发机护栏：设置了 WMS_WS（worktree .env.local）时，只允许本 WS 的库（wms_<ws> 与 t_<ws>_*），避免碰其他 WS。
# 生产部署不设 WMS_WS，不受此限。
guard_db() {
  local db="$1"; valid_db "$db"
  case "$db" in postgres|template0|template1) die "拒绝操作系统库：$db";; esac
  if [ -n "${WMS_WS:-}" ] && [ "${WMS_WS}" != "lead" ]; then
    local tag="${WMS_WS//-/_}"
    [[ "$db" == "wms_${tag}" || "$db" == t_${tag}_* ]] || die "开发机上 $WMS_WS 只能操作 wms_${tag} 或 t_${tag}_*（收到 $db）"
  fi
}

# 恢复目标必须是一次性库：开发机 t_<ws>_restore_*；生产默认 wms_restore_*（可 --target 指定，仍拒绝覆盖非空库）
scratch_name() {
  local rand; rand="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
  if [ -n "${WMS_WS:-}" ] && [ "${WMS_WS}" != "lead" ]; then echo "t_${WMS_WS//-/_}_restore_${rand}"
  else echo "wms_restore_${rand}"; fi
}

# 保留策略（08 §6）：最近 $3 个日期各留最新一份 + 最近 $4 个 ISO 周各留最新一份；其余删除。
# 只删 $1 目录下本库（$2-*.dump / .dump.gpg）的文件及其 .sha256/.json 旁文件。
prune_backups() {
  local out="$1" db="$2" daily="$3" weekly="$4" f ts d w
  local -a all=()
  local -A keep=() days=() weeks=()
  mapfile -t all < <(find "$out" -maxdepth 1 -type f \( -name "$db-*.dump" -o -name "$db-*.dump.gpg" \) -printf '%f\n' | sort -r)
  for f in "${all[@]}"; do
    ts="${f#"$db"-}"; d="${ts:0:8}"
    w="$(date -u -d "${d:0:4}-${d:4:2}-${d:6:2}" +%G%V 2>/dev/null || echo "$d")"
    if [ -z "${days[$d]:-}" ] && [ "${#days[@]}" -lt "$daily" ]; then days[$d]=1; keep[$f]=1; fi
    if [ -z "${weeks[$w]:-}" ] && [ "${#weeks[@]}" -lt "$weekly" ]; then weeks[$w]=1; keep[$f]=1; fi
  done
  for f in "${all[@]}"; do
    [ -n "${keep[$f]:-}" ] && continue
    log "按保留策略删除 $f"; rm -f "$out/$f" "$out/$f.sha256" "$out/$f.json"
  done
}
