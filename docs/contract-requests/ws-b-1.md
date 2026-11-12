# WS-B-1 · SKU 导入 multipart 字段名 + mock 导入预检

- 工作流：ws-b
- 阻塞：否（后台已按 `file` 字段上传，并在前端做了预检；可先合并）
- 现状：
  1. `importSkus`（`POST /skus/import`，`multipart/form-data`）在契约和 docs/03-api.md 中都没写文件字段名；WS-A1 的实现（`apps/api/src/modules/skus`）用的是 `req.file()`，报错文案写“字段 file”，与后台一致；只是契约未写明。
  2. mock 的 `importSkus` 不读上传内容，固定返回 `totalRows: 0, errors: []`。后台的“服务端预检”路径（`ImportResult.errors` 与前端错误合并、显示新增/更新数）因此只能用前端预检做 E2E。
- 需求：
  1. 在契约中写明字段名为 **`file`**（单文件，UTF-8 CSV，≤ 5 万行），例如在 `routes.ts` 的 `importSkus.summary` 或 03-api.md 中加一句；WS-A1 按此实现。
  2. （可选）mock 解析上传的 CSV：按 `code` 统计 created/updated；对已存在于其他 SKU 的条码返回 `BARCODE_CONFLICT`；`dryRun=false` 时真的 upsert 到 store。这样 E2E 能覆盖服务端错误行。
- 建议的 schema diff：无（只是文档/注释与 mock 行为）。

# WS-B-2 · 台账/交易单/审计显示操作人姓名（可选）

- 阻塞：否（目前显示 userId 前 8 位）
- 现状：`Movement.performedBy`、`Txn.performedBy/submittedBy`、`AuditLog.userId` 只有 id；`listUsers` 仅 ADMIN 可调，MANAGER 无法把 id 换成姓名。
- 建议（向后兼容的新增可选字段）：

```ts
// inventory.ts
Movement: performedByName: z.string().nullable().optional()
Txn:      performedByName / submittedByName: z.string().nullable().optional()
// misc.ts
AuditLog: userName: z.string().nullable().optional()
```

- 合并后 WS-B 改为优先显示姓名。

# WS-B-3 · 库存余额 CSV 导出（可选）

- 阻塞：否（后台目前按 keyset 分页拉全量余额，在浏览器内生成 CSV，上限约 10 万行）
- 建议：新增 `GET /inventory/balances.csv`（query 同 `BalancesQuery` 去掉 limit/cursor，roles = MGR，produces `text/csv`），与 `movements.csv` 对称，便于大仓导出。
