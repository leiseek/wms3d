# 03 · API 设计

> v2（2026-11-12）：补齐幂等写法、仓库作用域统一判定、SSE 鉴权、CORS、离线 401/403 语义、twin 版本绑定、缺失端点。
> **v2.1**（2026-11-12，R2）：occupancy ETag 改为内容哈希并承载 isActive/effectiveMax（N2）、服务端缓存与客户端节流（M-N3）、刷新兄弟 token（B-N13）、换班代交（B-N6）、处理矩阵修正（B-N5/B-N14）、事务超时与同步安全窗口（B-N7）、CORS 来源（B-N18）、自研 SSE 客户端（B-N19/M-N18）。

## 1. 约定
- 基础路径 `/api/v1`，JSON/UTF-8，时间 ISO-8601 UTC；界面按仓库 `timezone` 显示。
- 契约来源：`packages/contracts`（Zod 4）→ `pnpm gen:openapi` 生成 `apps/api/openapi.json`；MSW mock 与示例数据**由 contracts 自动生成**，CI 校验与 OpenAPI 一致（D46）。
- 分页：普通列表 `?limit&cursor`（keyset）；**台账类（movements、transactions、audit）按 `id desc` keyset**（D33）。
- 乐观锁：可编辑资源用 `rowVersion`，`PUT/PATCH` 带 `If-Match: <rowVersion>`，不符 → 412。
- problem `type` 用 `urn:wms3d:error:<CODE>`（D32）。

### 1.1 CORS（M3a）
- PC 后台同域（Caddy 反代），无需 CORS。
- 移动端 WebView origin 为 `https://localhost`（Capacitor 8 Android 默认 `androidScheme: 'https'`），与 API 跨域：**生产 allowlist 只有 `https://localhost`**（v2.1，B-N18：不支持 iOS，去掉 `capacitor://`；`http://localhost` 会放行任意本机页面，去掉）。
- dev：allowlist 由 `.env.local` 端口生成——`http://localhost:${PORT_ADMIN}`、`http://localhost:${PORT_MOBILE}`（4010+100n / 4020+100n，见 `dev-setup.md`），外加 `https://localhost`（真机 debug 包）。
- 预检放行头：`Authorization, Content-Type, Idempotency-Key, If-Match, X-Device-Id, X-Trace-Id`；暴露头：`ETag, X-Trace-Id`。`credentials` 不使用（移动端用 Bearer）。
- 移动端所有请求（含 SSE）走 WebView `fetch`（不使用 CapacitorHttp，因其不支持流式 SSE；统一一条网络路径便于排障）。

### 1.2 仓库作用域统一判定（D27/D9）
每个路由在 contracts 中声明元数据：
```ts
route({ method:'POST', path:'/inventory/transactions', roles:['ADMIN','MANAGER','OPERATOR'],
        scope: { from:'body', field:'warehouseId' } })        // from: 'path' | 'query' | 'body' | 'resource' | 'none'
route({ method:'PATCH', path:'/locations/:id', roles:['ADMIN','MANAGER'],
        scope: { from:'resource', resolver:'location' } })     // 先查资源所属仓库再判定
```
Fastify `preHandler` 统一解析并校验 `user_warehouses`（或 `all_warehouses`）；**失败一律 404**（不暴露存在性）。服务层再次在 SQL 中带 `warehouse_id = $wh` 约束（例如交易命令锁仓位时，D9），形成双保险。集成测试由路由元数据**自动生成**越权矩阵（D41）。

## 2. 鉴权
| 项 | 设计 |
|---|---|
| 登录 | `POST /auth/login {username,password,deviceId}` → `{accessToken, refreshToken?, user}`；Web：refresh 放 `HttpOnly; Secure; SameSite=Strict` cookie（路径 `/api/v1/auth`）；移动端：响应体返回 refreshToken，存插件 AES-GCM + Android Keystore（M0b 选定，D36） |
| 访问令牌 | JWT HS256（`kid` 支持轮换），15 分钟，claims：`sub, role, wh[] | all, did`（设备） |
| 刷新 | `POST /auth/refresh` 轮换；**宽限窗口 60s**（v2.1，B-N13/M-N17：服务端只存哈希，无法"返回同一个新 token"）：旧 token 在被替换后 60s 内、同 `device_id` 再次使用 → **签发一个兄弟 token**（同 family，`sibling_of` = 首个替换 token），两者都有效，后续各自独立轮换；超出窗口或不同设备 → 撤销整个 family（M7）。测试：并发双刷新都成功、跨设备重用撤销 family |
| 客户端 | refresh **single-flight**（全局互斥，所有 401 等待同一次刷新） |
| 登出 | `POST /auth/logout` 撤销 family |
| 改密 | `POST /me/password`；`must_change_password` 时除此端点外全部返回 403 `PASSWORD_CHANGE_REQUIRED` |
| 设备 | 库存写接口校验 `devices.disabled_at`（60s 缓存），禁用 → 403 `DEVICE_DISABLED`（D36） |
| 限流 | 登录 5 次/分钟/账号+IP；失败 10 次锁 15 分钟；登录失败审计按 IP+账号聚合（1 分钟 1 条） |

## 3. 错误模型（RFC 9457）
```json
{ "type": "urn:wms3d:error:INSUFFICIENT_STOCK", "title": "库存不足", "status": 422,
  "code": "INSUFFICIENT_STOCK", "detail": "A03-17-C02 上 SKU-001 仅有 3",
  "traceId": "01J...", "errors": [{"path":"lines[0].qty","message":"..."}],
  "context": {"locationCode":"A03-17-C02","skuCode":"SKU-001","available":3} }
```
错误码（contracts 枚举；v2.1 新增 `COUNT_RECOUNT_REQUIRED`、`PERFORMER_NOT_ALLOWED`）：`VALIDATION_FAILED, UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, CONFLICT, PRECONDITION_FAILED, PASSWORD_CHANGE_REQUIRED, DEVICE_DISABLED, IDEMPOTENCY_KEY_REUSED, INSUFFICIENT_STOCK, LOCATION_INACTIVE, LOCATION_CAPACITY_EXCEEDED, MIXED_SKU_NOT_ALLOWED, BARCODE_CONFLICT, UNKNOWN_BARCODE, WRONG_WAREHOUSE, LAYOUT_INVALID, LAYOUT_HAS_STOCK, LAYOUT_RECODE_NEEDS_CONFIRM, LAYOUT_STALE, TXN_ALREADY_REVERSED, REVERSAL_NOT_ALLOWED, COUNT_OUTBOX_PENDING, COUNT_RECOUNT_REQUIRED, PERFORMER_NOT_ALLOWED, RATE_LIMITED, INTERNAL`。

### 1.3 事务超时（v2.1，B-N7）
- `wms_app` 角色级 `transaction_timeout = 30s`（PG17）+ `idle_in_transaction_session_timeout = 30s`；布局发布事务 `SET LOCAL transaction_timeout = '120s'`。
- CSV 导入：先全量预校验（dry-run 同一代码路径），commit 时**每 1000 行一个事务**，返回已提交批次；失败可从断点重跑（按 code upsert 天然幂等）。

### 3.1 客户端（离线队列）处理矩阵（D6/D29/M28）
| 响应 | outbox 状态 | 行为 |
|---|---|---|
| 2xx（含 200 replayed） | DONE | 显示绿勾 |
| 网络错误 / 5xx / 429 | PENDING | 指数退避（1s→60s），同键重发 |
| 401 | 暂停发送器 | single-flight 刷新后重发；刷新失败且设备上**没有任何有效登录** → `BLOCKED_AUTH`（任意用户登录后继续，见 02 §6.6 换班代交），不进异常单 |
| 403 `PASSWORD_CHANGE_REQUIRED` | 暂停（BLOCKED_AUTH） | v2.1 B-N14：提示当前用户改密，改密后自动继续；不进异常单 |
| 403 `DEVICE_DISABLED` / 授权撤销 | REJECTED | 异常单，带原因 |
| 422 `INSUFFICIENT_STOCK`，且 `createdOffline=true` | WAITING_STOCK | 同键每 2 分钟重试，最长 24h，超时转 REJECTED（失败的键不留痕，可安全重放） |
| 422 `INSUFFICIENT_STOCK`，在线创建 | REJECTED（打断） | v2.1 B-N5：立即打断提示，提供"稍后自动重试"按钮（点了才转 WAITING_STOCK） |
| 其他 4xx 业务错误 | REJECTED | 打断式提示 + 异常单；**不阻塞队列**，后续单继续发送，同仓位+SKU 的后续单标"可能受影响" |
| 409 `IDEMPOTENCY_KEY_REUSED` | REJECTED | 视为客户端 bug，自动上报 traceId |

## 4. 幂等
### 4.1 库存交易
- 请求头 `Idempotency-Key`：客户端 UUIDv7（`uuid@14` 的 `v7()`，底层 `crypto.getRandomValues`，D3），在用户确认时生成并随 outbox 持久化。
- 唯一范围 `(warehouse_id, idempotency_key)`；写法见 02 §6.2（`INSERT ... ON CONFLICT DO NOTHING RETURNING` + 新语句 SELECT 比对）。
- `request_hash`（D4）：对**解析前的原始请求体**（去掉 `clientCreatedAt`、`deviceId` 等传输层字段）按 **RFC 8785 JCS** 规范化后 sha256；因此 `locationCode` 原文在主数据变更前后 hash 不变。contracts 内置 golden vectors 测试。
- 结果：首次 201；重放（hash 相同且 `performed_by`、`device_id` 一致）200 `replayed:true`，`balancesAfter` 由 movements 重建；否则 409（不返回首次内容）。
- 首次请求以 4xx 回滚 → 键不留痕，同键重放会重新执行。

### 4.2 非库存写入（D5）
| 端点 | 机制 |
|---|---|
| `POST /counts/:id/submissions` | 天然幂等：按 (task, location) 整体覆盖 upsert |
| `POST /counts/:id/close` | 状态 CAS + 内部幂等键 `count-close:{taskId}`，与调整单同一事务（02 §8，B-N4） |
| `POST /warehouses/:id/layout/publish` | 状态 CAS（DRAFT→PUBLISHED，带 rowVersion） |
| `POST /skus/import`（commit）、`POST /labels/render` 以外的其他 POST | 可选 `Idempotency-Key` → `idempotency_keys(scope, key)` 存 response |

## 5. 端点清单（MVP，v2 补齐 D30）
### 认证/用户/设备
| 方法 | 路径 | 角色 |
|---|---|---|
| POST | /auth/login · /auth/refresh · /auth/logout | 公开/登录 |
| GET · POST | /me · /me/password | 登录 |
| GET/POST/PATCH | /users, /users/:id（重置密码、仓库授权、all_warehouses） | ADMIN |
| GET · PATCH | /devices · /devices/:id（禁用/启用） | ADMIN |
| POST | /devices/heartbeat `{deviceId, appVersion, pendingOutbox}` | 登录 |
| GET | /app/version | 公开 |

### 仓库与布局（结构写入只通过布局草稿，D19）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PATCH | /warehouses, /warehouses/:id | ADMIN；含 timezone、allow_mixed_sku、barcode_prefix_enabled、编码模式 |
| GET | /warehouses/:id/zones · /racks | 只读投影 |
| GET/POST/PATCH | /rack-types | 模板库 |
| GET | /warehouses/:id/layout/versions | 历史列表 |
| GET | /warehouses/:id/layout?version=draft\|published\|<n> | 布局文档 |
| POST | /warehouses/:id/layout/draft `{basedOnVersion}` | 基于某版本创建草稿（每仓库仅一个） |
| PUT | /warehouses/:id/layout/draft (If-Match rowVersion) | 保存草稿 |
| DELETE | /warehouses/:id/layout/draft | 丢弃草稿 |
| POST | /warehouses/:id/layout/validate | 问题列表 + 差异预览（新增/保留/改码/停用） |
| POST | /warehouses/:id/layout/publish `{rowVersion, confirmRecode}` | 发布；返回待补打标签清单 |
| GET | /warehouses/:id/locations?zone=&rack=&q=&kind= | 仓位列表 |
| PATCH | /locations/:id | 启停、容量、pick_seq（运行时属性） |
| PATCH | /warehouses/:id/locations/bulk `{ids[], patch}` | 批量（pick_seq 重排、启停） |
| GET | /warehouses/:id/twin | 3D 场景数据（ETag = layoutVersion；只含几何与编码，不随运行时属性变化） |
| GET | /warehouses/:id/twin/occupancy?layoutVersion= | 全量占用 + 运行时属性数组（ETag = 内容哈希/304；版本不符 409 `LAYOUT_STALE`，D16/D17/N2） |

### SKU 主数据（组织级：ADMIN 或 all_warehouses 的 MANAGER 可写，D25）
| 方法 | 路径 |
|---|---|
| GET/POST/PATCH | /skus, /skus/:id（`q` 匹配 code/name/条码） |
| POST/DELETE | /skus/:id/barcodes（登记表冲突 → `BARCODE_CONFLICT`） |
| POST | /skus/import?dryRun=true\|false（multipart CSV） |
| GET | /skus/export.csv |

### 扫码与同步
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /scan/resolve?warehouseId=&code= | `{kind: LOCATION\|RACK\|SKU\|UNKNOWN\|WRONG_WAREHOUSE, entity, packQty}` |
| GET | /sync/masterdata?warehouseId=&cursor=&limit=2000 | 分页增量（D24/M28）：游标 = 客户端已见最大 `updated_at` − **180s** 安全窗口（v2.1 B-N7：须大于最长事务 120s），按 id 幂等 upsert；含 tombstones；首次全量分页带 `total` 供进度条 |
| GET | /sync/masterdata/digest?warehouseId= | 计数+哈希，客户端每日比对，不一致则全量重拉 |

### 库存
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /inventory/transactions (Idempotency-Key) | INBOUND/OUTBOUND/TRANSFER/ADJUST |
| POST | /inventory/transactions/:id/reverse (Idempotency-Key) | 冲正（02 §6.4） |
| GET | /inventory/transactions, /:id | |
| GET | /inventory/balances?warehouseId=&skuId=&locationId=&zone= | |
| GET | /inventory/movements?...  · /inventory/movements.csv | 台账与导出 |
| GET | /inventory/locate?warehouseId=&q= | `{layoutVersion, items:[{locationId, code, skuId, qty}]}`——**只返回 locationId**，客户端用 TwinModel 的 `id→index` 映射（D16/M17） |
| GET | /inventory/low-stock?warehouseId= | |

交易命令（Zod `discriminatedUnion('type')`，客户端可提交类型仅以下四种）：
```jsonc
{"type":"INBOUND","warehouseId":"…","refNo":"PO-1001","performedBy":"<userId>","clientCreatedAt":"…",
 "lines":[{"locationId":"…"|null,"locationCode":"A03-17-C02"|null,"skuId":null,"skuBarcode":"6901234567890","qty":12}]}
{"type":"OUTBOUND", ...同上}
{"type":"TRANSFER","warehouseId":"…","lines":[{"fromLocationId":"…","toLocationId":"…","skuId":"…","qty":5}]}
{"type":"ADJUST","warehouseId":"…","reason":"DAMAGE","refNo":"EXC-…","lines":[{"locationId":"…","skuId":"…","qtyDelta":-2}]}
```
`performedBy` 与令牌用户（`submitted_by`）不同时（v2.1，B-N6 换班代交）：仅当令牌 `did` = 单据 `deviceId`、`clientCreatedAt` 落在 performedBy 在该设备的 `device_sessions` 区间内（±5 分钟）、且 performedBy 账号启用时接受；否则 403 `PERFORMER_NOT_ALLOWED`。`locationCode` 接受载荷形式（`WH1.A03-17-C02`）与裸编码（M-N12）。

### 盘点
| 方法 | 路径 |
|---|---|
| POST/GET | /counts（创建带 warehouseId）、/counts?warehouseId= |
| GET | /counts/:id · /counts/:id/lines?location= |
| POST | /counts/:id/start · /counts/:id/submissions · /counts/:id/review · /counts/:id/close `{confirmPendingOutbox}` · /counts/:id/cancel |

### 标签、看板、审计、事件、运维
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /labels/render `{template, kind, ids[]|filter, format: PDF|ZPL, startCell?, offsetMm?}` | PDF / ZPL（实验性） |
| GET | /labels/templates · /labels/calibration.pdf?template= | 模板与校准页 |
| GET/POST | /label-reprint-requests | 移动端提交补打请求 → PC 打印队列（M33） |
| GET | /dashboard?warehouseId= | |
| GET | /audit-logs?warehouseId= | ADMIN；MANAGER 仅授权仓库（D34） |
| GET | /events?warehouseId= | SSE，见 §6 |
| GET | /health · /ready | |

## 6. SSE（D28/M3c）
- 客户端（v2.1，B-N19/M-N18）：**自研 `packages/api-client/src/sse.ts`**——`fetch` + `ReadableStream` + `eventsource-parser@4.1.3`（`@microsoft/fetch-event-source` 自 2021 年未更新、401 无法接入 single-flight 刷新，放弃）。行为：401 → single-flight 刷新后重连；其他错误退避 1s→30s（加抖动）；页面隐藏时断开、可见时重连；连接顺序"**先建立流、再全量拉取** occupancy"（避免两者之间的事件丢失）。可带 `Authorization: Bearer`，**不把 token 放 query**（避免进 Caddy/pino 日志）。
- 连接时校验仓库授权；服务端在 JWT `exp` 到达时主动关闭流；客户端遇 401 → single-flight 刷新后重连。
- 事件：`stock.changed {layoutVersion, locationIds[], txnId}`、`locations.changed {layoutVersion, locationIds[]}`（v2.1：启停、容量变更）、`layout.published {layoutVersion}`、`ping`（25s，穿透代理）。
- 不支持 Last-Event-ID 续传（MVP）：**每次（重新）连接后客户端先全量拉取 occupancy**；另外每 60s 带 ETag 轮询 occupancy 兜底进程崩溃丢事件（D50）。
- 拉取节流（v2.1，M-N3）：客户端两次 occupancy 拉取最小间隔 **移动端 2s / PC 1s**，只在页面可见时拉；服务端按仓库在内存缓存 occupancy 结果（含 ETag），事件到来时标脏，**最多每秒重算一次**，所有客户端共享。容量指标见 01 §7。
- 单实例进程内事件总线；多副本时改为 PG `LISTEN/NOTIFY`（不在 MVP）。
- Caddy 对 `/api/v1/events` 关闭缓冲。

## 7. 3D 场景数据格式
```jsonc
// GET /twin
{ "warehouseId":"…","layoutVersion":7,
  "layout": { /* 02 §9 布局文档 */ },
  "locations": { "id":["…"], "code":["A03-01-A01",…], "rackKey":["r1",…],
                 "rackBayIndex":[0,…], "level":[1,…], "pos":[1,…] } }  // 下标 = twinIndex，仅在该 layoutVersion 内有效；ETag = layoutVersion
// GET /twin/occupancy?layoutVersion=7
// ETag = sha256(layoutVersion + 各数组内容) 截断（v2.1 N2：旧的 max(movement.id) 在并发提交乱序时会漏更新，且不覆盖启停）
{ "layoutVersion":7, "asOf":"…", "qty":[0,12,…], "skuCount":[0,1,…], "fill":[0,0.4,…],
  "isActive":[1,1,0,…], "effectiveMax":[null,…] }
```
测试（N2）：两笔并发提交以相反顺序 commit 后最终 ETag/内容一致；停用仓位后 ETag 改变。
v1 的 `?since=` 增量**取消**（D17）：5k 仓位三数组 gzip 约 15–30KB，收到 SSE 防抖 500ms 后全量拉取即可。客户端持有的 `layoutVersion` 与响应/事件不符时，先重新加载 `/twin`。
