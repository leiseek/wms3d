#!/usr/bin/env bash
# 被 source：清掉从别的 shell / 别的 WS 外泄进来的 PORT_* / WMS_* / DATABASE_URL 等，再加载本 worktree 的 .env.local 与 /opt/tools/env.sh。
# 共享机器上避免连到别人的端口或库（10 §6）。
_CE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for _v in $(compgen -e); do
  case "$_v" in PORT_*|WMS_*|DATABASE_URL|MIGRATION_DATABASE_URL|JWT_*|E2E_*|PGHOST|PGPORT|PGUSER|PGDATABASE) unset "$_v";; esac
done
unset _v
# shellcheck disable=SC1091
[ -f /opt/tools/env.sh ] && source /opt/tools/env.sh
if [ -f "$_CE_ROOT/.env.local" ]; then
  # shellcheck disable=SC1091
  set -a; source "$_CE_ROOT/.env.local"; set +a
fi
