#!/usr/bin/env bash
# 重建本工作流开发库（.env.local 的 wms_<ws>）：删库 → 建库 → 迁移 → 演示数据。只影响本工作流自己的库。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
set -a; source "$ROOT/.env.local"; set +a
DB="${DATABASE_URL##*/}"
[[ "$DB" =~ ^wms_[a-z0-9_]+$ ]] || { echo "非法库名：$DB" >&2; exit 2; }
bash "$ROOT/scripts/dev-db.sh" drop "$DB" >/dev/null 2>&1 || true
bash "$ROOT/scripts/dev-db.sh" create "$DB"
(cd "$ROOT/apps/api" && node --experimental-strip-types src/db/migrate.ts "$MIGRATION_DATABASE_URL")
(cd "$ROOT/apps/api" && node --experimental-strip-types src/db/seed-demo.ts "$DATABASE_URL")
