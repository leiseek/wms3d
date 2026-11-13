# WS-D1 · 布局设计器（2D）与 domain/layout

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M2D（5 天）→ M4.5 设计器 3D 预览分屏

## 独占目录（`pnpm check:ownership` 校验）
- `apps/admin/src/features/layout-designer/**`（对外只导出 `index.tsx` 的 `LayoutDesignerPage`，由 WS-B 挂到 `/layout`）
- `packages/domain/src/layout/**` 与 `packages/domain/src/core/**`（编码、几何、展开、校验）；黄金样例 `packages/domain/src/__fixtures__/**` 与 demo 数据归 Lead，`golden.test.ts` 必须保持全绿

## 范围
1. `domain/layout` 完善：**RACK_OVERLAP**（OBB 分离轴）、**RACK_OUTSIDE_ZONE**（多边形包含）、bay 区间与编码长度校验、阵列复制递增 `bayStart` 与奇偶侧；公共签名（`packages/domain/src/index.ts`）不变。
2. Konva 画布（react-konva 19.3.2；坐标约定 02 §2）：货架放置/拖动/吸附/90° 旋转、阵列复制、库区多边形、属性面板（编码预览）、撤销重做、实时校验。
3. 草稿：`getLayout/createDraft/saveDraft`（If-Match，空闲 2s 有变化才自动保存；412 三方提示）、`validateLayout`（含差异）、**发布差异弹窗**（改码确认、待补打清单）→ `publishLayout`。
4. 立面视图（2D 网格；运行时属性直接 PATCH locations）。
5. M4.5：3D 预览分屏接 `@wms3d/twin3d`。

## 使用的契约
layout 系列端点（`getLayout`、`listLayoutVersions`、`createDraft`、`saveDraft`（If-Match）、`deleteDraft`、`validateLayout`（返回 issues + diff + locationCount）、`publishLayout`、`listRackTypes/createRackType/patchRackType`，以及 `patchLocation` 等 tag=locations 端点）与 contracts `LayoutDoc`（`packages/contracts/src/layout.ts`）；mock 已实现草稿/校验/发布（含删除 SHP-01 后发布 v2 的用例）。

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-d1`（分支 `ws/ws-d1/m2d-designer`，基于 main @ `contract-v1`） |
| 端口 | API **4400** · admin **4410** · mobile **4420**（性能/预览等额外端口用 4430–4499） |
| 数据库 | `wms_ws_d1`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-d1`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-d1
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_d1：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4400/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-d1-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-d1): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-d1.json`：`{"branch":"ws/ws-d1/m2d-designer","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- `packages/domain` 单测：OBB 重叠/越区/边界相切不报、黄金样例 0/90/180/270° 不变；fast-check：随机布局展开后编码唯一、`expand ∘ 坐标` 与 `cellWorld` 一致。
- Playwright（对 mock）：30 分钟脚本化设计 200 仓位并发布（可用阵列复制）；412 冲突三方提示；改码确认弹窗；黄金样例在 2D 中渲染与 `geometry-golden.json` 一致（截图 + 坐标断言）。

## 备注
- `apps/admin` 其余部分归 WS-B：只在 `features/layout-designer/` 内写代码；需要 antd 主题/路由改动请 WS-B 或 Lead 处理（contract request）。
- 改 `core/` 的几何或编码会影响后端、3D、标签：任何黄金样例变化 = 契约变更，必须走 contract request。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
- **新任务（来自 ws-a1-5，已接受）**：在 `validateLayout` 中以 `CODE_DUPLICATE`（ERROR，填充 rackKeys / codes）报告三类重复：① doc 内重复的 `racks[].key`；② 重复的 `zones[].code`；③ 展开后重复的货架编码（会撞 `racks unique(warehouse_id, code)`）。补单测；编辑器即时提示。合并后 WS-A1 会删除服务端的 `extraIssues` 补检。
- 契约 v1.2 无布局相关变更；请 `git rebase main`。

## Lead 更新 · ws-d1 合并（2026-11-12 PT）
已合并到 main（a716595）。ws-d1-1 已处理：golden 夹具改为矩形 → 请把 `RACK_OUTSIDE_ZONE_SEVERITY` 改为 `'ERROR'`；twin3d 已导出 troika 声明 → 删除 `TwinPreview.tsx` 里的 reference。仍待做：ws-a1-5 的 `CODE_DUPLICATE` 三类检查（见上一节）。

## Lead 更新 · contract-v1.3（2026-11-13 PT）
权限更正：`canPublish` 仅 ADMIN（契约与 08 §1），MANAGER 只能编辑草稿和校验。
