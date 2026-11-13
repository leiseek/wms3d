#!/usr/bin/env bash
# prune_backups 单测：120 天、每天 2 份 → 保留 14 个日期（各 1 份）+ 8 个 ISO 周（各 1 份，与日期集合有重叠）。
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../backup-lib.sh
WMS_WS= source "$DIR/backup-lib.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
for i in $(seq 0 119); do
  d="$(date -u -d "2026-11-12 -$i day" +%Y%m%d)"
  for hh in 02 14; do touch "$T/wms_x-${d}T${hh}0000Z.dump" "$T/wms_x-${d}T${hh}0000Z.dump.sha256"; done
done
touch "$T/other-20260101T000000Z.dump"
prune_backups "$T" wms_x 14 8 2>/dev/null
left=$(find "$T" -name 'wms_x-*.dump' | wc -l)
newest="$(find "$T" -name 'wms_x-*.dump' -printf '%f\n' | sort -r | head -1)"
orphans=$(find "$T" -name 'wms_x-*.sha256' | while read -r s; do [ -f "${s%.sha256}" ] || echo "$s"; done | wc -l)
fail=0
# 14 个最近日期 + 更早的 ISO 周（最近 8 周中有 2–3 周已被日期覆盖）→ 期望 19–20
{ [ "$left" -ge 19 ] && [ "$left" -le 20 ]; } || { echo "FAIL 保留数 $left"; fail=1; }
[ "$newest" = "wms_x-20261112T140000Z.dump" ] || { echo "FAIL 最新一份被删：$newest"; fail=1; }
[ "$orphans" = 0 ] || { echo "FAIL 残留 sha256 旁文件 $orphans"; fail=1; }
[ -f "$T/other-20260101T000000Z.dump" ] || { echo "FAIL 删了其他库的文件"; fail=1; }
[ $fail = 0 ] && echo "ok backup-retention（保留 $left 份）"
exit $fail
