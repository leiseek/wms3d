# WS-A1 · 后端：认证 / 主数据 / 布局 / 标签端点

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M1（5 天）→ M2 标签端点 → M4.5 联调 → M5 审计页接口支持

## 独占目录（`pnpm check:ownership` 校验）
- `apps/api/src/{app.ts,app.test.ts,main.ts}`、`apps/api/src/plugins/**`、`apps/api/src/lib/**`（API 外壳与守卫由你维护）
- `apps/api/src/modules/{ops,auth,users,warehouses,layout,locations,skus,scan,labels}/**`
- `packages/domain/src/scan/**`（classifyScan 实现完善）

## 范围
1. **认证**（03 §2、08）：argon2id 登录（web 设 httpOnly cookie `wms_rt`，mobile 返回 refreshToken）、JWT HS256（`kid` 轮换；claims `sub, role, wh, did, sid`，见 contracts `AccessClaims`）、刷新轮换 + **同设备 60s 宽限返回兄弟 token**、不同设备重用 → 撤销 family、登出、`me`、改密（`mustChangePassword` 守卫已在外壳）、登录限流与锁定、登录失败审计聚合。登录响应 `session.id` 即 `device_sessions.id`（换班代交用）。
2. **把外壳占位换成真实实现**：`services.verifyToken`（现为 `rejectAllVerifier`）、`scopeResolvers.location / reprint`（`txn / count` 由 A2 提供）、`deviceGuard`（`devices.disabled_at` → 403 `DEVICE_DISABLED`）。在 `app.ts` 的 `createServices` 处装配；A2 会在自己的模块 `register` 里注入它的 resolver。
3. **用户/设备**（含心跳 `pendingCount` 写入、`appVersion`）、**仓库**（编码模式锁定、`published_layout_version`）、**模板库 rack_types**。
4. **布局**（02 §3–§4、05）：草稿 CRUD（If-Match 版本 → 412 `PRECONDITION_FAILED`）、`validate`（调 `@wms3d/domain` 的 `expandLayout/validateLayout`）、差异四类（validate 返回 diff）、**发布**：`withLongTransaction(pool,'120s',…)` + `pg_advisory_xact_lock(LOCK_NS.LAYOUT_PUBLISH, whNo)` + `LOCK_NS.BARCODE`；两轮匹配复用 `location.id`、改码确认、DEFERRABLE 互换、停用有货仓位拒绝、自动生成补打请求、`barcode_registry` 维护；提交后发布 `layout.published` / `locations.changed` 事件（`services.bus`）。
5. **仓位**列表/PATCH/批量（运行时属性：容量、混放、停用）。
6. **SKU/条码**：CRUD、条码登记表（跨实体唯一）、CSV 导入（分批 1000、预检报告、公式注入防护）与导出。
7. **扫码解析** `scanResolve`（先精确匹配登记表，再按编码模式分类；WRONG_WAREHOUSE）。
8. **标签端点**（M2，依赖 WS-E 的 `@wms3d/labels`）：模板列表、渲染（PDF 流）、校准页、补打请求队列。WS-E 合并前可先做补打队列与参数校验，渲染调用用本地 shim。
9. 本模块范围内的审计写入**与业务同事务**（`audit_logs`）。

## 使用的契约
- **ops**（`apps/api/src/modules/ops/`）：`health` GET /health；`ready` GET /ready；`appVersion` GET /app/version
- **auth**（`apps/api/src/modules/auth/`）：`authLogin` POST /auth/login；`authRefresh` POST /auth/refresh；`authLogout` POST /auth/logout；`me` GET /me；`changePassword` POST /me/password
- **users**（`apps/api/src/modules/users/`）：`listUsers` GET /users；`createUser` POST /users；`getUser` GET /users/:id；`patchUser` PATCH /users/:id；`resetPassword` POST /users/:id/reset-password；`listDevices` GET /devices；`patchDevice` PATCH /devices/:id；`heartbeat` POST /devices/heartbeat
- **warehouses**（`apps/api/src/modules/warehouses/`）：`listWarehouses` GET /warehouses；`createWarehouse` POST /warehouses；`getWarehouse` GET /warehouses/:id；`patchWarehouse` PATCH /warehouses/:id；`listZones` GET /warehouses/:id/zones；`listRacks` GET /warehouses/:id/racks
- **layout**（`apps/api/src/modules/layout/`）：`listRackTypes` GET /rack-types；`createRackType` POST /rack-types；`patchRackType` PATCH /rack-types/:id；`listLayoutVersions` GET /warehouses/:id/layout/versions；`getLayout` GET /warehouses/:id/layout；`createDraft` POST /warehouses/:id/layout/draft；`saveDraft` PUT /warehouses/:id/layout/draft；`deleteDraft` DELETE /warehouses/:id/layout/draft；`validateLayout` POST /warehouses/:id/layout/validate；`publishLayout` POST /warehouses/:id/layout/publish
- **locations**（`apps/api/src/modules/locations/`）：`listLocations` GET /warehouses/:id/locations；`patchLocation` PATCH /locations/:id；`bulkPatchLocations` PATCH /warehouses/:id/locations/bulk
- **skus**（`apps/api/src/modules/skus/`）：`listSkus` GET /skus；`createSku` POST /skus；`getSku` GET /skus/:id；`patchSku` PATCH /skus/:id；`addSkuBarcode` POST /skus/:id/barcodes；`deleteSkuBarcode` DELETE /skus/:id/barcodes/:barcodeId；`importSkus` POST /skus/import；`exportSkus` GET /skus/export.csv
- **scan**（`apps/api/src/modules/scan/`）：`scanResolve` GET /scan/resolve
- **labels**（`apps/api/src/modules/labels/`）：`listLabelTemplates` GET /labels/templates；`renderLabels` POST /labels/render；`calibrationPdf` GET /labels/calibration.pdf；`listReprints` GET /label-reprint-requests；`createReprint` POST /label-reprint-requests；`patchReprint` PATCH /label-reprint-requests/:id

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-a1`（分支 `ws/ws-a1/m1-auth-layout`，基于 main @ `contract-v1`） |
| 端口 | API **4100** · admin **4110** · mobile **4120**（性能/预览等额外端口用 4130–4199） |
| 数据库 | `wms_ws_a1`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-a1`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-a1
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_a1：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4100/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-a1-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-a1): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-a1.json`：`{"branch":"ws/ws-a1/m1-auth-layout","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- 09 §2 必过：**#9** 跨仓 locationId 越权 404、**#11** 刷新并发（宽限/兄弟 token/撤销 family）、**#13** 删除货架原位重画复用 id、**#5** 布局发布停用 × 入库并发（与 A2 联合，A2 合并后补）、**#17** 发布事务 60s 不被终止。
- **RBAC 自动矩阵**：遍历 `routeList` 中 owner=ws-a1 的路由 × 5 个角色 × 跨仓，断言 401/403/404 与 contracts `roles/scope` 一致（全部返回体由 serializer 按契约校验）。
- 布局：黄金样例布局发布后 386 仓位、编码与 `packages/domain` 一致；改码互换不撞唯一约束；412 冲突。
- CSV：1 万行导入 < 10s，错误行报告准确，`=cmd` 类单元格被转义。
- `app.test.ts` 现有用例保持全绿（实现后把 501 断言换成真实断言）。

## 备注
- 守卫顺序与问题响应已在 `lib/routing.ts`、`lib/problem.ts` 实现：preValidation（鉴权→改密→角色→Idempotency-Key→If-Match）、preHandler（仓库作用域，失败一律 404 → 设备检查）。处理函数里拿 `req.auth`、`req.warehouseId`。
- 实现一个端点：在 `modules/<tag>/index.ts` 中 `routes.register(routes.<id>, async (ctx) => …)`；未注册的仍返回 501。
- schema/迁移归 Lead：需要新列/索引 → contract request。`apps/api/src/db/schema.ts` 可读不可改。
- mock（`packages/api-client/src/mock/handlers.ts`）是行为参考，真实实现以设计文档为准；发现 mock 与设计不符写 contract request。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
已合并到 main：ws-a1 M1（9dca982）。请 `git rebase main`（tag `contract-v1.2`）。
- **a1-1 接受**：契约 changePassword 现在只列 `VALIDATION_FAILED`；mock 已对齐。
- **a1-2 方案 A**：`LabelRenderRequest.warehouseId` 必填；`renderLabels.alsoProduces` 含 ZPL；A4+ZPL 保持 400；可以删掉 warehouseId 缺省分支。
- **a1-3**：mock 模板已照抄 `@wms3d/labels`。
- **a1-4**：进程内锁定作为 MVP 书面接受（03 §2）；`login_lockouts` 落库排到 v1.1，本轮无 schema 变更。
- **a1-5**：由 WS-D1 在 domain `validateLayout` 实现（CODE_DUPLICATE）；**D1 合并前保留** `plan.ts#extraIssues`，合并后删除。
- **新任务（来自 ws-a2-1 #2）**：在 `lib/auth.ts` 的 `AuthContext` 加 `exp?: number`（JWT exp，秒），由 verifier 填充，供 SSE 关流使用。
- 联合验收 **#5** 已在 main 通过：`apps/api/src/test/joint-5.test.ts`（Lead 维护）。
