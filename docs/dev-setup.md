# 开发环境与运行指南（M0a → M0b，v2.2 · contract-v1）

## 1. 工具链（本机 /opt/tools）
```bash
source /opt/tools/env.sh     # JAVA_HOME(JDK 21) / ANDROID_HOME / PG17 二进制 / platform-tools 入 PATH
```
> 机器重启后若 `/opt/tools` 丢失：`bash scripts/install-tools.sh all`（或 `pg|jdk|android` 单项）重新安装并写出 `/opt/tools/env.sh`；然后 `pnpm install` 与 `scripts/dev-db.sh start`。PG 数据目录权限损坏时只能重新 initdb 后在各 worktree 跑 `pnpm db:reset:dev`。
| 工具 | 位置/版本 |
|---|---|
| Node / pnpm | 24.22 / 10.34（系统预装） |
| TypeScript / ESLint / Vitest | 6.0.3 / 10.x / 5.1（仓库内） |
| PostgreSQL 17.11 服务端 | `/opt/tools/pg17`（zonky 二进制）；psql 用系统 `/usr/bin/psql` |
| JDK 21 / Android SDK 36 | `/opt/tools/jdk21`、`/opt/tools/android-sdk` |
| Docker 29.9.3 + compose v5.7.1 | `/opt/tools/docker`（仅 host/none 网络，见 spikes/m0a-docker.md） |

## 2. 仓库结构（M0b，contract-v1）
```
packages/contracts   Zod schema（单一真相源）+ routes.ts（75 个端点：roles/scope/owner）+ openapi.ts → openapi.json（pnpm gen:contracts）
packages/domain      编码/几何/布局展开与校验/扫码分类（签名冻结）、黄金样例 __fixtures__、demo 数据集（386 仓位/24 SKU/5 用户）
packages/api-client  类型化客户端（single-flight 刷新）、SSE（fetch+eventsource-parser）、幂等键；mock/：契约驱动 mock（MSW + Fastify）
apps/api             Fastify 外壳：src/app.ts、lib/（problem+json、守卫、CORS、事件总线）、modules/<tag>/（每个 contracts tag 一个模块）、
                     db/（schema.ts、migrations/、migrate.ts、seed-demo.ts、locks.ts、client.ts —— 归 Lead）、test/pg.ts（克隆测试库）
apps/admin           React 19.3 + AntD 6.7 + Vite 8（登录页已接 api-client）
apps/mobile          React + Capacitor 8.6；android/ 原生工程（pre-IME 拦截、ScanKeyBuffer）
packages/twin3d | scanner | labels | ui   各 WS 实现（依赖已预装）
scripts/             dev-db.sh、test-db.sh、db-reset-dev.sh、wt.sh、install-tools.sh、build-apk.sh、check-ownership.mjs
docs/workstreams/    各工作流自包含简报
```
未实现的真实 API 路由统一返回 501 `NOT_IMPLEMENTED`（problem+json）；实现方式：在 `modules/<tag>/index.ts` 里 `routes.register(contractsRoute, handler)`，守卫（鉴权、角色、改密、Idempotency-Key、If-Match、仓库作用域、设备）由 `lib/routing.ts` 按路由元数据自动套用。

## 3. 常用命令（仓库根）
```bash
pnpm install
pnpm verify          # lint + typecheck + test + build（合并前必须全绿）
pnpm lint | pnpm typecheck | pnpm test | pnpm build | pnpm format
pnpm dev:api         # 端口 PORT_API（默认 4000）
pnpm dev:admin       # 端口 PORT_ADMIN（默认 4010，/api 代理到 PORT_API）
pnpm dev:mobile      # 端口 PORT_MOBILE（默认 4020，浏览器调试移动端）
pnpm mock            # 契约驱动 mock API（PORT_API；演示账号 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm db:reset:dev    # 重建本 WS 自己的库：删库→建库→迁移→演示数据（只碰 .env.local 里的 wms_<ws>）
pnpm gen:contracts   # 重新生成 openapi.json 与黄金样例（仅 Lead）
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

### 4.1 测试库（每个 WS 自己的模板，v2.1 B-N8）
```bash
scripts/test-db.sh template ws-a1     # 建/复用 wms_tpl_ws_a1_<迁移哈希8位>（flock 串行；IS_TEMPLATE；旧哈希自动删）
scripts/test-db.sh clone ws-a1        # 输出新库名 t_ws_a1_<rand>（测试文件开头调用）
scripts/test-db.sh drop t_ws_a1_xxxx  # 测试结束删除
scripts/test-db.sh gc ws-a1           # 清理本 WS 残留测试库
```
迁移出现前（M0a）哈希为 `nomig000`；M0b 起由 `apps/api` 的 `db:migrate:url` 脚本把迁移应用到模板库。

## 5. 工作流隔离（多 Agent 并行，10 §6）
```bash
scripts/wt.sh create ws-a1 ws/ws-a1/m1-auth   # 建 worktree /workspace/wms3d-wt/ws-a1 + 库 wms_ws_a1 + .env.local（端口 4100/4110/4120）+ pnpm install
scripts/wt.sh create lead lead/m0b-contracts  # Lead 也在 worktree 开发（/workspace/wms3d-wt/lead）
scripts/wt.sh info ws-a1
cd /workspace/wms3d-wt/ws-a1 && set -a && source .env.local && set +a
pnpm dev:api                                  # → 127.0.0.1:4100，/api/v1/ready 连 wms_ws_a1
pnpm check:ownership                          # 检查改动只在本工作流独占目录（.env.local 已含 WMS_WS）；任何 package.json / lockfile 改动都会被拒
scripts/wt.sh list | remove ws-a1 [--drop-db]
```
**规则（v2.1，B-N10）**：主仓 `/workspace/wms3d`（main）只做合并，不开发；M0a 在 main 上开发是书面的一次性例外。合并请求写到 git 之外的队列目录 `/workspace/.wms3d-queue/<UTC时间戳>-<ws>.json`（`{branch, commit, verify, depsChanged, notes}`），Lead 处理后移到 `done/`。契约/依赖请求写 `docs/contract-requests/<ws>-<n>.md`（任何 WS 可写）。
| 工作流 | 序号 | API / admin / mobile 端口 | 数据库 |
|---|---|---|---|
| lead（worktree `wms3d-wt/lead`） | 0 | 4000 / 4010 / 4020 | wms_lead |
| ws-a1 后端：主数据/布局/标签端点 | 1 | 4100 / 4110 / 4120 | wms_ws_a1 |
| ws-b PC 后台 | 2 | 4200 / 4210 / 4220 | wms_ws_b |
| ws-c 移动端 | 3 | 4300 / 4310 / 4320 | wms_ws_c |
| ws-d1 设计器 | 4 | 4400 / 4410 / 4420 | wms_ws_d1 |
| ws-d2 3D | 5 | 4500 / 4510 / 4520 | wms_ws_d2 |
| ws-e 标签 | 6 | 4600 / 4610 / 4620 | wms_ws_e |
| ws-f QA/DevOps | 7 | 4700 / 4710 / 4720 | wms_ws_f |
| ws-a2 后端：库存/盘点/同步/孪生 | 8 | 4800 / 4810 / 4820 | wms_ws_a2 |

## 6. M0a 验收记录（2026-11-12 PT）
- `pnpm install`、`pnpm verify`（lint/typecheck/test/build）通过；Vitest 8 个文件 9 通过 + 1 条需 DB 的用例（设 `DATABASE_URL` 后 10/10 通过）。
- debug APK：`/workspace/wms3d-artifacts/wms3d-debug-latest.apk`（com.wms3d.app，targetSdk 36，4.1MB）；`ScanKeyBufferTest` 4/4 通过。
- `scripts/wt.sh create ws-a1` 实测（v2.1 拆分后重做）：worktree、`wms_ws_a1`、端口 4100 上 `/api/v1/ready` 返回 `{"status":"ready","database":"wms_ws_a1"}`；`check:ownership` 通过。`test-db.sh template/clone/gc ws-a1` 实测通过。
- R2 涉及 M0a 的修复已落地：包住 `android.R.id.content` 根布局（M-N16）、`minHuaweiWebViewVersion` + `server.errorPath` ES5 页 + 运行时特性检测（M-N8），APK 已重建。
- Docker spike：部分可用（仅 host/none 网络），见 `spikes/m0a-docker.md`。

## 7. M0b 运行方式（2026-11-12 PT）
- **前端对 mock**：`pnpm mock`（Fastify，含 SSE）+ `pnpm dev:admin` / `pnpm dev:mobile`（Vite 把 `/api` 代理到 PORT_API）；或纯浏览器 `VITE_API_MOCK=msw pnpm dev:admin`（MSW，Service Worker 在 `public/mockServiceWorker.js`）。Vite 监听 `localhost`（不是 127.0.0.1）。
- **后端对真实库**：`pnpm db:reset:dev` 后 `pnpm dev:api`；`WMS_MIGRATE_ON_START=1` 时启动先迁移。Swagger：`http://127.0.0.1:$PORT_API/api/v1/docs`，OpenAPI：`/api/v1/openapi.json`。
- **迁移**：`apps/api/src/db/migrations/0000_init.sql`（drizzle 生成）+ `0001_constraints.sql`（手写：COLLATE "C"、DEFERRABLE 唯一、只追加触发器、视图、授权）。迁移器持 `pg_advisory_lock(LOCK_NS.MIGRATION, 0)`；以 owner 连接（`MIGRATION_DATABASE_URL`），运行时用 `wms_app`（角色级 `transaction_timeout=30s`）。长事务用 `withLongTransaction(pool,'120s',fn)`。
- **测试库**：`import { cloneTestDb, pgAvailable } from '../test/pg.ts'`，每个测试文件克隆自本 WS 模板；PG 未启动或 `WMS_SKIP_DB_TESTS=1` 时 DB 用例跳过。
- **验收**：`pnpm verify` 在 main 全绿（Vitest：contracts 24、domain 25、api 含 DB 用例、api-client mock 10）；mock 驱动 admin/mobile 登录截图 `/workspace/wms3d-artifacts/m0b-mock-login-{admin,mobile}.png`。
