# WS-A2 · 后端：库存 / 同步 / 孪生 / 盘点 / 运行时

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M1（库存引擎 + 同步）→ M4 twin/occupancy/SSE → M4.5 → M5 盘点/看板/审计

## 独占目录（`pnpm check:ownership` 校验）
- `apps/api/src/modules/{inventory,counts,sync,twin,events,audit,dashboard}/**`
- `apps/api/src/jobs/**`（夜间对账、清理；`pg_try_advisory_lock(LOCK_NS.JOB, n)`）
- `packages/domain/src/inventory/**`（`planMovements` 实现，签名已冻结）

## 范围
1. **库存引擎** `postTransaction`（02 §6）：作用域幂等 `(warehouse_id, key)` + `INSERT … ON CONFLICT DO NOTHING` + 新语句 SELECT；JCS `requestHash`（排除 contracts `TXN_HASH_EXCLUDED_FIELDS`）；不同 body 同键 / 不同用户同键 → 409 且不泄露；锁顺序 locations → balances；**锁内**校验容量、禁止混放、停用；`planMovements`；`balancesAfter`；`stock_movements`/`inv_txns` 只追加；`occupancy` 失效 + SSE `stock.changed`。
2. **换班代交**（02 §6.6，v2.2）：`performedBy ≠ 令牌用户` 时校验 `performerSessionId`（属于 performedBy、同设备 `did`、72h 内、早于当前 `sid` 会话、账号启用），否则 403 `PERFORMER_NOT_ALLOWED`；记录 `performed_by / submitted_by / performer_session_id`。
3. **冲正** REVERSAL 规则（不可再冲正、OPERATOR 不能冲正 COUNT_ADJUST、停用仓位 → `LOCATION_INACTIVE`、重复 409 `TXN_ALREADY_REVERSED`）。离线单 `WAITING_STOCK` 语义（仅 `createdOffline`）。
4. **查询**：余额、台账（keyset 分页）、CSV 导出（分批）、locate（只返回 locationId）、低库存。
5. **同步**：`/sync/masterdata`（游标 = 已见最大 updated_at − 180s、tombstones、首次 total）与 digest。
6. **孪生**：`twinModel`（ETag、绑定 layoutVersion）、`occupancy`（内容哈希 ETag、`LAYOUT_STALE`、服务端缓存）；**SSE** `/events`（订阅 `services.bus`，按令牌仓库过滤，25s ping，令牌过期关闭）。
7. **盘点**（M5）：创建、提交即对账（variance 提交时固定）、整体覆盖、`needs_review`（>5 分钟）、close CAS 单事务（余额不足 → `COUNT_RECOUNT_REQUIRED` 整体回滚）。
8. **审计查询**、**看板**、**夜间对账任务**。
9. **scope resolver**：在你的模块 `register(ctx)` 中设置 `ctx.services.scopeResolvers.txn / count`。
10. **演示库存**：提供 `apps/api/src/modules/inventory/seed-stock.ts`（通过 `postTransaction` 写入，保证台账一致），给 WS-B/C/D2 联调用；需要根脚本入口时写 contract request。

## 使用的契约
- **twin**（`apps/api/src/modules/twin/`）：`getTwin` GET /warehouses/:id/twin；`getOccupancy` GET /warehouses/:id/twin/occupancy
- **sync**（`apps/api/src/modules/sync/`）：`syncMasterdata` GET /sync/masterdata；`syncDigest` GET /sync/masterdata/digest
- **inventory**（`apps/api/src/modules/inventory/`）：`postTransaction` POST /inventory/transactions；`reverseTransaction` POST /inventory/transactions/:id/reverse；`listTransactions` GET /inventory/transactions；`getTransaction` GET /inventory/transactions/:id；`listBalances` GET /inventory/balances；`listMovements` GET /inventory/movements；`exportMovements` GET /inventory/movements.csv；`locate` GET /inventory/locate；`lowStock` GET /inventory/low-stock
- **counts**（`apps/api/src/modules/counts/`）：`createCount` POST /counts；`listCounts` GET /counts；`getCount` GET /counts/:id；`listCountLines` GET /counts/:id/lines；`startCount` POST /counts/:id/start；`submitCount` POST /counts/:id/submissions；`reviewCount` POST /counts/:id/review；`closeCount` POST /counts/:id/close；`cancelCount` POST /counts/:id/cancel
- **dashboard**（`apps/api/src/modules/dashboard/`）：`dashboard` GET /dashboard
- **audit**（`apps/api/src/modules/audit/`）：`auditLogs` GET /audit-logs
- **events**（`apps/api/src/modules/events/`）：`events` GET /events

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-a2`（分支 `ws/ws-a2/m1-inventory`，基于 main @ `contract-v1`） |
| 端口 | API **4800** · admin **4810** · mobile **4820**（性能/预览等额外端口用 4830–4899） |
| 数据库 | `wms_ws_a2`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-a2`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-a2
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_a2：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4800/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-a2-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-a2): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-a2.json`：`{"branch":"ws/ws-a2/m1-inventory","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- 09 §2 必过：**#1–#4、#6**（M1），**#7、#8、#14**（M5），**#10、#12、#15、#16、#17**。全部用 `cloneTestDb()` 真库并发测试。
- **基于模型的测试**：fast-check `commands`（随机 INBOUND/OUTBOUND/TRANSFER/ADJUST/REVERSAL/重放）+ 内存 oracle，逐步比对余额，结束跑对账。
- 本机 1k 次交易 p95 < 150ms（取 `flock /tmp/wms3d-perf.lock`）。
- RBAC 自动矩阵（owner=ws-a2 的路由）；所有响应过契约 serializer。
- SSE：登录 → 订阅 → 交易 → 收到 `stock.changed{layoutVersion}`；令牌过期连接被关闭。

## 备注
- 角色级 `transaction_timeout=30s`；任何可能超 30s 的事务用 `withLongTransaction`（BEGIN 前会话级设置，事务内 `SET LOCAL` 无效——已实测）。
- `v_sku_stock`、`v_location_occupancy` 视图与只追加触发器已在迁移 0001；需要新索引/列 → contract request（schema 归 Lead）。
- mock 的库存引擎（`packages/api-client/src/mock/handlers.ts`）可作为行为参考，但以 02 为准。
- 外壳（鉴权、守卫、错误模型）归 WS-A1；你只需在模块内 `routes.register(...)`。A1 合并真实 verifier 之前，测试里可用 `buildApp({ configure })` 注入测试 verifier。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
已合并到 main：ws-a2 M1（57d93db）。请 `git rebase main`。
- ws-a2-1 的决定见请求文件末尾：#1 维持 501 shim；#2 由 A1 加 `AuthContext.exp`，A1 合并后删除 JWT 载荷解析分支；#3 `db:seed:stock` 已加，`pnpm db:reset:dev` 会自动写演示库存；#4、#5 mock 已对齐（FORBIDDEN、closeCount 余额不足、digest 同算法）；#6 backup 键名已转给 WS-F；#7 onListen 维持现状。
- 联合验收 **#5** 在 main 上通过（6 轮交错，“入库先赢”和“发布先赢”两条路径都覆盖到，不存在停用仓位上有库存）：`apps/api/src/test/joint-5.test.ts`。
