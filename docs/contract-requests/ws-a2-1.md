# ws-a2-1：M1 库存/盘点/孪生/同步/SSE 合并时的契约与外壳请求

- 提交方：WS-A2（branch `ws/ws-a2/m1-inventory`）
- 是否阻塞：**否**（均已用本包内 shim 绕过；合并后由 Lead 决定是否采纳并删除 shim）

## 1. 无数据库时不注册路由（shim）
**现状**：`apps/api/src/app.test.ts`（A1/Lead）断言 `stubRoutes.length + 2 === routeList.length`，且无 DB 时 `GET /inventory/balances` 返回 501。
ws-a2 的 7 个模块（inventory/counts/sync/twin/events/audit/dashboard）因此在 `services.db == null` 时直接 `return`，保持 501 桩。
**需求**：调整 app.test 的断言为“无 DB 时 ws-a2 路由为 501”，或允许模块在无 DB 时注册返回 503 的处理器。采纳后删除各模块 `if (!db) return;`。

## 2. `AuthContext.exp`（SSE 关流）
**现状**：`lib/auth.ts` 的 `AuthContext` 无过期时间。`events` 模块先读 `req.auth.exp`（若将来存在），否则解析已验签的 Bearer JWT 载荷中的 `exp`；均无时按 15 分钟上限关流。
**建议 diff**（`apps/api/src/lib/auth.ts`）：
```ts
export interface AuthContext {
  ...
  /** JWT exp（秒），SSE 在此时刻关流 */
  exp?: number;
}
```
A1 的 verifier 填充后，`tokenExpSeconds()` 自动改用它，可删 JWT 载荷解析分支。

## 3. 演示库存根脚本入口
`apps/api/src/modules/inventory/seed-stock.ts`：经 `postTransaction` 以 INBOUND 写入 `demo.demoBalances`（幂等键 `seed:<loc>:<sku>`），随后全量对账。
**建议**：`scripts/db-reset-dev.sh` 末尾追加
`(cd "$ROOT/apps/api" && node --experimental-strip-types src/modules/inventory/seed-stock.ts "$DATABASE_URL")`，
并在 `apps/api/package.json` 增加 `"db:seed:stock"`（根 `pnpm seed:demo --with-stock` 同理）。

## 4. mock 行为对齐（`packages/api-client/src/mock/handlers.ts`）
- OPERATOR 冲正违规（非本人 / 非本设备 / 超过 600s / COUNT_ADJUST）：真实实现返回 **403 `FORBIDDEN`**（属角色策略 `reverse`），mock 返回 `REVERSAL_NOT_ALLOWED`。建议 mock 改为 FORBIDDEN；`REVERSAL_NOT_ALLOWED`（422）只用于“冲正一笔 REVERSAL”。
- `closeCount`：存在 `needs_review` 行时真实实现返回 422 `COUNT_RECOUNT_REQUIRED`（context `{ locationIds, lines }`），与 mock 一致；余额不足时同样 422 且将对应行标记 needs_review、整体回滚——请 mock 补齐后一种。
- `syncMasterdata`：mock 游标是偏移量；真实游标为不透明 base64url（keyset），客户端只应原样回传，无需改契约。

## 5. 主数据摘要算法（`GET /sync/masterdata/digest`）——请写入契约描述
`hash = sha256(lines.join('\n'))`；`lines` 为 `${entity}|${id}|${updatedAt}`，`entity ∈ {barcode, location, sku}`，
`updatedAt` 与 `SyncPage` 中返回的值完全相同（UTC 毫秒 ISO，`toISOString()`），按 `(entity, id)` 字节序升序；locations 仅本仓。
客户端可用本地副本逐位复算。建议写入 `scan-sync.ts` 的 `SyncDigest.hash.describe()`，并让 mock 采用同一算法（目前为 `mock-<n>-<n>-<n>`）。

## 6. 看板备份状态来源
`dashboard.backup` 读取 `ops_status` 键 `'backup'` 的 `value`：`{ lastLocalAt?: ISO, lastRemoteAt?: ISO, remoteConfigured?: boolean }`。请备份脚本（ops/infra 归属方）按此写入；如需其他键名请告知。

## 7. 夜间任务启动
`apps/api/src/jobs/index.ts` 的 `installJobs(app, pool)` 由 inventory 模块注册，在 `onListen` 时启动 node-cron（`WMS_JOBS=0` 关闭，`WMS_JOBS_TZ` 覆盖时区，缺省取首个仓库 timezone）。若 Lead 希望改由 `main.ts` 显式启动，可移动调用点。
