# WS-D2 · 3D 孪生（packages/twin3d）

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M4（5 天；第 2 天交付 v0）→ M4.5 接入后台大屏 / 移动 3D Tab / 设计器预览

## 独占目录（`pnpm check:ownership` 校验）
- `packages/twin3d/**`（可在包内建 `playground/`，Vite 端口用 4530–4599）

## 范围
按 06 全文：
1. **对外接口**（供 WS-B/C/D1，变更走 contract request）：`<TwinView model={TwinModel} occupancy={Occupancy|null} colorMode highlight={string[]} onPick={(locationId)=>void} cameraPreset />`、`buildTwinIndex(model) → { idToIndex, indexToId }`、`detectWebGL2()`、`Twin2DFallback`（同 props 的 2D 降级）。类型来自 `@wms3d/contracts`（`TwinModel`、`Occupancy`）。
2. 第 2 天 **v0**：地面 + 按巷道分块框架 + 仓位方块，按 `packages/domain` 黄金样例对齐（`cellWorld` 等几何函数）。
3. 之后：空/有货双 mesh 槽位切换、着色模式与图例、解析式拾取、相机预设与飞行、按块 LOD（滞回）+ 视锥裁剪、高亮/光柱、troika 文本、层过滤、WebGL2 检测与 2D 降级、上下文丢失重建、启动基准。
4. 性能基准脚本（5k/20k 仓位，3 个固定机位，记录 draw calls/三角形/首屏时间）。

## 使用的契约
`twinModel`（GET /warehouses/{id}/twin，ETag）、`occupancy`（`?layoutVersion=`，内容哈希 ETag、`LAYOUT_STALE`）、SSE `stock.changed` / `locations.changed` / `layout.published`（`connectEvents`）。数据可直接用 `createMockApi()`（`@wms3d/api-client/mock`）在 playground 里取，或 `pnpm mock`。

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-d2`（分支 `ws/ws-d2/m4-twin3d`，基于 main @ `contract-v1`） |
| 端口 | API **4500** · admin **4510** · mobile **4520**（性能/预览等额外端口用 4530–4599） |
| 数据库 | `wms_ws_d2`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-d2`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-d2
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_d2：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4500/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-d2-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-d2): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-d2.json`：`{"branch":"ws/ws-d2/m4-twin3d","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- 06 §8 预算两档（Chrome 自动化，`/opt/google/chrome/chrome` + Playwright）：5k ≤150k 三角形、20k ≤300k、draw call ≤ 80；首屏时间记录。取 `flock /tmp/wms3d-perf.lock` 再跑。
- 单测：槽位归属（空/有货切换不重建）、`idToIndex`、拾取（解析式命中正确 locationId）、黄金样例坐标一致。

## 备注
- 不依赖真实 API；playground 只读 mock。截图放 `/workspace/wms3d-artifacts/ws-d2/`。
- 需要大规模（20k）测试布局：在包内用 `@wms3d/domain` 的 `expandLayout` 生成，不要改 demo 数据。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
已合并到 main：twin3d v0（eea53c8）与 M4 完整范围（d283d62）。

### M4.5 打磨项
1. **等轴视角下占用着色发灰、偏淡**：在 isometric 机位中，有货 / 空 / 满的颜色饱和度不够、对比偏弱（可能是光照、tone mapping 或材质颜色空间造成的）。请检查 `colorSpace`/`toneMapping` 与环境光强度，确保图例色与 3D 中看到的颜色一致，并在 3 个固定机位截图对比。
2. **图例文案 “中（50%）” 读起来别扭**：改为表达占用区间，例如 “半满（30–70%）”，或同时给出档位名与区间（“低 <30% / 中 30–70% / 高 >70%”），与 06 §4 的分档一致；2D 降级的图例同步修改。
3. **troika 类型声明（来自 ws-c-1 #3）**：让 `troika.d.ts` 从 `src/index.ts` 可达（例如 `/// <reference>` 或模块声明随导出），之后 apps/mobile 可以去掉 tsconfig 中的 include。

## Lead 更新 · ws-d1 合并（2026-11-12 PT）
- 打磨项 3（troika 类型）**已由 Lead 完成**：`src/labels.ts` 顶部加了 `/// <reference path="./troika.d.ts" />`（一行集成修复，ws-d1-1 / ws-c-1 都提了这个请求）。rebase 时注意这一行。打磨项 1、2 仍归你，M4.5 处理。
