# wms3d v0.1.0 服务器部署说明（systemd）

已验证路径是原生二进制：PostgreSQL 17 + Node 24 API + Caddy，由 systemd 托管。详细运维见仓库 `infra/RUNBOOK.md`。Docker compose 随仓库提供，**本机未验证**。

## 1. 产物

本目录（`wms3d-v0.1.0-server/`）由 `infra/native/build-release.sh` 生成：

- `app/`：精简 pnpm workspace（`apps/api` 及其 workspace 依赖 + 生产依赖）
- `admin/`：管理后台静态资源
- `scripts/`：backup / restore / reconcile / golive-check
- `VERSION.json`：构建提交与时间
- 本文件 `DEPLOY.md`

源码仓库中的安装器与单元模板：`infra/native/install.sh`、`infra/native/templates/`。

## 2. 前置依赖

- Node.js ≥ 24、pnpm（仅构建时需要）
- PostgreSQL 17 服务端二进制（`PG_BIN` 或 `WMS_PG_BIN`，缺省 `/opt/tools/pg17/bin`）及同版本 `psql` / `pg_dump` / `pg_restore`
- Caddy 2（`CADDY_BIN`；可用 `infra/native/fetch-caddy.sh` 缓存）
- 目标机以 systemd 为 PID 1（本开发机不是，因此 `--systemd` 未在本机实装）

## 3. 本机冒烟（无需 systemd）

在仓库根目录：

```bash
source /opt/tools/env.sh   # 或自行导出 WMS_PG_BIN、CADDY_BIN
infra/native/install.sh --foreground --smoke
```

步骤：拉起临时前缀上的 PG / API / Caddy → 健康检查与安全头 → 演示数据 → 登录 → 一笔入库 → 备份 → 恢复 → 对账 → `systemd-analyze verify` 校验渲染出的 unit。加 `--keep` 可保留文件。

## 4. 生产安装（systemd）

以 root 在目标机执行（路径按实际调整）：

```bash
sudo CADDY_BIN=/usr/local/bin/caddy \
  infra/native/install.sh --systemd \
  --release /path/to/wms3d-v0.1.0-server \
  --prefix /opt/wms3d \
  --domain wms.example.com \
  --tls acme
```

- `--tls internal`：自签（仅内网试验）
- `--tls acme`：Let's Encrypt（需域名解析）
- `--tls /path/crt,/path/key`：自备证书

安装器会创建系统用户 `wms3d`、initdb、角色/库、写入并 enable 下列单元：

| 单元 | 作用 |
|---|---|
| `wms3d-pg.service` | PostgreSQL 17 |
| `wms3d-api.service` | Fastify API（等待 PG） |
| `wms3d-caddy.service` | 反向代理 / TLS / 静态后台 |
| `wms3d-backup.timer` | 每日 02:00 备份 |

加固选项已写入模板：`NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome`、`PrivateTmp`，仅 `ReadWritePaths` 可写。

默认管理员账号见 `docs/delivery/README.md`（上线后立即修改口令）。可用 `scripts/golive-check.sh` 做上线检查。

## 5. 升级

1. 先备份：`scripts/backup.sh`（见 RUNBOOK）。
2. 构建或解压新的发布目录。
3. 再次执行 `install.sh --systemd --release <新目录> --domain …`（只替换 `app/`、`admin/`、`scripts/`，保留配置与数据）。
4. 健康检查通过后再切流量。

## 6. 备份与恢复

发布包内 `scripts/backup.sh` / `restore.sh` / `reconcile.sql`。本仓库 CI 含 `pnpm backup:drill`。远端 rclone 备份需另行配置，默认未启用。

## 7. 本版本未在目标环境验证的项

- 真实 systemd `--systemd` 安装（开发机 PID 1 不是 systemd）
- ACME / DNS-01
- rclone 真实远端
- `infra/compose` 全套
