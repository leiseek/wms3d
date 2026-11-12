#!/usr/bin/env bash
# 本机共享 PostgreSQL 17 实例（单实例、按工作流分库），docs/dev-setup.md。
# 用法：dev-db.sh init|start|stop|status|create <db>|drop <db>|list|url <db> [app|owner]|psql [db]
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=ws-config.sh
source "$DIR/ws-config.sh"
PG="$WMS_PG_BIN"
PSQL_BIN="${WMS_PSQL:-$( [ -x "$PG/psql" ] && echo "$PG/psql" || command -v psql )}"
[ -n "$PSQL_BIN" ] || { echo "需要 psql 客户端（apt postgresql-client 或设置 WMS_PSQL）" >&2; exit 1; }
PSQL=("$PSQL_BIN" -h "$WMS_PG_HOST" -p "$WMS_PG_PORT" -U postgres -v ON_ERROR_STOP=1 -qAt)

running() { "$PG/pg_ctl" -D "$WMS_PG_DATA" status >/dev/null 2>&1; }

cmd_init() {
  if [ -f "$WMS_PG_DATA/PG_VERSION" ]; then echo "已初始化：$WMS_PG_DATA"; return; fi
  mkdir -p "$WMS_PG_DATA"
  # builtin C.UTF-8 排序：与 code 列 COLLATE "C" 一致、与 libc 无关（dev/prod 一致，D22）
  "$PG/initdb" -D "$WMS_PG_DATA" -U postgres -A trust -E UTF8 \
    --locale-provider=builtin --builtin-locale=C.UTF-8 >/dev/null
  cat >> "$WMS_PG_DATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = $WMS_PG_PORT
unix_socket_directories = '/tmp'
max_connections = 200
shared_buffers = 128MB
CONF
  echo "已初始化：$WMS_PG_DATA（端口 $WMS_PG_PORT）"
}

cmd_start() {
  [ -f "$WMS_PG_DATA/PG_VERSION" ] || cmd_init
  if running; then echo "已在运行"; else
    "$PG/pg_ctl" -D "$WMS_PG_DATA" -l "$WMS_PG_DATA/server.log" -w start >/dev/null
    echo "已启动：127.0.0.1:$WMS_PG_PORT"
  fi
  ensure_roles
}

ensure_roles() {
  # wms_owner：迁移/属主；wms_app：运行时（ledger/audit 表权限在 M0b 迁移中收紧，D11）
  "${PSQL[@]}" -d postgres <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wms_owner') THEN CREATE ROLE wms_owner LOGIN CREATEDB; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wms_app') THEN CREATE ROLE wms_app LOGIN; END IF;
END $$;
-- 运行时角色默认超时（02 §5.1/B-N7）；长事务（发布）在 BEGIN 前会话级 SET（事务内 SET LOCAL 无法延长，R3）
ALTER ROLE wms_app SET transaction_timeout = '30s';
ALTER ROLE wms_app SET idle_in_transaction_session_timeout = '30s';
SQL
}

cmd_stop() { running && "$PG/pg_ctl" -D "$WMS_PG_DATA" -m fast -w stop >/dev/null && echo "已停止" || echo "未运行"; }
cmd_status() { running && echo "运行中 127.0.0.1:$WMS_PG_PORT（$WMS_PG_DATA）" || { echo "未运行"; return 1; }; }

valid_db() { [[ "$1" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || { echo "非法库名：$1" >&2; exit 2; }; }

cmd_create() {
  local db="$1"; valid_db "$db"
  running || cmd_start >/dev/null
  if [ -n "$("${PSQL[@]}" -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$db'")" ]; then
    echo "已存在：$db"; return
  fi
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE $db OWNER wms_owner"
  "${PSQL[@]}" -d "$db" -c "GRANT CONNECT ON DATABASE $db TO wms_app; GRANT USAGE ON SCHEMA public TO wms_app; ALTER SCHEMA public OWNER TO wms_owner;"
  echo "已创建：$db"
}

cmd_drop() {
  local db="$1"; valid_db "$db"
  case "$db" in postgres|template0|template1) echo "拒绝删除系统库" >&2; exit 2;; esac
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $db WITH (FORCE)"
  echo "已删除：$db"
}

cmd_url() {
  local db="$1" role="${2:-app}"; valid_db "$db"
  case "$role" in app) echo "postgres://wms_app@$WMS_PG_HOST:$WMS_PG_PORT/$db";;
                  owner) echo "postgres://wms_owner@$WMS_PG_HOST:$WMS_PG_PORT/$db";;
                  *) echo "role 只能是 app|owner" >&2; exit 2;; esac
}

case "${1:-}" in
  init) cmd_init;; start) cmd_start;; stop) cmd_stop;; status) cmd_status;;
  create) cmd_create "${2:?缺少库名}";; drop) cmd_drop "${2:?缺少库名}";;
  list) "${PSQL[@]}" -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'wms\_%' OR datname LIKE 't\_%' ORDER BY 1";;
  url) cmd_url "${2:?缺少库名}" "${3:-app}";;
  psql) exec "$PSQL_BIN" -h "$WMS_PG_HOST" -p "$WMS_PG_PORT" -U postgres -d "${2:-postgres}";;
  *) echo "用法：$0 init|start|stop|status|create <db>|drop <db>|list|url <db> [app|owner]|psql [db]" >&2; exit 2;;
esac
