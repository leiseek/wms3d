#!/usr/bin/env bash
# 演示数据（09 §4）。主数据（用户/仓库/布局 v1/SKU/条码）走 apps/api 的 seed-demo.ts（幂等，Lead 维护）；
# 库存只经 HTTP postTransaction（scripts/demo-stock.ts，D42）。
# 用法：
#   seed-demo.sh                    # 重建本 WS 开发库（= pnpm db:reset:dev）
#   seed-demo.sh --db <name>        # 只往指定库写主数据（不删库；库须已迁移；开发机仅限本 WS 的库）
#   seed-demo.sh --stock [--api URL]  # 另对运行中的 API 写演示库存（缺省 http://127.0.0.1:$PORT_API）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
[ -f "$ROOT/.env.local" ] && { set -a; source "$ROOT/.env.local"; set +a; }
# shellcheck source=backup-lib.sh
source "$DIR/backup-lib.sh"
DB=""; STOCK=0; API="http://127.0.0.1:${PORT_API:-4700}"
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB="$2"; shift 2;;
    --stock) STOCK=1; shift;;
    --api) API="$2"; shift 2;;
    -h|--help) sed -n '2,8p' "$0"; exit 0;;
    *) die "未知参数：$1";;
  esac
done
if [ -z "$DB" ]; then
  bash "$DIR/db-reset-dev.sh"
else
  guard_db "$DB"
  (cd "$ROOT/apps/api" && node --experimental-strip-types src/db/seed-demo.ts "postgres://wms_app@$PGHOST:$PGPORT/$DB")
fi
if [ "$STOCK" = 1 ]; then
  node --experimental-strip-types "$DIR/demo-stock.ts" --api "$API"
fi
