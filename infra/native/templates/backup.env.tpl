# backup.sh 配置（install.sh 生成，权限 600）。
PGHOST=@SOCK@
PGPORT=@PG_PORT@
PGUSER=postgres
BACKUP_RETAIN_DAILY=14
BACKUP_RETAIN_WEEKLY=8
# 异地拷贝（上线签字阻断项，08 §6）：rclone 远端，例如 s3remote:wms3d-backups 或 sftp-nas:/backups/wms3d。
# 先 `rclone config` 配好远端（凭据在 wms3d 用户的 rclone.conf），再填这里。未配置时看板常驻红色警告、golive-check 失败。
BACKUP_REMOTE=
# 可选：GPG 公钥加密（私钥离线保管，恢复时需要）
BACKUP_GPG_RECIPIENT=
