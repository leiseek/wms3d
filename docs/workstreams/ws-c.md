# WS-C · 移动端（Capacitor）与原生扫码

> 自包含简报（M0b，2026-11-12 PT，contract-v1 / 设计 v2.2）。读完本文件即可开工；细节以 `docs/` 设计文档为准。
> 里程碑：M3（6 天）→ M4.5（移动 3D Tab、离线队列 × 真实 API）→ M5 移动盲盘；真机验证在 M6 发布门禁

## 独占目录（`pnpm check:ownership` 校验）
- `apps/mobile/**`（含 `android/`：MainActivity pre-IME Hook、ScanKeyBuffer、ScannerInterceptLayout）
- `native/**`（`native/capacitor-scanner` 插件）
- `packages/scanner/**`、`packages/ui/**`

## 范围
按 04 全文与 10 §M3：
1. 第 1 天：**Robolectric** 测 pre-IME 拦截与 `wrapContentRoot` 失败路径（R3 #7：`isInstalled()/installError()` 已实现，补测试）；JVM 单测 SPP 帧切分；Playwright 截图测相机透明挖洞；debug 包“软键盘视为白名单设备”开关；`KeyEvent.ACTION_MULTIPLE` / `getCharacters()` 支持（R3 #8 遗留）。
2. 外壳：服务器配置确认 + SPKI 指纹校验、登录（`client:'mobile'`，保存 refreshToken 于 Keystore 加密存储、保存 `session.id`）、仓库切换、自适应、状态栏/insets、诊断页（扫码 Hook 状态、溢出计数）。
3. `packages/scanner`：ScanHub、来源去重表、JS HID 阈值；`native/capacitor-scanner`：HidWedgeBuffer + pre-IME、SPP 权限/重连/帧切分、feedback、verifyServerPin、showSoftInput、Keystore。
4. 相机（瞄准框、双帧确认、离框再触发、torch）。
5. 作业页：上架/出库/移库/查询；倒计时自动提交、撤销、打断式拒绝、意外码转移表；`scanResolve` 与本地主数据。
6. **SQLite outbox**（`@capacitor-community/sqlite`）：离线入队带 `performedBy` + **`performerSessionId`（入队时登录会话 `session.id`）**、`clientCreatedAt`、`createdOffline`、幂等键（`newIdempotencyKey()`）；发送器按 04 §5 处理 401/403/409/422、`WAITING_STOCK`、`BLOCKED_AUTH`；换班后用当前用户令牌继续补传（设备 ID 来自令牌，body 不带 deviceId）。
7. 主数据同步（`/sync/masterdata` 首次全量 + 增量 + digest），首次同步完成前禁止离线作业。

## 使用的契约
`@wms3d/api-client`（`apps/mobile/src/api.ts`），主要用 auth、users（heartbeat、appVersion）、scan、sync、inventory、twin、events、counts。开发期 `pnpm mock` + `pnpm dev:mobile`（Vite 代理 `/api`），或 MSW。换班规则以 02 §6.6 / 03 §5 为准（mock 已实现，可直接测 403 `PERFORMER_NOT_ALLOWED`）。

## 运行环境（本 WS 独占）
| 项 | 值 |
|---|---|
| worktree | `/workspace/wms3d-wt/ws-c`（分支 `ws/ws-c/m3-mobile`，基于 main @ `contract-v1`） |
| 端口 | API **4300** · admin **4310** · mobile **4320**（性能/预览等额外端口用 4330–4399） |
| 数据库 | `wms_ws_c`（127.0.0.1:55432；运行时 `wms_app`，迁移 `wms_owner`；测试库从本 WS 模板克隆） |
| 环境文件 | `.env.local`（`scripts/wt.sh` 生成，含 `WMS_WS=ws-c`，勿提交） |

```bash
cd /workspace/wms3d-wt/ws-c
source /opt/tools/env.sh                    # PG17 / JDK21 / Android SDK（机器重启后丢失则 bash scripts/install-tools.sh all）
scripts/dev-db.sh start                     # 共享 PG 实例（已在跑则无操作）
pnpm db:reset:dev                           # 只重建 wms_ws_c：迁移 + 演示数据（WH1 386 仓位、24 SKU、用户 admin/manager/op1/op2/viewer，密码 Wms3d#demo）
pnpm mock                                   # 契约驱动 mock API → http://127.0.0.1:4300/api/v1（与 dev:api 二选一占用 PORT_API）
pnpm dev:api | pnpm dev:admin | pnpm dev:mobile
pnpm verify                                 # lint + typecheck + test + build，合并前必须全绿
pnpm check:ownership                        # 改动只能落在下方“独占目录”
```
- 设计文档：`docs/00`–`10`（v2.2，契约 v1 已冻结）；本机开发说明 `docs/dev-setup.md`。契约：`packages/contracts/src/**`（Zod 为真相源，`routes.ts` 是端点清单 + roles/scope/owner），OpenAPI：`packages/contracts/openapi.json` 或运行中的 `/api/v1/docs`。
- 共享机器：同一文件系统、同一 PG 实例。**不要**碰其他 WS 的 worktree、数据库、端口；不要停 PG；不要改 `/opt/tools`；Gradle 只经 `pnpm apk:debug`（全局 flock）；性能基准前取 `flock /tmp/wms3d-perf.lock`。

## 合并规则（10 §6）
1. 只改本 WS 独占目录；**不得修改任何 `package.json`、`pnpm-lock.yaml`、根配置、`packages/contracts/**`、`packages/api-client/**`、`apps/api/src/db/**`、`docs/**`（`docs/contract-requests/` 除外）**。依赖已预装；缺依赖或需要改契约/schema/mock → 写 `docs/contract-requests/ws-c-<n>.md`（现状、需求、建议的 schema diff、是否阻塞），Lead 每天约 11:00、17:00 PT 批处理；等待期间在本包内放本地 shim，合并后删除。
2. 小步提交（Conventional Commits，如 `feat(ws-c): …`），提交前 `pnpm format`。
3. 申请合并：`git fetch` 不需要（本地仓库）；`git rebase main` → `pnpm verify` 全绿 → `pnpm check:ownership` 通过 → 写队列文件 `/workspace/.wms3d-queue/<UTC 时间戳如 20261113T0130Z>-ws-c.json`：`{"branch":"ws/ws-c/m3-mobile","commit":"<sha>","verify":"green","depsChanged":false,"notes":"…"}`。Lead 在主仓 `/workspace/wms3d` 用 `--no-ff` 合并并在 main 复跑 verify，处理后移入 `done/`。不要自己动 main，不要 push（无远程），不要用云 Agent。
4. 测试里用到 DB 时用 `apps/api/src/test/pg.ts` 的 `cloneTestDb()`（每文件一个克隆库，结束 `drop()`），不要直接写开发库。

## 验收测试
- web mock e2e（Playwright，`apps/mobile/e2e/`，手机/平板两种视口）：登录、连续上架（HID 模拟键入）、撤销、意外码拒绝、离线 10 单后恢复同步、令牌过期 `BLOCKED_AUTH` 后重新登录继续、换班代交成功与伪造被拒。
- Android：`pnpm apk:debug` 成功（同时跑 `testDebugUnitTest`：ScanKeyBuffer、HidWedgeBuffer、SPP 帧切分、Robolectric pre-IME）；APK 在 `/workspace/wms3d-artifacts/`。
- 低版本 WebView：`webview-too-old.html` 两种文案、`index.html` 内联 ES5 检测保留。

## 备注
- 本机无 KVM/模拟器/真机：真机清单（04 §7）列入 M6 发布门禁，不要声称已真机验证。
- Gradle 只经 `pnpm apk:debug`（`flock /tmp/wms3d-gradle.lock`），不要并行起 Gradle 守护进程。
- `capacitor.config.ts` 的 `minWebViewVersion / minHuaweiWebViewVersion / errorPath` 已设置；改动须写明理由。

## Lead 更新 · contract-v1.2（2026-11-12 PT）
已合并到 main：ws-c M3（9ec9d84）。请 `git rebase main`。
- ws-c-1：#1 插件改为 npm 包这件事排到 M4.5，由 Lead 统一做，**在此之前保留**本地 Gradle 模块；#2 `apps/mobile` 已有 `pnpm --filter @wms3d/mobile e2e`；#3 troika 声明转给 WS-D2。
- 契约 v1.2 对移动端的影响：改密错误现在是 400 `VALIDATION_FAILED`（不再是 401，别触发刷新）；OPERATOR 冲正违规是 403 `FORBIDDEN`；digest 可以复算（算法见 `SyncDigest.hash` 描述），离线主数据校验可以用。

## Lead 更新 · ws-d1 合并（2026-11-12 PT）
twin3d 已随包导出 troika 声明（ws-d1-1 / ws-c-1 #3）：请删除 `apps/mobile/tsconfig.json` 中对 `packages/twin3d/src/troika.d.ts` 的 include。
