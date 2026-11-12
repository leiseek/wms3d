# 03 · API 设计

## 1. 约定
- 基础路径 `/api/v1`，JSON，UTF-8，时间 ISO-8601 UTC（客户端按 `America/Los_Angeles` 或仓库时区显示，仓库表加 `timezone` 字段）。
- 契约来源：`packages/contracts`（Zod）→ `pnpm gen:openapi` 输出 `apps/api/openapi.json`，Swagger UI 在 `/api/docs`（仅非生产或 ADMIN）。
- 分页：游标分页 `?limit=50&cursor=...` → `{items, nextCursor}`；列表默认按 `created_at desc, id`。
- 并发控制：可编辑资源带 `version` 字段，`PATCH` 需 `If-Match: <version>`，不符 → `412 PRECONDITION_FAILED`。
- 仓库作用域：多数接口需 `warehouseId`（路径或 query），服务端校验用户是否被授权该仓库。

## 2. 鉴权
| 项 | 设计 |
|---|---|
| 登录 | `POST /auth/login {username,password,deviceId?}` → `{accessToken, user}`，Web 刷新令牌放 `HttpOnly; Secure; SameSite=Strict` cookie；移动端在响应体返回 `refreshToken`，存 Android Keystore 加密存储 |
| 访问令牌 | JWT（EdDSA/HS256 二选一，默认 HS256 + 32 字节密钥），15 分钟，含 `sub, role, wh[]` |
| 刷新 | `POST /auth/refresh`，**轮换**：每次换新 refresh token，旧令牌重用 → 撤销整个 family（防盗用） |
| 登出 | `POST /auth/logout` 撤销当前 family |
| 密码 | argon2id；登录限流 5 次/分钟/账号+IP |
| RBAC | 路由级 `requireRole([...])` + 仓库授权检查；权限矩阵见 08 文档 |

## 3. 错误模型（RFC 9457 problem+json）
```json
{ "type": "https://wms3d.dev/errors/INSUFFICIENT_STOCK", "title": "库存不足",
  "status": 422, "code": "INSUFFICIENT_STOCK", "detail": "A03-12-C02 上 SKU-001 仅有 3",
  "traceId": "01J...", "errors": [{"path":"lines[0].qty","message":"..."}],
  "context": {"locationCode":"A03-12-C02","skuCode":"SKU-001","available":3} }
```
错误码枚举在 contracts 中（中文提示文案在客户端 i18n 表）：`VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, PRECONDITION_FAILED, IDEMPOTENCY_KEY_REUSED, INSUFFICIENT_STOCK, LOCATION_INACTIVE, LOCATION_CAPACITY_EXCEEDED, MIXED_SKU_NOT_ALLOWED, BARCODE_CONFLICT, UNKNOWN_BARCODE, LAYOUT_INVALID, LAYOUT_HAS_STOCK, RATE_LIMITED, INTERNAL`。
客户端规则：4xx 业务错误 → 不重试，进入"异常单"；网络错误/5xx/429 → 指数退避重试（同幂等键）。

## 4. 幂等（扫码交易）
- 所有库存写接口要求请求头 `Idempotency-Key`（客户端 UUIDv7，在**用户确认时**生成并随离线队列持久化）。
- 服务端存 `inv_txns.idempotency_key` 唯一 + `request_hash = sha256(规范化 body)`：
  - 首次：`201 Created`，`{txn, balances, replayed:false}`
  - 重放相同：`200 OK`，返回首次结果，`replayed:true`
  - 重放不同 body：`409 IDEMPOTENCY_KEY_REUSED`
- 键保留期：永久（与交易同存）；同一键并发两请求由唯一索引裁决，失败方读取已提交结果返回 200。

## 5. 端点清单（MVP）
### 认证/用户
| 方法 | 路径 | 角色 |
|---|---|---|
| POST | /auth/login · /auth/refresh · /auth/logout | 公开/登录 |
| GET | /me | 登录 |
| GET/POST/PATCH | /users, /users/:id（含重置密码、仓库授权） | ADMIN |

### 仓库结构与布局
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PATCH | /warehouses, /warehouses/:id | ADMIN 写 |
| GET/POST/PATCH/DELETE | /warehouses/:id/zones | |
| GET/POST/PATCH | /rack-types | 模板 |
| GET | /warehouses/:id/layout?version=draft\|published | 布局文档 |
| PUT | /warehouses/:id/layout/draft (If-Match) | 保存草稿 |
| POST | /warehouses/:id/layout/validate | 返回问题列表与差异预览 |
| POST | /warehouses/:id/layout/publish | 发布（校验+生成仓位） |
| GET | /warehouses/:id/locations?zone=&rack=&q=&kind= | 仓位列表 |
| PATCH | /locations/:id | 启停、容量、pick_seq |
| GET | /warehouses/:id/twin | **3D 场景数据**（布局 + 仓位紧凑数组，ETag 缓存） |
| GET | /warehouses/:id/twin/occupancy | 仓位占用数组（按 twin 索引顺序，ETag/增量 `?since=`） |

### SKU 主数据
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PATCH | /skus, /skus/:id | 搜索 `q` 匹配 code/name/条码 |
| POST/DELETE | /skus/:id/barcodes | 条码唯一 & 不与仓位码冲突 |
| POST | /skus/import (multipart CSV) → `{dryRun}` 先预检再提交 | |
| GET | /skus/export.csv | |

### 扫码解析与离线同步
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /scan/resolve?warehouseId=&code= | 返回 `{kind: LOCATION\|RACK\|SKU\|UNKNOWN, entity, packQty}` |
| GET | /sync/masterdata?warehouseId=&since= | 移动端缓存：SKU+条码、仓位码（增量，`updated_at` 游标，含删除墓碑） |

### 库存
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /inventory/transactions (Idempotency-Key) | 统一交易命令，见下 |
| GET | /inventory/transactions, /:id | 交易与行 |
| GET | /inventory/balances?warehouseId=&skuId=&locationId=&zone= | 余额查询 |
| GET | /inventory/movements?... | 流水台账（可导出 CSV） |
| GET | /inventory/locate?warehouseId=&q= | SKU 定位：`[{locationId, code, qty, twinIndex}]` |
| GET | /inventory/low-stock?warehouseId= | 低库存 |

交易命令（判别联合，Zod `discriminatedUnion('type')`）：
```jsonc
// INBOUND / OUTBOUND
{"type":"INBOUND","warehouseId":"…","refNo":"PO-1001","deviceId":"tab-07","clientCreatedAt":"…",
 "lines":[{"locationId":"…","skuId":"…","qty":12,"lotNo":""}]}
// TRANSFER
{"type":"TRANSFER","warehouseId":"…","lines":[{"fromLocationId":"…","toLocationId":"…","skuId":"…","qty":5}]}
// ADJUST（MANAGER+，需 reason）
{"type":"ADJUST","warehouseId":"…","reason":"DAMAGE","lines":[{"locationId":"…","skuId":"…","qtyDelta":-2}]}
```
允许客户端以 `locationCode/skuBarcode` 代替 id（服务端解析，便于离线时只存扫码原文）；解析失败 → `422 UNKNOWN_BARCODE`。

### 盘点
| 方法 | 路径 |
|---|---|
| POST/GET | /counts（创建：scope、blind） |
| GET | /counts/:id/lines?location= |
| POST | /counts/:id/submissions (Idempotency-Key) `{locationId, items:[{skuId,qty}]}` 按仓位整体提交 |
| POST | /counts/:id/review → 差异表；/counts/:id/close → 生成 COUNT_ADJUST 交易 |

### 标签、看板、审计、事件
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /labels/render `{template, kind: LOCATION\|RACK\|SKU, ids[] 或 filter, format: PDF\|ZPL}` | 返回 `application/pdf` 或 `text/plain` |
| GET | /labels/templates | 内置模板列表 |
| GET | /dashboard?warehouseId= | 今日出入库、利用率、低库存数 |
| GET | /audit-logs | ADMIN |
| GET | /events?warehouseId= | SSE：`stock.changed {locationIds[], skuIds[], txnId}`、`layout.published` |
| GET | /health, /ready | 运维 |

## 6. 3D 场景数据格式（紧凑）
```jsonc
{ "warehouseId":"…","layoutVersion":7,"etag":"…",
  "layout": { /* 02 文档中的布局文档 */ },
  "locations": { // 列式数组，下标 = twinIndex
    "id": ["…"], "code": ["A03-01-A01", …], "rackKey": ["r1", …],
    "bay":[1,…],"level":[1,…],"pos":[1,…] } }
// occupancy：与 twinIndex 对齐
{ "layoutVersion":7, "asOf":"…", "qty":[0,12,…], "skuCount":[0,1,…], "fill":[0,0.4,…] }
```
