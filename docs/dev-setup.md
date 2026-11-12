# 开发环境与运行指南（M0a）

## 1. 工具链（本机 /opt/tools）
```bash
source /opt/tools/env.sh     # JAVA_HOME(JDK 21) / ANDROID_HOME / PG17 二进制 / platform-tools 入 PATH
```
| 工具 | 位置/版本 |
|---|---|
| Node / pnpm | 24.22 / 10.34（系统预装） |
| TypeScript / ESLint / Vitest | 6.0.3 / 10.x / 5.1（仓库内） |
| PostgreSQL 17.11 服务端 | `/opt/tools/pg17`（zonky 二进制）；psql 用系统 `/usr/bin/psql` |
| JDK 21 / Android SDK 36 | `/opt/tools/jdk21`、`/opt/tools/android-sdk` |
| Docker 29.9.3 + compose v5.7.1 | `/opt/tools/docker`（仅 host/none 网络，见 spikes/m0a-docker.md） |

## 2. 仓库结构（M0a 骨架）
```
apps/api        Fastify 外壳：GET /api/v1/health, /api/v1/ready
apps/admin      React 19.3 + AntD 6.7 + Vite 8 外壳
apps/mobile     React + Capacitor 8.6；android/ 原生工程（pre-IME 拦截骨架、网络安全配置、蓝牙权限）
packages/*      contracts / api-client / domain / twin3d / scanner / labels / ui —— 仅占位，接口在 M0b（R2 后）冻结
scripts/        dev-db.sh、wt.sh、ws-config.sh、build-apk.sh、check-ownership.mjs、docker-spike.sh
```

## 3. 常用命令（仓库根）
```bash
pnpm install
pnpm verify          # lint + typecheck + test + build（合并前必须全绿）
pnpm lint | pnpm typecheck | pnpm test | pnpm build | pnpm format
pnpm dev:api         # 端口 PORT_API（默认 4000）
pnpm dev:admin       # 端口 PORT_ADMIN（默认 4010，/api 代理到 PORT_API）
pnpm dev:mobile      # 端口 PORT_MOBILE（默认 4020，浏览器调试移动端）
pnpm apk:debug       # 构建 debug APK → /workspace/wms3d-artifacts/wms3d-debug-<sha>.apk 和 -latest.apk
```
- APK 构建会同时跑 Android JVM 单测（`testDebugUnitTest`），Gradle 通过 `flock /tmp/wms3d-gradle.lock` 全局串行。
- 首次构建会下载 Gradle 8.14.3，约 1–2 分钟；之后约 20 秒。

## 4. 本机数据库（单实例，按工作流分库）
```bash
scripts/dev-db.sh start            # 首次自动 initdb（builtin C.UTF-8），127.0.0.1:55432，数据目录 /workspace/.wms3d-pg
scripts/dev-db.sh create wms_lead  # 建库（属主 wms_owner，wms_app 可连接）
scripts/dev-db.sh url wms_lead     # postgres://wms_app@127.0.0.1:55432/wms_lead（owner 用：url <db> owner）
scripts/dev-db.sh list | status | stop | psql <db> | drop <db>
```
本地开发认证为 trust（仅监听 127.0.0.1）；生产部署见 08 §5。

## 5. 工作流隔离（多 Agent 并行，10 §6）
```bash
scripts/wt.sh create ws-a ws/ws-a/m1-auth   # 建 worktree /workspace/wms3d-wt/ws-a + 库 wms_ws_a + .env.local（端口 4100/4110/4120）+ pnpm install
scripts/wt.sh info ws-a
cd /workspace/wms3d-wt/ws-a && set -a && source .env.local && set +a
pnpm dev:api                                # → 127.0.0.1:4100，/api/v1/ready 连 wms_ws_a
WMS_WS=ws-a pnpm check:ownership            # 检查改动只在本工作流独占目录（.env.local 已含 WMS_WS）
scripts/wt.sh list | remove ws-a [--drop-db]
```
| 工作流 | 序号 | API / admin / mobile 端口 | 数据库 |
|---|---|---|---|
| lead（主仓） | 0 | 4000 / 4010 / 4020 | wms_lead |
| ws-a 后端 | 1 | 4100 / 4110 / 4120 | wms_ws_a |
| ws-b PC 后台 | 2 | 4200 / 4210 / 4220 | wms_ws_b |
| ws-c 移动端 | 3 | 4300 / 4310 / 4320 | wms_ws_c |
| ws-d1 设计器 | 4 | 4400 / 4410 / 4420 | wms_ws_d1 |
| ws-d2 3D | 5 | 4500 / 4510 / 4520 | wms_ws_d2 |
| ws-e 标签 | 6 | 4600 / 4610 / 4620 | wms_ws_e |
| ws-f QA/DevOps | 7 | 4700 / 4710 / 4720 | wms_ws_f |

## 6. M0a 验收记录（2026-11-12 PT）
- `pnpm install`、`pnpm verify`（lint/typecheck/test/build）通过；Vitest 8 个文件 9 通过 + 1 条需 DB 的用例（设 `DATABASE_URL` 后 10/10 通过）。
- debug APK：`/workspace/wms3d-artifacts/wms3d-debug-latest.apk`（com.wms3d.app，targetSdk 36，4.1MB）；`ScanKeyBufferTest` 4/4 通过。
- `scripts/wt.sh create ws-a` 实测：worktree、`wms_ws_a`、端口 4100 上 `/api/v1/ready` 返回 `{"status":"ready","database":"wms_ws_a"}`。
- Docker spike：部分可用（仅 host/none 网络），见 `spikes/m0a-docker.md`。
