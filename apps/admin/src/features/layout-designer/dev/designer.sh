#!/usr/bin/env bash
# WS-D1 设计器开发台 / Playwright。端口：dev 用 PORT_API(4400)/PORT_ADMIN(4410)；e2e 用 4431(mock)/4432(vite)。
#   bash apps/admin/src/features/layout-designer/dev/designer.sh dev   # mock + vite（Ctrl+C 结束）
#   bash apps/admin/src/features/layout-designer/dev/designer.sh e2e [playwright args]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../../../../.." && pwd)"
export DESIGNER_DIR="$here/.."
vite="$repo/apps/admin/node_modules/vite/bin/vite.js"
cmd="${1:-dev}"
shift || true
case "$cmd" in
  dev)
    export PORT_API="${PORT_API:-4400}" PORT_ADMIN="${PORT_ADMIN:-4410}"
    (cd "$repo/packages/api-client" && exec node --experimental-strip-types scripts/mock-server.ts) &
    mock=$!
    trap 'kill $mock 2>/dev/null || true' EXIT
    node "$vite" --config "$here/vite.config.ts"
    ;;
  serve-mock)
    cd "$repo/packages/api-client" && exec node --experimental-strip-types scripts/mock-server.ts
    ;;
  serve-vite)
    exec node "$vite" --config "$here/vite.config.ts"
    ;;
  e2e)
    exec "$repo/node_modules/.bin/playwright" test --config "$here/../e2e/playwright.config.ts" "$@"
    ;;
  *) echo "usage: designer.sh dev|e2e" >&2; exit 2 ;;
esac
