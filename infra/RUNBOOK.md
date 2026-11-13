# wms3d 运维手册（草稿 v0.1 · ws-f · M1）

> 适用：原生 + systemd 部署（08 §5.1，**已在本机以 `--foreground` 模式验证**）。docker compose 路径见 `infra/compose/README.md`（**未验证**）。
> 时间一律按服务器本地时区书写；备份定时按仓库时区（缺省 Asia/Shanghai，`WMS_TIMEZONE`）。

## 0. 速查

| 事项 | 命令 |
|---|---|
| 服务状态 | `systemctl status wms3d-pg wms3d-api wms3d-caddy` · `systemctl list-timers wms3d-backup.timer` |
| 健康检查 | `curl -fsS http://127.0.0.1:3000/api/v1/ready`（含库名）· `…/health`（含 `contractVersion`） |
| 日志 | `journalctl -u wms3d-api -f`（pino JSON，按 `traceId` 搜：`journalctl -u wms3d-api \| grep <traceId>`）· PG：`/opt/wms3d/logs/postgresql-*.log` · Caddy：`/opt/wms3d/logs/caddy-access.log` |
| 立即备份 | `sudo systemctl start wms3d-backup.service`（或 `sudo -u wms3d BACKUP_CONFIG=/opt/wms3d/etc/backup.env /opt/wms3d/scripts/backup.sh --db wms3d --dir /opt/wms3d/backups`） |
| 恢复演练 | `sudo -u wms3d BACKUP_CONFIG=… /opt/wms3d/scripts/restore.sh <dump> --report /opt/wms3d/logs/restore-drill-$(date +%F).json` |
| 上线检查 | `sudo /opt/wms3d/scripts/golive-check.sh --prefix /opt/wms3d --url https://<域名>` |
| 重启 API | `sudo systemctl restart wms3d-api`（启动时自动迁移，advisory lock 防并发） |

## 1. 架构与目录

```
/opt/wms3d/
  app/            精简 pnpm workspace（apps/api + contracts/domain/labels 源码 + 生产依赖），Node 24 直接运行 TS
  admin/          管理后台静态资源（Caddy 提供）
  downloads/      app.apk（/downloads/app.apk）
  scripts/        backup.sh restore.sh reconcile.sql golive-check.sh
  etc/.env        API 配置（600）  etc/backup.env（600）  etc/Caddyfile
  data/pg/        PostgreSQL 17 数据目录（builtin C.UTF-8）   data/caddy/  证书与 ACME 状态
  backups/        本地备份（14 日 + 8 周）   logs/
systemd：wms3d-pg.service → wms3d-api.service → wms3d-caddy.service；wms3d-backup.timer（每日 02:00）
```
端口：Caddy 443/80 对外；API 127.0.0.1:3000、PG 127.0.0.1:5432 只监听回环。数据库角色：`wms_owner`（迁移/属主）、`wms_app`（运行时；台账/审计只能 INSERT+SELECT）。

## 2. 首次安装

前置：Debian/Ubuntu x86_64；root；Node 24（`/opt/wms3d/node` 或系统）；pnpm 10（仅构建发布目录时需要）；
PostgreSQL 17 服务端二进制（`PG_BIN`，或放到 `/opt/wms3d/pg17/bin`）与 `postgresql-client-17`（psql/pg_dump/pg_restore 必须 17.x）；
Caddy（`infra/native/fetch-caddy.sh` 下载官方二进制并校验 SHA-512，或 `CADDY_BIN`）。

```bash
# 在构建机（有源码与 pnpm store）
infra/native/build-release.sh /tmp/wms3d-release          # app/ + admin/ + scripts/ + VERSION.json
tar -C /tmp -czf wms3d-release.tgz wms3d-release           # 拷到目标机

# 在目标机
sudo CADDY_BIN=/usr/local/bin/caddy infra/native/install.sh --systemd --release /path/wms3d-release \
     --domain wms.example.com --tls internal                # internal | acme | <crt>,<key>
WMS_ADMIN_TEMP_PASSWORD='<临时密码≥12位>' node --experimental-strip-types scripts/create-admin.ts \
     --url "$(sudo grep ^DATABASE_URL= /opt/wms3d/etc/.env | cut -d= -f2-)" --username <管理员账号>
```
`install.sh` 是幂等的：已存在的 `etc/.env`、`backup.env`、数据目录不会被覆盖（密码与 JWT 密钥只在首次生成）。
**生产库不要写演示数据**；golive-check 会用演示账号默认密码尝试登录，能登录即 FAIL。

### 2.1 证书（04 §1、08 §6.1）
- **ACME（推荐，有公网域名）**：`--tls acme`；DNS-01 需要带 DNS 插件的 Caddy 构建与 `etc/caddy.env` 中的提供商凭据。
- **内部 CA**：`--tls internal`，根证书在 `data/caddy/pki/authorities/local/root.crt`；安装到每台设备（用户锚点），App 配置二维码含 SPKI 指纹。
- **轮换**：优先沿用原私钥重签（SPKI 不变）；必须换钥时先发布含新旧两个 pin 的配置二维码，再切证书（08 §6.1）。`sudo systemctl reload wms3d-caddy`。

## 3. 升级
1. 先备份：`sudo systemctl start wms3d-backup.service`，确认 `backups/` 有新文件。
2. 构建新发布目录并拷贝；`sudo infra/native/install.sh --systemd --release <新目录> --domain …`（只替换 app/admin/scripts，保留配置与数据）。
3. `systemctl restart wms3d-api`：启动时执行迁移（`pg_advisory_lock(LOCK_NS.MIGRATION, 0)`）。看 `journalctl -u wms3d-api` 有无迁移错误。
4. `curl …/api/v1/health` 看 `contractVersion`；移动端 App 版本门槛见 `/api/v1/app/version`。
5. 回滚：迁移只前进。需要回滚时用升级前的备份恢复到新库（§5），再切换（§5.3）。

## 4. 备份（08 §6，D37）
- 每日 02:00（仓库时区）`pg_dump -Fc`；文件 600 权限，旁边有 `.sha256` 与 `.json` 清单；保留最近 14 个日期 + 8 个 ISO 周。
- `ops_status['backup']` 记录 `lastLocalAt / lastRemoteAt / remoteConfigured`，看板据此显示；未配置异地时常驻红色警告。
- **异地拷贝是上线签字阻断项**：`etc/backup.env` 设置 `BACKUP_REMOTE=<rclone 远端:路径>`（S3/MinIO/另一台主机），以 `wms3d` 用户运行 `rclone config` 配置远端。异地失败时 `backup.sh` 退出码 3、单元失败。
- 可选加密：`BACKUP_GPG_RECIPIENT=<公钥 ID>`；**私钥离线保管**，恢复时需要。
- 推荐（MVP 不强制）WAL 归档：`archive_mode=on` + `archive_command='rclone copyto %p <远端>/wal/%f'`，RPO 15 分钟；需外部存储，现场配置。

## 5. 恢复
### 5.1 演练（每月一次，golive-check 要求 35 天内有报告）
```bash
sudo -u wms3d BACKUP_CONFIG=/opt/wms3d/etc/backup.env /opt/wms3d/scripts/restore.sh \
  /opt/wms3d/backups/wms3d-<时间>.dump --report /opt/wms3d/logs/restore-drill-$(date +%F).json
```
恢复到一次性库 `wms_restore_<rand>` → 校验 sha256 → 全量对账（台账 Σ = 余额、最新 balance_after = 余额、无负数、停用仓位无库存、交易都有明细）→ 删库。退出码 4 = 对账有差异。RTO 目标 ≤ 1h（本机 1.3k 行演练 2–3 秒）。
### 5.2 真实恢复（数据损坏/误操作）
1. 停写：`systemctl stop wms3d-api`（移动端离线队列会保留，恢复后补传，幂等键防重复）。
2. `restore.sh <dump> --target wms3d_restored --keep`，检查对账 JSON 与业务抽查。
3. 切换（§5.3）。
### 5.3 切换到恢复库
```sql
-- 以 postgres 连接（sudo -u wms3d psql -h /run/wms3d -U postgres -d postgres）
ALTER DATABASE wms3d RENAME TO wms3d_broken_<日期>;
ALTER DATABASE wms3d_restored RENAME TO wms3d;
```
`systemctl start wms3d-api` → `/ready` → 看板对账状态。确认无误后保留 `wms3d_broken_*` 至少 7 天再删。

## 6. 常见故障
| 现象 | 排查 |
|---|---|
| `/ready` 503 | `systemctl status wms3d-pg`；`logs/postgresql-*.log`；磁盘空间 `df -h /opt/wms3d` |
| API 反复重启 | `journalctl -u wms3d-api -n 100`：迁移失败 / `JWT_SECRET` 缺失（production 必填）/ 端口占用 |
| 移动端“证书不受信任” | 内部 CA 根证书未装到设备，或换钥后未重新扫配置码（§2.1） |
| SSE 事件延迟 | Caddyfile 中 `/api/v1/events*` 必须 `flush_interval -1`（模板已带） |
| 登录 429 | 5 次/分钟/账号+IP；连续失败 10 次锁 15 分钟（内存，重启 API 清零） |
| 看板“备份与数据同盘” | 未配置 `BACKUP_REMOTE`（§4） |
| 对账有差异 | 先 `restore.sh` 到一次性库比对；台账只追加，按 `traceId` 查审计日志 |

## 7. 安全基线（08 §2；M6 补 ASVS L1 清单）
- `etc/` 与 `backups/` 700/600；`.env` 不入库；日志不含密码/token。
- PG 只听回环；TCP 用 scram-sha-256；本地 socket peer（`wms3d`/`root` 映射为 postgres）。
- systemd 加固：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`，仅 `ReadWritePaths` 可写。
- Caddy：HSTS、CSP、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy: no-referrer`。

## 8. 本机验证记录与已知限制
- `infra/native/install.sh --foreground --smoke`：PG17 + API + Caddy 2.11.9 → 健康检查 → 安全头 → SPA 回退 → 演示数据 → 登录 → 一笔入库 → 备份 → 恢复 → 对账 → `systemd-analyze --user verify` 单元校验，全部通过（main 合并 ws-a2 之后，入库一步为 pass；之前为 501 并记为 skipped）。
- **未验证**：真实 systemd 下的 `--systemd` 安装（本机 PID 1 不是 systemd，且简报禁止安装系统服务）；ACME/DNS-01；rclone 真实远端；docker compose 全部内容。
