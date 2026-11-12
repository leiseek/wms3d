# 08 · 安全与运维

## 1. 权限矩阵（RBAC）
| 功能 | ADMIN | MANAGER | OPERATOR | VIEWER |
|---|---|---|---|---|
| 用户/角色/设备 | ✔ | – | – | – |
| 仓库/库区/模板/布局发布 | ✔ | 编辑草稿 | – | – |
| SKU 主数据/CSV 导入 | ✔ | ✔ | – | – |
| 标签打印 | ✔ | ✔ | 仓位标签补打 | – |
| 入库/出库/移库 | ✔ | ✔ | ✔ | – |
| 库存调整 | ✔ | ✔ | – | – |
| 盘点：创建/审核/关闭 | ✔ | ✔ | 执行 | – |
| 查询/3D/看板 | ✔ | ✔ | ✔ | ✔ |
| 审计日志 | ✔ | 只读本仓 | – | – |
叠加**仓库授权**（`user_warehouses`）；ADMIN 默认全部仓库。

## 2. 安全措施
- 传输：全站 HTTPS（Caddy）；HSTS；App 只允许 https（开发构建允许明文局域网，release 关闭 `cleartextTraffic`）。
- 认证：argon2id；JWT 15min + 轮换 refresh（30 天，滑动）；refresh family 重用检测；登录限流；连续失败 10 次锁定 15 分钟。
- 输入：所有入参 Zod 校验；Drizzle 参数化；CSV 导入防公式注入（导出时对 `= + - @` 开头字段加 `'`）。
- Web：CSP（禁内联脚本）、`X-Frame-Options: DENY`、SameSite=Strict cookie + 双提交 CSRF 头（仅 cookie 鉴权的 refresh 端点）。
- 秘钥：`.env`（不入库），提供 `.env.example`；JWT 密钥轮换支持 `kid`。
- 设备：每台设备 `deviceId`（安装时生成），后台可禁用设备（其 refresh 失效）。
- 依赖：`pnpm audit` + Renovate（接 GitHub 后启用）。

## 3. 审计
- `audit_logs` 记录：登录/登出/失败、用户与权限变更、SKU/条码变更（before/after）、布局发布（版本号 + 差异摘要）、库存调整与盘点关闭、标签打印、设备禁用。
- 库存流水本身即审计（不可改）；审计表同样触发器禁止 UPDATE/DELETE。
- 后台审计页：按人/动作/时间筛选，导出 CSV。

## 4. 可观测性
- 结构化日志（pino，JSON），每请求 `traceId`（响应头 `X-Trace-Id`，错误体中返回，移动端异常单里展示便于报障）。
- `/health`（存活）`/ready`（DB 可连）；关键指标日志化：交易数、拒绝数、重放数、p95 延迟；MVP 不引入 Prometheus（预留 `/metrics` 开关）。
- 夜间任务（API 进程内 cron，`node-cron`）：余额对账（不一致写告警日志并在看板标红）、清理过期 refresh token、清理 0 余额行。

## 5. 部署（docker compose）
```yaml
# infra/docker-compose.yml（摘要）
services:
  db:      { image: postgres:17-alpine, volumes: [pgdata:/var/lib/postgresql/data], env_file: .env, healthcheck: pg_isready }
  api:     { build: ../apps/api, env_file: .env, depends_on: { db: { condition: service_healthy } }, command: "node dist/main.js" }  # 启动时自动跑迁移（drizzle migrate），可用 MIGRATE_ON_START=false 关闭
  web:     { image: caddy:2, ports: ["80:80","443:443"], volumes: [./Caddyfile:/etc/caddy/Caddyfile, ../apps/admin/dist:/srv/admin, caddy_data:/data] }
  backup:  { image: postgres:17-alpine, entrypoint: /backup.sh, volumes: [./backup.sh:/backup.sh, ./backups:/backups] }  # 每日 02:00 pg_dump -Fc，保留 14 日 + 8 周
volumes: { pgdata: {}, caddy_data: {} }
```
- Caddy：`/api/*` → api:3000（SSE 关闭缓冲 `flush_interval -1`），其他 → 管理后台 SPA。
- 升级：`git pull && docker compose build api && docker compose up -d`，迁移只前向（expand/contract）。
- 恢复演练：`scripts/restore.sh <dump>` 到临时库并跑对账校验；文档化 RTO ≤ 1h。
- APK 分发：MVP 由后台"下载 App"页提供 APK + 版本号；App 启动检查 `/api/v1/app/version` 提示更新（不做静默安装）。

## 6. 数据保护
- 个人数据仅限用户名/显示名；日志不记录密码、令牌；备份文件权限 600，可选 GPG 加密异地拷贝（脚本预留）。
