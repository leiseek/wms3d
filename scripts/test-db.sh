#!/usr/bin/env bash
# 测试数据库（R2 N8）：模板库按「工作流 + 迁移哈希」命名，flock 串行创建，克隆时只连 postgres 维护库。
# 用法：test-db.sh template <ws>   → 输出模板库名（不存在则创建并迁移，清理同 ws 旧哈希模板）
#       test-db.sh clone <ws>      → 输出新测试库名 t_<ws>_<rand>
#       test-db.sh drop <db> | gc <ws>
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=ws-config.sh
source "$DIR/ws-config.sh"
DEVDB="$DIR/dev-db.sh"
PSQL_BIN="${WMS_PSQL:-$( [ -x "$WMS_PG_BIN/psql" ] && echo "$WMS_PG_BIN/psql" || command -v psql )}"
Q() { "$PSQL_BIN" -h "$WMS_PG_HOST" -p "$WMS_PG_PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -qAt -c "$1"; }
MIGRATIONS="${WMS_MIGRATIONS_DIR:-$ROOT/apps/api/src/db/migrations}"

mig_hash() {
  if [ -d "$MIGRATIONS" ]; then
    find "$MIGRATIONS" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-8
  else echo "nomig000"; fi
}
ws_tag() { ws_index "$1" >/dev/null || { echo "未知工作流：$1" >&2; exit 2; }; echo "${1//-/_}"; }

template() {
  local tag; tag="$(ws_tag "$1")"
  local name="wms_tpl_${tag}_$(mig_hash)"
  "$DEVDB" start >/dev/null
  exec 9>"/tmp/wms3d-tpl-${tag}.lock"
  flock 9
  if [ -z "$(Q "SELECT 1 FROM pg_database WHERE datname='$name'")" ]; then
    Q "CREATE DATABASE $name OWNER wms_owner" >/dev/null
    # M0b 起：迁移以 wms_owner 运行到模板库（脚本存在时）
    if (cd "$ROOT" && pnpm --filter @wms3d/api run --if-present db:migrate:url "$("$DEVDB" url "$name" owner)") >/dev/null 2>&1; then :; fi
    Q "ALTER DATABASE $name WITH IS_TEMPLATE true ALLOW_CONNECTIONS false" >/dev/null
    for old in $(Q "SELECT datname FROM pg_database WHERE datname LIKE 'wms\\_tpl\\_${tag}\\_%' AND datname <> '$name'"); do
      Q "ALTER DATABASE $old WITH IS_TEMPLATE false" >/dev/null; Q "DROP DATABASE IF EXISTS $old WITH (FORCE)" >/dev/null
    done
  fi
  echo "$name"
}

clone() {
  local tag tpl db; tag="$(ws_tag "$1")"; tpl="$(template "$1")"
  db="t_${tag}_$(od -An -N4 -tx4 /dev/urandom | tr -d ' ')"
  Q "CREATE DATABASE $db TEMPLATE $tpl OWNER wms_owner" >/dev/null
  echo "$db"
}

case "${1:-}" in
  template) template "${2:?缺少工作流}";;
  clone) clone "${2:?缺少工作流}";;
  drop) [[ "${2:-}" =~ ^t_[a-z0-9_]+$ ]] || { echo "只能删除 t_ 开头的测试库" >&2; exit 2; }; Q "DROP DATABASE IF EXISTS $2 WITH (FORCE)" >/dev/null; echo "已删除 $2";;
  gc) tag="$(ws_tag "${2:?缺少工作流}")"; for d in $(Q "SELECT datname FROM pg_database WHERE datname LIKE 't\\_${tag}\\_%'"); do Q "DROP DATABASE IF EXISTS $d WITH (FORCE)" >/dev/null; echo "已删除 $d"; done;;
  *) echo "用法：$0 template <ws> | clone <ws> | drop <t_db> | gc <ws>" >&2; exit 2;;
esac
