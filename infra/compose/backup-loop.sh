#!/bin/bash
# ⚠️ 未验证（compose）。每日 02:00（容器 TZ）执行 scripts/backup.sh；启动时若今天还没有备份则先备份一次。
set -uo pipefail
DB="${WMS_DB:-wms3d}"
run() { /bin/bash /scripts/backup.sh --db "$DB" --dir /backups || echo "备份失败（退出码 $?）" >&2; }
ls /backups/"$DB"-"$(date -u +%Y%m%d)"T*.dump* >/dev/null 2>&1 || run
while true; do
  now=$(date +%s); next=$(date -d 'tomorrow 02:00' +%s)
  [ "$(date +%H)" -lt 2 ] && next=$(date -d 'today 02:00' +%s)
  sleep $(( next - now )); run
done
