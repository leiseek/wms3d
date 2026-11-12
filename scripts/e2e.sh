#!/usr/bin/env bash
# e2e 入口（Playwright 1.65 + /opt/google/chrome/chrome，workers=2）。
# 用法：e2e.sh [mock|real] [--ui] [--app-root <dir>] [-- <playwright 参数>]
#   mock（缺省）：契约 mock；real：apps/api + 一次性克隆库（结束删除）；--ui：另起 admin/mobile Vite 跑浏览器冒烟
#   --app-root：被测代码目录（合并预览），用例仍取自本仓库
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
# shellcheck source=clean-env.sh
source "$DIR/clean-env.sh"
TARGET=mock; EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    mock|real) TARGET="$1"; shift;;
    --ui) export E2E_UI=1; shift;;
    --app-root) export E2E_APP_ROOT="$2"; shift 2;;
    --) shift; EXTRA=("$@"); break;;
    *) EXTRA+=("$1"); shift;;
  esac
done
export E2E_TARGET="$TARGET"
cd "$ROOT"
exec pnpm exec playwright test -c e2e "${EXTRA[@]}"
