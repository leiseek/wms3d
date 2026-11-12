#!/usr/bin/env bash
# twin3d playground：dev（默认）| build | preview。端口 TWIN_PLAYGROUND_PORT（默认 4530，WS-D2 段 4530–4599）。
# twin3d 不声明 vite 依赖（package.json 归 Lead），借用 apps/admin 已安装的 vite。
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
vite="$repo/apps/admin/node_modules/vite/bin/vite.js"
font_src="${TWIN_LABEL_FONT:-/usr/share/sand-box-stock-fonts/truetype/noto/NotoSans-Regular.ttf}"
mkdir -p "$here/playground/public/fonts"
if [[ ! -f "$here/playground/public/fonts/label.ttf" && -f "$font_src" ]]; then
  cp "$font_src" "$here/playground/public/fonts/label.ttf"
fi
cmd="${1:-dev}"
shift || true
case "$cmd" in
  dev) exec node "$vite" --config "$here/playground/vite.config.mjs" "$@" ;;
  build) exec node "$vite" build --config "$here/playground/vite.config.mjs" "$@" ;;
  preview) exec node "$vite" preview --config "$here/playground/vite.config.mjs" "$@" ;;
  *) echo "usage: playground.sh [dev|build|preview]" >&2; exit 2 ;;
esac
