#!/bin/bash
# ⚠️ 未验证（compose）。首次 initdb 时由 postgres 官方镜像执行：角色、库、运行时超时（与 scripts/dev-db.sh、infra/native 一致）。
set -euo pipefail
psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -v owner_pw="$WMS_OWNER_PASSWORD" -v app_pw="$WMS_APP_PASSWORD" -v db="${WMS_DB:-wms3d}" <<'SQL'
SELECT format('CREATE ROLE wms_owner LOGIN PASSWORD %L', :'owner_pw') \gexec
SELECT format('CREATE ROLE wms_app LOGIN PASSWORD %L', :'app_pw') \gexec
ALTER ROLE wms_app SET transaction_timeout = '30s';
ALTER ROLE wms_app SET idle_in_transaction_session_timeout = '30s';
SELECT format('CREATE DATABASE %I OWNER wms_owner', :'db') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO wms_app', :'db') \gexec
SQL
psql -v ON_ERROR_STOP=1 -U postgres -d "${WMS_DB:-wms3d}" -c "ALTER SCHEMA public OWNER TO wms_owner; GRANT USAGE ON SCHEMA public TO wms_app;"
