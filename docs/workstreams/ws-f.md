# WS-F · QA 与 DevOps

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M1 seed/CI → M2–M3 e2e → M4 性能 → M4.5 → M6 加固与交付（主导）

## 独占目录（`pnpm check:ownership` 校验）
- `infra/**`、`scripts/**`（`dev-db.sh`、`test-db.sh`、`wt.sh` 是全员共用工具：改动必须向后兼容，合并说明写清楚）、`e2e/**`

## 范围
1. **本地 CI 脚本**：`scripts/ci-local.sh`（verify + check:ownership + 可选 DB 用例 + apk），结果写 `/workspace/wms3d-artifacts/ci/`。
2. **跨端 e2e 框架** `e2e/`（Playwright 1.65 + `/opt/google/chrome/chrome`）：起 API（真实库，`wms_ws_f`）+ admin + mobile 的编排；演示脚本“建仓→设计→发布→打印→导入→上架（离线+在线）→定位→出库”（M4.5 前先对 mock 跑骨架）。
3. **性能**：1k 交易 p95、3D 基准的统一运行器（遵守 `/tmp/wms3d-perf.lock`）。
4. **部署**：`infra/native/install.sh`（systemd 单元 + `--foreground` 模式；PG/API/Caddy；健康检查）本机冒烟；compose 文件标注“未验证”；备份/恢复演练脚本（异地拷贝目标为配置项，不连接任何外部服务）。
5. M6：安全清单（OWASP ASVS L1、`pnpm audit` 离线可用部分）、release APK 流程、用户手册与运维手册草稿。

## 使用的契约
全部端点（e2e 只经 `@wms3d/api-client` 或 HTTP），`/api/v1/health`、`/ready`（含 `contractVersion`）。

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-f`（分支 `ws/ws-f/m1-qa-infra`，基于 main @ `contract-v1`） |
| 端口 | API **4700** · admin **4710** · mobile **4720**（性能/预览等额外端口用 4730–4799） |
| 数据库 | `wms_ws_f`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-f`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-f
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_f：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4700/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-f-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-f): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-f.json`：`{"branch":"ws/ws-f/m1-qa-infra","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- `scripts/ci-local.sh` 在干净 worktree 上一次跑通；`e2e/` 骨架对 mock 跑通登录 + 一笔入库。
- `infra/native/install.sh --foreground` 在本机起 API 并通过健康检查（端口用 4700 段，不占 lead 端口）。
- 备份 → 恢复 → 对账脚本在 `wms_ws_f` 上演练通过。

## 备注
- 不要停/重建共享 PG 实例，不要改其他 WS 的库；不要安装系统级服务到真实 systemd（`--foreground` 模式验证）。
- 不连接任何外部服务、不注册任何付费服务；需要外部存储的步骤只交付脚本与说明。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
- **备份状态写入（来自 ws-a2-1 #6）**：备份脚本完成后写入 `ops_status`，键 `'backup'`，值 `{ lastLocalAt?: ISO, lastRemoteAt?: ISO, remoteConfigured?: boolean }`；看板会读取它。
- `pnpm db:reset:dev` 现在会写演示库存（`WMS_SEED_STOCK=0` 跳过）。移动端 e2e：`pnpm --filter @wms3d/mobile e2e`；twin3d e2e/基准见 `packages/twin3d/README`。纳入 `scripts/ci-local.sh` 的 e2e 阶段。
- 联合验收 #5 已有：`apps/api/src/test/joint-5.test.ts`。

## Lead 更新 · contract-v1.3（2026-11-13 PT）
已合并到 main（ee54948）。ws-f-1 已处理：根脚本 `pnpm verify:full`、`pnpm run ci`（`pnpm ci` 是 pnpm 内置命令，必须加 run）、`pnpm e2e`、`pnpm seed:demo`、`pnpm backup:drill` 可用；正式 CLI `pnpm --filter @wms3d/api admin:create`（写审计）已在 main；`scripts/create-admin.ts` shim 已删除，RUNBOOK 已改为调用正式 CLI。mock 已支持 multipart 导入，e2e 可以改回用 `/skus/import`。
