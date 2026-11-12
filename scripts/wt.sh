#!/usr/bin/env bash
# 为工作流创建隔离的 git worktree + 数据库 + 端口（docs/10-dev-plan.md §6，docs/dev-setup.md）。
# v2.1（R2 N10）：主仓 /workspace/wms3d 只做合并；Lead 自己的开发也在 worktree（wt.sh create lead lead/m0b-...）。
# 用法：
#   wt.sh create <ws> [branch] [--no-install]   例：wt.sh create ws-a ws/ws-a/m1-auth
#   wt.sh info <ws>      显示端口/库/路径
#   wt.sh list           列出 worktree
#   wt.sh remove <ws> [--drop-db]   删除 worktree（分支保留）
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/.." && git rev-parse --show-toplevel)"
# 始终以主仓为准（脚本可能在某个 worktree 中被调用）
MAIN_REPO="$(git -C "$REPO" worktree list --porcelain | awk 'NR==1{print $2}')"
# shellcheck source=ws-config.sh
source "$DIR/ws-config.sh"

need_ws() {
  local ws="${1:?缺少工作流名，可选：${WMS_WORKSTREAMS[*]}}"
  ws_index "$ws" >/dev/null || { echo "未知工作流：$ws（可选：${WMS_WORKSTREAMS[*]}）" >&2; exit 2; }
}

info() {
  local ws="$1" n; n="$(ws_index "$ws")"
  local db; db="$(ws_db_name "$ws")"
  cat <<INFO
WMS_WS=$ws
WMS_WS_INDEX=$n
WORKTREE=$WMS_WT_ROOT/$ws
PORT_API=$(ws_port_api "$n")
PORT_ADMIN=$(ws_port_admin "$n")
PORT_MOBILE=$(ws_port_mobile "$n")
DATABASE_URL=$("$DIR/dev-db.sh" url "$db" app)
MIGRATION_DATABASE_URL=$("$DIR/dev-db.sh" url "$db" owner)
INFO
}

create() {
  local ws="$1" branch="${2:-}" install=1
  [ "${3:-}" = "--no-install" ] || [ "$branch" = "--no-install" ] && install=0
  [ "$branch" = "--no-install" ] && branch=""
  branch="${branch:-ws/$ws/scratch}"
  local path="$WMS_WT_ROOT/$ws"
  mkdir -p "$WMS_WT_ROOT"
  if [ -d "$path/.git" ] || [ -f "$path/.git" ]; then
    echo "worktree 已存在：$path"
  elif git -C "$MAIN_REPO" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$MAIN_REPO" worktree add "$path" "$branch"
  else
    git -C "$MAIN_REPO" worktree add -b "$branch" "$path" main
  fi
  "$DIR/dev-db.sh" start >/dev/null
  "$DIR/dev-db.sh" create "$(ws_db_name "$ws")"
  { echo "# 由 scripts/wt.sh 生成；勿提交"; info "$ws"; } > "$path/.env.local"
  echo "已写入 $path/.env.local"
  if [ "$install" = 1 ]; then (cd "$path" && pnpm install --frozen-lockfile --prefer-offline >/dev/null && echo "依赖已安装"); fi
  echo "完成：cd $path && set -a && source .env.local && set +a && pnpm dev:api"
}

remove() {
  local ws="$1" path="$WMS_WT_ROOT/$1"
  git -C "$MAIN_REPO" worktree remove --force "$path" && echo "已删除 worktree：$path（分支保留）"
  [ "${2:-}" = "--drop-db" ] && "$DIR/dev-db.sh" drop "$(ws_db_name "$ws")"
  return 0
}

case "${1:-}" in
  create) need_ws "${2:-}"; create "$2" "${3:-}" "${4:-}";;
  info) need_ws "${2:-}"; info "$2";;
  list) git -C "$MAIN_REPO" worktree list;;
  remove) need_ws "${2:-}"; remove "$2" "${3:-}";;
  *) echo "用法：$0 create <ws> [branch] [--no-install] | info <ws> | list | remove <ws> [--drop-db]" >&2; exit 2;;
esac
