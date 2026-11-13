# WS-B · PC 后台（除布局设计器）

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M2（5 天）→ M4.5 联调（3D 大屏页）→ M5 盘点/看板/审计页

## 独占目录（`pnpm check:ownership` 校验）
- `apps/admin/**`，**不含** `apps/admin/src/features/layout-designer/**`（WS-D1）

## 范围
1. 应用骨架：react-router 8 路由、AntD 6.7 布局、TanStack Query 5、基于 `apps/admin/src/api.ts`（`createApiClient`，web 模式 cookie 刷新）的数据层、全局错误（problem+json → 中文提示）、权限菜单（按 `me.role`）、仓库切换。
2. 登录 / 强制改密。
3. SKU 管理 + **CSV 导入向导**（预检报告、错误下载）+ 导出。
4. 仓位列表与批量编辑（容量、混放、停用）。
5. 库存：余额查询、台账（keyset 分页、CSV 导出）、交易详情、**冲正**、调整/移库（`Idempotency-Key` 用 `newIdempotencyKey()`）。
6. 用户与设备（禁用设备、重置密码、心跳/待同步数）。
7. **标签打印页**：模板选择、预览、校准页、偏移设置、补打队列、打印指引（07 §4）。
8. 路由 `/layout` 挂载 WS-D1 的 `LayoutDesignerPage`（从 `src/features/layout-designer/index.tsx` 导出；D1 合并前放占位）。
9. M4.5：3D 大屏页（`@wms3d/twin3d` 的 `TwinView` + SSE `connectEvents` 刷新 occupancy）、SKU 定位联动。M5：盘点创建/审核/关闭、看板、审计页、低库存。

## 使用的契约
使用 `@wms3d/api-client`（`client.r.<routeId>(…)` 全类型）与 `@wms3d/contracts` 类型。全部 75 个端点见 `packages/contracts/src/routes.ts`；后台主要用 auth、users、warehouses、locations、skus、inventory、labels、counts、dashboard、audit、twin、events。开发期对 mock：`pnpm mock` + `pnpm dev:admin`（`/api` 代理）或 `VITE_API_MOCK=msw pnpm dev:admin`。mock 每个 JSON 响应都按契约校验过。

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-b`（分支 `ws/ws-b/m2-admin`，基于 main @ `contract-v1`） |
| 端口 | API **4200** · admin **4210** · mobile **4220**（性能/预览等额外端口用 4230–4299） |
| 数据库 | `wms_ws_b`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-b`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-b
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_b：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4200/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-b-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-b): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-b.json`：`{"branch":"ws/ws-b/m2-admin","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- Playwright 后台用例（放 `apps/admin/e2e/`，对 `pnpm mock` 跑）：登录→改密、SKU CSV 导入（含错误行）、仓位批量停用、入库后余额与台账、冲正、标签预览与补打队列、权限菜单（viewer 无写按钮）。
- Vitest 组件/数据层测试（problem+json 映射、401 刷新后重试由 api-client 保证，不要重复实现）。
- `pnpm build` 产物无报错；首屏 JS gzip < 600KB（不含 3D 页懒加载块）。

## 备注
- 不要自己 fetch，统一走 api-client；需要新端点或字段 → contract request。
- 3D 页懒加载 `@wms3d/twin3d`（WS-D2 第 2 天交付 v0）。
- 截图证据放 `/workspace/wms3d-artifacts/ws-b/`。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
可直接对 main 的 mock 开发：
- 改密：当前口令错误 / 新旧相同 → 400 `VALIDATION_FAILED`，按 `errors[].path` 标在对应字段上。
- 标签打印页：`renderLabels` 的 `warehouseId` 必填；`format: 'ZPL'` 返回 `application/vnd.zebra.zpl`（A4 模板 400，UI 应禁用该组合）；kind 必须在模板 `kinds` 内（RACK 只用 rack-100x150）；响应头 `X-Label-Count` / `X-Reprints-Done`；模板 maxModules 已是真实值，可以直接做容量提示。
- OPERATOR 冲正违规：403 `FORBIDDEN`。真实后端 A1/A2/E 已合并；`pnpm db:reset:dev` 会带演示库存。

## Lead 更新 · ws-d1 合并（2026-11-12 PT）
- **`LayoutDesignerPage` 已在 main**（ws-d1 a6153a4，合并提交 a716595）：`import { LayoutDesignerPage } from './features/layout-designer'`（`apps/admin/src/features/layout-designer/index.tsx`），props `{ api, warehouseId, canPublish?, canEdit?, height? }`。挂到路由 `/layout`，按 `me.role` 传 `canEdit`（ADMIN/MANAGER 可编辑草稿）/ `canPublish`（**仅 ADMIN** 可发布，见契约 `publishLayout.roles` 与 08 §1；此处 v1.3 更正，原写“MANAGER/ADMIN 可发布”有误），`api` 传你的 api-client 实例。
- twin3d 的 troika 类型现在随包导出：挂 `TwinView` 时不需要在 admin 里加 reference 或 include。

## Lead 更新 · contract-v1.3（2026-11-13 PT）
已合并到 main（862f7ab）。v1.3：mock 的 SKU 导入会解析 CSV 并返回错误行（字段 `file`），服务端预检路径现在可以对 mock 做 E2E；`performedByName/submittedByName/userName` 可选字段已加（mock 有值，真实 API 待 A2 填充，缺省时回退到 id）；`balances.csv` 已在 M4.5 / contract-v1.4.0 落地。**发布按钮仅 ADMIN**（上面 LayoutDesignerPage 一节已更正）。
