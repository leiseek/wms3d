# 部署路径 B：docker compose —— ⚠️ 未在本机运行验证

> 08 §5.2、M0a Docker spike（docs/spikes/m0a-docker.md）：本机容器环境没有 iptables，dockerd 只能 `--bridge=none`，
> 默认 bridge 网络与端口映射**无法在本机验证**。本目录的文件**只做了静态校验**（YAML 语法解析 + `caddy validate`），
> 镜像构建、启动顺序、迁移、健康检查、备份容器均**未实际运行**。已验证的部署路径是 `infra/native/`（原生 + systemd）。

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 服务 `postgres` / `api` / `caddy` / `backup`（D38 统一服务名） |
| `docker-compose.host.yml` | 覆盖文件：全部 `network_mode: host`（spike 结论：本机唯一可能跑起来的网络模式，供 M6 有限验证） |
| `api.Dockerfile` | Node 24 + pnpm，按 lockfile 只装 `@wms3d/api` 的生产依赖；以 TS 源码运行（Node 原生剥离类型） |
| `caddy.Dockerfile` | 多阶段：构建 admin 静态资源 → `caddy:2` |
| `Caddyfile` | 与原生路径同一套路由（/api、SSE 不缓冲、SPA 回退、安全头） |
| `initdb/01-roles.sh` | 首次初始化：建 `wms_owner` / `wms_app`、库与超时设置 |
| `backup-loop.sh` | 备份容器：每日 02:00（`TZ`）调用 `scripts/backup.sh`（与原生路径同一脚本） |
| `.env.example` | 复制为 `.env` 后填写（密码、JWT、域名、BACKUP_REMOTE） |

```bash
cd infra/compose
cp .env.example .env && $EDITOR .env           # 必填：POSTGRES_PASSWORD / WMS_OWNER_PASSWORD / WMS_APP_PASSWORD / JWT_SECRET / WMS_DOMAIN
docker compose up -d --build                    # 标准主机（有 bridge 网络）
docker compose -f docker-compose.yml -f docker-compose.host.yml up -d --build   # 无 bridge 网络的主机
docker compose exec backup /scripts/backup.sh --db wms3d --dir /backups        # 立即备份一次
```
静态校验：本机 `/opt/tools/docker` 已不存在（机器重启后丢失），本次只做了 YAML 语法解析（`yaml` 库）与 `caddy validate`（Caddyfile 通过）；`docker compose config` 待 M6 重装 Docker 后执行。
上线前仍须走 `scripts/golive-check.sh`（异地备份为阻断项）。
