# 08 · 安全与运维

> v2（2026-11-12）：权限矩阵补组织级 SKU 与补打；DB 角色拆分；审计同事务；证书两条路径；备份异地 + WAL；**原生 systemd 部署为本机已验证路径**，docker compose 标注未验证。
> **v2.1**（2026-11-12，R2）：异地备份成为上线签字阻断项（D37）；advisory lock 双 int 常量（B-N16）；证书轮换指引（M-N19）。

## 1. 权限矩阵（RBAC）
| 功能 | ADMIN | MANAGER | OPERATOR | VIEWER |
|---|---|---|---|---|
| 用户/设备 | ✔ | – | – | – |
| 仓库设置/布局发布 | ✔ | 编辑草稿 | – | – |
| SKU 主数据/CSV 导入（**组织级**） | ✔ | 仅 `all_warehouses=true` 的 MANAGER | – | – |
| 标签打印 | ✔ | ✔ | 提交补打请求（移动端）| – |
| 入库/出库/移库 | ✔ | ✔ | ✔ | – |
| 冲正 | ✔ | ✔ | 本人 10 分钟内（撤销上一笔） | – |
| 库存调整 | ✔ | ✔ | – | – |
| 盘点创建/审核/关闭 | ✔ | ✔ | 执行 | – |
| 查询/3D/看板 | ✔ | ✔ | ✔ | ✔ |
| 审计日志 | ✔ | 授权仓库只读 | – | – |
- 叠加**仓库授权**（`user_warehouses` 或 `all_warehouses`）；判定规则见 03 §1.2（失败 404）。
- 已知限制（D26）：角色是全局单角色，无法表达"WH1 主管 + WH2 操作员"；`user_warehouses.role_override` 已预留，MVP 不启用。

## 2. 安全措施
- 传输：HTTPS（两条证书路径见 04 §1：ACME/DNS-01 推荐；内部 CA + 用户锚点 + SPKI 启动校验）；HSTS；release 禁 cleartext。
- 认证：argon2id；JWT 15min（含 `did`）+ 轮换 refresh（30 天，60s 宽限窗口防并发误判）；首登强制改密；登录限流与锁定。
- 设备：`devices.disabled_at` 立即使该设备 refresh 失效，库存写接口 60s 内拒绝其 access token。
- 输入：Zod 全量校验；Drizzle 参数化；CSV 导出防公式注入。
- Web：CSP、`X-Frame-Options: DENY`；refresh cookie `SameSite=Strict` + 自定义头 CSRF 检查。
- 配置二维码防钓鱼：显示主机名 + 指纹并确认；换服务器需清空本地数据（04 §1）。
- **数据库角色**（D11）：`wms_owner`（迁移）/ `wms_app`（运行时，对 ledger、audit 仅 INSERT+SELECT，非属主）。
- 秘钥：`.env`（不入库，`.env.example` 提供）；JWT `kid` 轮换。
- 日志：不记录密码、token、Authorization 头；SSE 不用 query token。

## 3. 审计（D34）
- `audit_logs` 含 `warehouse_id, trace_id, result`；关键操作与业务数据**同一事务**写入（回滚则无审计、提交则必有）。
- 登录失败单独写，按 IP+账号 1 分钟聚合，防刷表。
- 记录：登录/登出/失败、用户/授权/设备变更、SKU/条码变更、布局发布（版本 + 差异摘要 + 改码确认）、调整/冲正/盘点关闭、标签打印、强制清空 outbox。
- 审计表只追加（触发器 + 角色权限）。

## 4. 可观测性
- pino JSON 日志 + `traceId`（响应头 `X-Trace-Id`，错误体与异常单显示）。
- `/health`、`/ready`；看板显示：对账状态、全仓待同步条数（设备心跳汇总）、备份最近成功时间。
- 夜间任务（进程内 `node-cron`）：用 `pg_try_advisory_lock(LOCK_NS.JOB, <任务号>)` 防重复（双 int 形式，常量在 `apps/api/src/db/locks.ts`，v2.1 B-N16）；按仓库 `timezone` 定时：增量对账、清理过期 refresh、清理 0 余额行（> 90 天）、清理 DONE 幂等记录（`idempotency_keys` > 30 天）。

## 5. 部署
### 5.1 路径 A（本机已验证 / 推荐小型现场）：原生 + systemd（D39）
本机无 Docker（apt 源不可达），因此**交付并在本机验证**的部署路径为：
```
/opt/wms3d/
  node/            # Node 24 官方 tarball
  pg17/            # PostgreSQL 17 二进制（zonky 包或发行版包）
  app/api/         # 构建产物 dist/ + node_modules（pnpm deploy --prod）
  app/admin/       # 静态资源
  caddy            # Caddy 官方静态二进制
  data/pg/  backups/  etc/{.env,Caddyfile}
systemd units: wms3d-pg.service, wms3d-api.service, wms3d-caddy.service, wms3d-backup.timer
```
- `infra/native/install.sh`：创建系统用户 `wms3d`、initdb（`--locale=C.UTF-8`，与 code 列 `COLLATE "C"` 一致）、创建 `wms_owner/wms_app`、写 unit、`systemctl enable --now`。
- 本机（box）无 systemd 用户会话时，用同一脚本的 `--foreground` 模式（`pg_ctl` + `node` + `caddy run`）做等价冒烟——M6 验收在本机执行该冒烟。
- API 启动时执行迁移，持 `pg_advisory_lock(LOCK_NS.MIGRATION, 0)`，防多实例并发迁移（D38）；`MIGRATE_ON_START=false` 可关。

### 5.2 路径 B：docker compose（**随交付提供，但未在本机验证**）
```yaml
# infra/compose/docker-compose.yml（摘要；服务名统一为 postgres / api / caddy / backup，D38）
services:
  postgres: { image: postgres:17 (Debian，与 dev 同 libc，D37), volumes: [pgdata:/var/lib/postgresql/data], healthcheck: pg_isready,
              init: ./initdb/01-roles.sql }
  api:      { build: { context: ../.., dockerfile: infra/compose/api.Dockerfile }, env_file: .env, depends_on: { postgres: { condition: service_healthy } } }
  caddy:    { build: { context: ../.., dockerfile: infra/compose/caddy.Dockerfile },   # 多阶段：构建 admin 静态资源打进镜像（D38）
              ports: ["80:80","443:443"], volumes: [caddy_data:/data] }
  backup:   { image: postgres:17, entrypoint: /backup.sh, volumes: [./backup.sh:/backup.sh, backups:/backups] }  # supercronic 调度
```
交付报告中如实标注"compose 未在本机运行验证"；M0a 会尝试 Docker 官方静态二进制（`download.docker.com/linux/static`，本机 https 可达）做 spike，若容器运行时可用则升级为已验证。

### 5.3 Caddy
`/api/*` → api:3000（`/api/v1/events` `flush_interval -1`）；其余 → admin SPA；`/downloads/app.apk` 提供 APK。

## 6. 备份与恢复（D37，部分采纳）
- 默认：每日 02:00（仓库时区）`pg_dump -Fc`，本地保留 14 日 + 8 周。
- **异地拷贝为上线签字的阻断项**（v2.1，D37 附条件关闭）：`BACKUP_REMOTE` 未配置或最近一次异地拷贝失败 → 交付检查清单不能签字（`scripts/golive-check.sh` 失败），且看板常驻红色警告。做法：`rclone` 到任意 S3/MinIO/另一台主机（配置项 `BACKUP_REMOTE`）；未配置时看板常驻红色警告"备份与数据同盘"。
- **推荐启用 WAL 归档**（`wal-g` 或 `archive_command` + rclone，RPO 15 分钟）：脚本与文档提供，需现场配置远端后开启（MVP 不强制，因为需要外部存储）。
- 恢复演练：`scripts/restore.sh <dump>` → 临时库 → 跑全量对账 → 输出报告；RTO ≤ 1h。
- 备份文件权限 600，可选 GPG 加密。

### 6.1 证书轮换（v2.1，M-N19）
- 内部 CA 路径下，App 只在**启动和配置时**校验 SPKI 指纹（04 §1）。轮换服务器证书时：
  1. 推荐**沿用原私钥**重新签发（SPKI 不变，App 无感）；
  2. 必须换钥时：先生成新密钥，发布同时含新旧两个 `pin` 的配置二维码让设备重新确认，再切换 Caddy 证书；
  3. 更换内部 CA：先在设备上安装新 CA（用户锚点），确认后再切换。
- "WebView 信任用户锚点"的行为本机无法测试，列入 M6 现场验证。

## 7. APK 分发
后台"下载 App"页提供 APK；App 启动请求 `/app/version` 提示更新（不静默安装）；release 签名流程文档化，keystore 不入库。
