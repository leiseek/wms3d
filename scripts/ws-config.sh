#!/usr/bin/env bash
# 工作流（workstream）隔离配置：序号 → 端口/数据库（docs/10-dev-plan.md §6）。被 wt.sh / dev-db.sh source。
# shellcheck disable=SC2034
WMS_WORKSTREAMS=(lead ws-a ws-b ws-c ws-d1 ws-d2 ws-e ws-f)
WMS_WT_ROOT="${WMS_WT_ROOT:-/workspace/wms3d-wt}"
WMS_PG_PORT="${WMS_PG_PORT:-55432}"
WMS_PG_HOST="${WMS_PG_HOST:-127.0.0.1}"
WMS_PG_DATA="${WMS_PG_DATA:-/workspace/.wms3d-pg}"
WMS_PG_BIN="${WMS_PG_BIN:-/opt/tools/pg17/bin}"

ws_index() {
  local i
  for i in "${!WMS_WORKSTREAMS[@]}"; do
    [ "${WMS_WORKSTREAMS[$i]}" = "$1" ] && { echo "$i"; return 0; }
  done
  return 1
}
ws_db_name() { echo "wms_${1//-/_}"; }          # ws-a → wms_ws_a；lead → wms_lead
ws_port_api() { echo $((4000 + 100 * $1)); }
ws_port_admin() { echo $((4010 + 100 * $1)); }
ws_port_mobile() { echo $((4020 + 100 * $1)); }
