# WS-E · 标签（packages/labels）

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M2（5 天）→ M4.5 协作（标签核对）→ M5 ZPL 实验版

## 独占目录（`pnpm check:ownership` 校验）
- `packages/labels/**`

## 范围
按 07 全文：
1. **对外接口**（供 WS-A1 的 labels 端点，变更走 contract request）：
   - `labelTemplates: LabelTemplate[]`（与 contracts `LabelTemplate` 一致，7 个 `LabelTemplateKey`）
   - `renderLabelsPdf(input: { template; dpi: 203|300; startCell?; offsetMm?; items: LabelItem[] }): Promise<Uint8Array>`，`LabelItem = { kind: 'LOCATION'|'RACK'|'SKU'; code; payload; title?; subtitle? }`
   - `renderCalibrationPdf({ template, dpi })`、`checkCapacity(template, payload, dpi) → { ok, modules, max }`
   - M5：`renderLabelsZpl(...)`（实验）
2. bwip-js 4.11 **自定义 drawing** → pdfkit 0.20 矢量（不栅格化），X 维 0.375mm、dpi 对齐；maxModules 容量校验；中文字体子集嵌入；A4 多联起始格与偏移；校准页。

## 使用的契约
contracts `labels.ts`（`LabelTemplateKey`、`LabelTemplate`、`LabelRenderRequest`、`LabelKind`）；条码载荷规则 07 §3 与 `packages/domain` 编码（`WH1.A03-17-C02`、货架 `RA03-L02`、SKU 条码原样）。HTTP 端点由 WS-A1 实现，你只交付库。

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-e`（分支 `ws/ws-e/m2-labels`，基于 main @ `contract-v1`） |
| 端口 | API **4600** · admin **4610** · mobile **4620**（性能/预览等额外端口用 4630–4699） |
| 数据库 | `wms_ws_e`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-e`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-e
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_e：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4600/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-e-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-e): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-e.json`：`{"branch":"ws/ws-e/m2-labels","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- **回读测试**：每个模板 × 203/300dpi 生成 PDF → `pdftoppm`（/usr/bin）栅格化 → `zxing-wasm`（已装在本包 devDependencies）解码，内容与载荷一致。
- 容量：超长载荷被 `checkCapacity` 拒绝；PDF 为矢量（无图像 XObject，字体为子集）。
- 1000 张仓位标签渲染 < 5s。

## 备注
- 中文字体：使用仓库内/系统已有的开源字体（如 Noto Sans CJK 若存在）；不得下载付费字体。没有合适字体时写 contract request。
- 生成的样张放 `/workspace/wms3d-artifacts/ws-e/`。
