# R3 处理记录（M0b，设计 v2.2 · contract-v1 冻结）

- 日期：2026-11-12（PT）· 处理人：Lead
- 输入：`R3-domain-backend.md`（b30cdfd，APPROVE-WITH-NITS，4 MINOR）、`R3-mobile-3d-labels.md`（7b4cc10，APPROVE-WITH-NITS，5 MINOR）
- 结论：**9 条 MINOR 全部接受并修复**（其中“代交时间窗”在两份评审中重复出现，合并为 1 项处理）；无拒绝。两份结论均允许冻结，`contract-v1` 已打 tag。

| # | 来源 | 问题 | 处理 | 落点 |
|---|---|---|---|---|
| 1 | 后端 #1 + 移动 #5 | 换班代交以 `clientCreatedAt ∈ 会话 ±5 分钟` 判定：可伪造时间把单据记到前一位操作员名下；离线平板时钟漂移会误拒；交易命令示例没有 `deviceId` | **改为按会话归属校验，彻底不依赖设备时钟**：单据带 `performerSessionId`；服务端仅当该 `device_sessions` 属于 performedBy、设备 = 令牌 `did`、`started_at` 在 72 小时内且早于当前令牌会话、performedBy 启用时接受。**设备 ID 一律取自 JWT `did`，body 无 deviceId**。`performed_by` / `submitted_by` / `performer_session_id` 均入库入审计。残余风险（同设备后继用户恶意代记，72h 内）书面接受，由审计 + 交接班“代交单据”报表缓解 | 02 §6.6；03 §5 示例重写；contracts `TxnCommand`（`performerSessionId`，无 `deviceId`；`TXN_HASH_EXCLUDED_FIELDS`）；`AccessClaims.sid`；`LoginResponse.session`；schema `inv_txns.performer_session_id`；错误码 `PERFORMER_NOT_ALLOWED`；mock 已按新规则实现并有用例 |
| 2 | 后端 #2 | `test-db.sh` 吞掉迁移失败，空 schema 模板被缓存 | 迁移脚本存在但失败 → 打印日志尾部、`DROP DATABASE` 模板、`exit 1`；仅脚本不存在时跳过 | `scripts/test-db.sh` |
| 3 | 后端 #3 | `SET LOCAL transaction_timeout='120s'` 是否生效需实测 | **实测（PG 17.11）不生效**：计时在事务开始时以当时的值启动，事务内 `SET LOCAL` 不能延长（1s/5s 等比实验：事务在 1s 被终止）。改为在 **BEGIN 之前**会话级 `SET transaction_timeout`，结束后 `RESET` 回角色默认 30s：`withLongTransaction(pool, '120s', fn)`。09 必过 17 增补“发布事务 60s 不被终止”与反例 | `apps/api/src/db/client.ts`；`db.test.ts`（反例 + 正例 + RESET 校验）；02 §5、03 §1、09 #17；`dev-db.sh` 为 `wms_app` 设 `transaction_timeout`/`idle_in_transaction_session_timeout` = 30s |
| 4 | 后端 #4 | advisory lock 残留单 key 形式；10 §6.5 与 B-N9 冲突 | 02 §9 step 1 → `pg_advisory_xact_lock(LOCK_NS.BARCODE, 0)`；02 §6.5 → `pg_try_advisory_lock(LOCK_NS.JOB, n)`；删除 10 §6.5 “若 WS 新增依赖，Lead 重建 lockfile” | 02、10；常量在 `apps/api/src/db/locks.ts`；迁移器持 `(LOCK_NS.MIGRATION, 0)` |
| 5 | 移动 #1 | errorPath 页只写“WebView 过低”，其它加载错误会误导 | 按 `?missing=` 显示两种文案；无参数 = “页面加载失败” + “重试”（`location.replace('/')`）；仍为纯 ES5 | `apps/mobile/public/webview-too-old.html`；04 §1；无头 Chrome 冒烟两种文案均通过 |
| 6 | 移动 #2 | 检测代码在 ES module 主包内，语法不兼容时执行不到 | `index.html` 中模块脚本**之前**内联 ES5 classic script 做检测与跳转（含 `noModule` 判定）；`runtime-check.ts` 保留为第二层 | `apps/mobile/index.html`、`src/main.tsx`；04 §1 |
| 7 | 移动 #3 | `wrapContentRoot` 失败时静默跳过 | 所有失败分支（content 缺失、子节点数≠1、异常）`Log.w("wms3d.scanner", …)` 并 `ScannerInterceptLayout.markInstalled(false, reason)`；诊断页读 `isInstalled()` / `installError()`。Robolectric 用例排在 M3（WS-C 简报验收项） | `MainActivity.java`、`ScannerInterceptLayout.java`；`docs/workstreams/ws-c.md` |
| 8 | 移动 #4 | `ScanKeyBuffer` 溢出后产出残片 | 溢出进入“丢弃直到终止符”状态（空闲超时同样结束丢弃），`overflowCount()` 供诊断；替换旧的错误断言并新增 2 个 JVM 单测。`ACTION_MULTIPLE` / `getCharacters()` 维持 M3 | `ScanKeyBuffer.java`、`ScanKeyBufferTest.java`；APK 重建时跑 `testDebugUnitTest` |
| 9 | 后端 #1 附 | 03 应写明单据 `deviceId` 来源 | 同 #1：取自 JWT `did`；03 §5 示例注释写明 | 03 §5 |

另：01 §1 的 SSE 行仍写 `@microsoft/fetch-event-source`，与 v2.1 决议（自研客户端）不一致，已改为 `eventsource-parser` 4.1（`packages/api-client/src/sse.ts`）；03 §1 OpenAPI 输出路径改为 `packages/contracts/openapi.json`。
