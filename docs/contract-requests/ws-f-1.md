# 契约/根配置请求 ws-f-1（ws-f · 2026-11-12 PT）

**是否阻塞**：否（均已有本地替代，见“当前替代”）。

## 1. 根 `package.json` 增加脚本（ws-f 无权改 package.json）
```diff
   "scripts": {
+    "verify:full": "bash scripts/ci-local.sh --full",
+    "ci": "bash scripts/ci-local.sh",
+    "e2e": "bash scripts/e2e.sh",
+    "seed:demo": "bash scripts/seed-demo.sh",
+    "backup:drill": "bash scripts/backup-drill.sh",
```
- 现状：`pnpm verify` 只含 lint/typecheck/test/build；09 §6 的 e2e smoke、ownership、脚本测试不在内。
- 当前替代：直接运行 `bash scripts/ci-local.sh [--full]`（结果写 `/workspace/wms3d-artifacts/ci/`）。
- 可选：`pnpm typecheck` 目前不覆盖 `e2e/`、`scripts/*.ts`（非 workspace 包）；ci-local.sh 已额外跑 `tsc -p e2e` 与 `tsc -p scripts`。若希望 `pnpm verify` 也覆盖，可在根 `typecheck` 末尾追加 `&& tsc -p e2e/tsconfig.json && tsc -p scripts/tsconfig.json`。

## 2. 生产首个管理员 CLI（apps/api，归 ws-a1 / Lead）
- 现状：生产库不应写演示数据，但没有创建首个 ADMIN 的正式途径。
- 需求：`apps/api/src/db/create-admin.ts`（或 users 模块的 CLI）：建 ADMIN、`all_warehouses=true`、`must_change_password=true`，写审计；临时密码从环境变量读。
- 当前替代：`scripts/create-admin.ts`（ws-f shim，列与 argon2id 参数同 seed-demo.ts；不写审计）。正式版合并后删除 shim。

## 3. mock 的 multipart（packages/api-client，归 Lead）——仅告知
- `startMockServer` 丢弃 multipart 文件体，`POST /skus/import` 在 mock 上无法按内容返回结果。e2e 在 mock 上改用 `POST /skus`；若 WS-B 的导入页需要 mock 联调，建议 mock 解析 CSV 的 `code,name,barcode` 列。

## 4. 备份状态键（已对齐，无需改动）——仅确认
- `scripts/backup.sh` 写 `ops_status['backup'] = {lastLocalAt, lastRemoteAt, remoteConfigured, lastFile, lastRemoteOk}`；与 ws-a2 看板读取的字段一致（多出的两个字段被忽略）。

---
**Lead 决定（2026-11-13 PT，contract-v1.3）**
1. **接受，已做**：根 `package.json` 新增 `verify:full`、`ci`、`e2e`、`seed:demo`、`backup:drill`（指向你的脚本）。可选项“把 `tsc -p e2e` / `tsc -p scripts` 并入 `pnpm typecheck`”：**暂不并入**，保持 `pnpm verify` 快；由 `pnpm run ci` / `pnpm verify:full` 覆盖，合并前 WS 跑 `pnpm run ci`（注意：`pnpm ci` 是 pnpm 内置命令，必须写 `run`）。
2. **接受，已做**：正式 CLI `apps/api/src/db/create-admin.ts`，命令 `pnpm --filter @wms3d/api admin:create -- --username <name> [--display-name …]`，临时密码从 `WMS_ADMIN_TEMP_PASSWORD` 读取（≥ 12 字符），建 ADMIN（all_warehouses、must_change_password），与 `audit_logs`（`user.create`）同一事务写入，复用 auth 模块的 argon2id 参数；已存在同名用户时退出码 1，不修改；有测试。**WS-F**：删除 `scripts/create-admin.ts` shim，`install.sh` / RUNBOOK 改为调用正式 CLI。
3. mock multipart：**已做**（随 WS-B-1）。e2e 可以改回用 `POST /skus/import`。
4. 备份状态键：确认一致，无改动。
