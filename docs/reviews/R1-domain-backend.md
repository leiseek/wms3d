# R1 独立评审：领域模型 / 库存正确性 / API / 安全 / 运维 / 测试 / 开发计划

- 评审人：独立评审 SubAgent（非作者）· 日期：2026-11-11（PT）· 对象：设计 v1（commit 23f8b32），docs/00–10、adr/0001–0008、sources.md
- 方法：通读全部文档，逐条交叉核对表名、字段、端点和枚举；在 npm registry 核对库版本（2026-11-11 PT 实测，见第 47 条）。
- 严重级别：**BLOCKER**＝不改就会造成数据错误或无法实现，必须在契约冻结（M0）前修掉；**MAJOR**＝正确性、安全或进度有明显风险，应在 M0/M1 内解决；**MINOR**＝一致性或可维护性问题。
- 汇总：**BLOCKER 6 · MAJOR 24 · MINOR 20 · 共 50 条**（逐条见下文）。

---

## A. 库存台账、幂等与并发

1. **BLOCKER** · 02 §5 step1、03 §4、ADR-0003 —— **幂等插入在 PG 中的写法会导致事务中止**
   问题：设计写的是先在事务内 `INSERT inv_txns`，“若唯一键冲突”再比对 hash。PostgreSQL 中，唯一键冲突（23505）会让整个事务进入 aborted 状态，之后不能在同一事务里再 SELECT 首次结果。03 §4 的“并发两请求由唯一索引裁决，失败方读取已提交结果”也没有给出可行的写法。另外，如果首个请求后来因 `INSUFFICIENT_STOCK` 回滚，第二个请求会在唯一索引上阻塞，等对方回滚后才继续执行，这个行为文档里也没有写。
   修复：明确使用 `INSERT ... ON CONFLICT (scope, idempotency_key) DO NOTHING RETURNING id`。返回 0 行时，在新语句里 `SELECT` 已提交的行：在 READ COMMITTED 下，这条语句会等冲突事务结束。然后比对 `request_hash`，相同返回 200，不同返回 409。另一种写法是把 INSERT 包进 SAVEPOINT。在 ADR-0003 写明：“首个请求失败（4xx 回滚）的键不留痕，同键重放会重新执行”，这一点也是第 6 条自动重试的前提。

2. **BLOCKER** · 02 §4 `inv_txns`、03 §4 —— **重放无法返回“首次结果”**
   问题：03 规定重放时返回 200 和“首次结果 `{txn, balances}`”，但 `inv_txns` 没有保存响应。如果重放时读当前余额，返回的就不是首次的结果，客户端异常单和本机历史里显示的数量会是错的。
   修复：选一种：(a) `inv_txns` 增加 `response jsonb`，在同一事务里写入；(b) 重放时用 `stock_movements.balance_after` 重建 `balances`，并在契约中写明 `balances` 的含义是“该交易提交后的余额”，不是“当前余额”。推荐 (b)，不冗余；契约字段改名为 `balancesAfter`。

3. **MAJOR** · 02 §4 `unique(idempotency_key)`、03 §4 —— **幂等键是全局作用域，存在越权读取和误判**
   问题：键全局唯一，且没有校验调用者身份。用户 B 只要拿到 A 的键（日志、异常单截图里都可能出现），带相同 body 重放就能拿到 A 的交易结果，换个 body 则得到 409。如果客户端 UUID 生成有缺陷（WebView 里 `crypto.randomUUID` 不可用时回退到 Math.random），还可能把不同设备的命令误判成重放。
   修复：唯一键改为 `unique(warehouse_id, idempotency_key)`。重放命中时校验 `user_id` 和 `device_id` 与首次一致，不一致返回 409 `IDEMPOTENCY_KEY_REUSED`，且不泄露首次内容。客户端 UUIDv7 必须用 `crypto.getRandomValues`（`uuid@14` 的 `v7()`）。

4. **MAJOR** · 03 §4 `request_hash = sha256(规范化 body)` —— **“规范化”没有定义**
   问题：客户端可以传 `locationCode/skuBarcode` 代替 id（03 §5）。如果 hash 在服务端解析之后计算，同一条离线原文在主数据变更前后会得到不同的 hash，结果误报 409。键顺序、`lotNo` 缺省和 `""`、数字格式也会影响 hash。
   修复：在 contracts 中定义：先用 Zod 解析并补默认值，再对**解析前的原始请求字段**按 RFC 8785（JCS）规范化，排除 `clientCreatedAt` 以外的传输层字段，然后算 sha256。在契约测试里放一组固定向量（golden vectors）。

5. **MAJOR** · 03 §5 `/counts/:id/submissions (Idempotency-Key)`、`/counts/:id/close`、`/layout/publish` —— **非库存端点的幂等没有落地**
   问题：盘点提交要求带 `Idempotency-Key`，但 `count_lines` 和 `count_tasks` 上没有存键的地方。`/counts/:id/close` 被重试或两个主管同时点击，会生成**两笔 COUNT_ADJUST**，造成重复记账。发布布局重试也会让 `published_layout_version` 加两次。
   修复：(a) close 和 publish 用状态 CAS：`UPDATE count_tasks SET status='CLOSED' WHERE id=$1 AND status='REVIEW' RETURNING`，0 行时返回 409 或返回已有的 `closed_txn_id`。COUNT_ADJUST 的幂等键固定为 `count-close:{taskId}`，复用 inv_txns 唯一键。(b) 新增通用表 `idempotency_keys(scope, key, request_hash, response jsonb, created_at)`，供盘点提交等非库存写入使用；或者把盘点提交设计成天然幂等（按 `(task, location)` 整体覆盖 upsert）并写明。

6. **MAJOR** · 04 §4、03 §3 “4xx 不重试”、ADR-0007 —— **离线出库遇到跨设备乱序，产生大量假异常单**
   问题：发送器只保证**单设备**有序。平板 A 离线把货上架到 X（排队中），手机 B 在线从 X 拣货，会得到 `INSUFFICIENT_STOCK`，进入异常单，但货物实际已经离开。按现规则需要人工“以新键重提”，现场 50 台设备时异常单会大量堆积；主管为了消单可能做错误的 ADJUST，最终账实不符。
   修复：(a) 规定 `INSUFFICIENT_STOCK` 属于**可延迟重试**的错误：outbox 状态 `WAITING_STOCK`，用同一个键（依据第 1 条，失败的键不留痕）每 2 分钟重试一次、最长 24 小时，超时再升级成异常单。(b) 设备心跳上报待传条数（`devices.pending_outbox`），后台显示“全仓待同步 N 条”。(c) 异常单页给出处理选项：等待、改仓位、找主管调整（ADJUST 必须引用异常单号作为 `ref_no`）。

7. **BLOCKER** · 02 §5、§6 —— **仓位停用、容量、混放规则没有进入原子写路径，存在竞态**
   问题：§5 的 `postTransaction` 只做余额原子更新，没有说明在哪里、用什么锁来校验 `LOCATION_INACTIVE`、`max_qty` 和 `allow_mixed_sku`。容量和混放是**跨 SKU** 的仓位级约束，两个并发入库各自读到“未满”后都会成功，结果超容；两个不同 SKU 同时入一个空仓位，混放约束被突破。布局发布或 `PATCH /locations/:id` 在“检查无库存”和“停用”之间，可能刚好有入库提交，留下停用仓位上的悬空库存（风险 R5 的真实成因）。
   修复：`postTransaction` 先把涉及的 `locations` 行按 id 排序后 `SELECT ... FOR SHARE`（只有容量或混放启用时才 `FOR UPDATE`，序列化同一仓位的入库），在锁内校验 is_active、容量和混放。发布和停用流程先对目标 locations `FOR UPDATE`，再检查 `stock_balances` 是否为 0，然后置 `is_active=false`，形成互斥。锁的顺序统一为 locations(id) → stock_balances(location, sku, lot)，写进 ADR-0003，并补并发测试（见第 40 条）。

8. **MAJOR** · 02 §5 step2 —— **同一交易内的重复行和 TRANSFER 展开顺序没有定义**
   问题：TRANSFER 一行会展开成两条余额变更；同一命令里也可能出现同一 (location, sku, lot) 的多行，比如连续扫码合并失败。如果只对“命令行”排序而不是对“展开后的余额键”排序，仍可能死锁；重复键逐行处理时 `balance_after` 的顺序也不确定。
   修复：在 domain 中提供纯函数 `planMovements(cmd) → 排序后的 [{key, delta}]`，展开后按键排序；同键默认合并（delta 求和，0 时报错）或按原顺序依次处理，二选一写明。每笔命令最多 200 行（Zod `max(200)`），INBOUND、OUTBOUND、TRANSFER 的 `qty` 用 `int().positive()`，ADJUST 的 `qtyDelta` 不为 0，TRANSFER 的 from ≠ to。

9. **MAJOR** · 02 §4、§5 —— **跨仓库写入校验缺失（IDOR）**
   问题：权限检查的是命令里的 `warehouseId`，但 `lines[].locationId` 可以属于别的仓库。只被授权 WH1 的操作员带上 `warehouseId=WH1` 和 WH2 的 locationId，就能改 WH2 的库存。`stock_balances` 主键里没有 warehouse，余额行上冗余的 `warehouse_id` 也可能与 location 不一致。
   修复：在第 7 条的 locations 加锁查询里加上 `AND warehouse_id = $cmd.warehouseId`，行数不符返回 404 或 403。DB 层给 `locations` 加 `unique(id, warehouse_id)`，`stock_balances` 和 `stock_movements` 用复合外键 `(location_id, warehouse_id) → locations(id, warehouse_id)`，从约束上保证一致。

10. **BLOCKER** · 02 §6“盘点冻结”、03 盘点、10 M5-1 —— **盘点差异公式在并发和离线下会算错并生成错误调整**
    问题：“差异 = 计数 −（快照 + 期间流水）”有三个漏洞：
    (a) “期间”的终点没有定义，是 counted_at 还是 close 时刻？如果按 close 计，计数之后发生的正常出入库会被重复计入。
    (b) 用 `created_at`（事务开始时间，`now()`）界定“期间”不可靠：在 READ COMMITTED 下，一笔事务可能在快照之前开始、之后才提交，结果被漏算或重复算；bigserial id 同样不按提交顺序。
    (c) **离线单据**：实物在计数前已经移动，但单据在计数之后才同步，按服务器时间会被算进“期间”，生成错误的 COUNT_ADJUST。
    另外，“按仓位整体提交”时，快照中有但本次未扫到的 SKU 是按 0 处理还是忽略，没有写明；快照中没有但实际扫到的 SKU 怎么建行，也没有写。
    修复：放弃“快照 + 期间流水”，改为**提交即对账**：`/counts/:id/submissions` 在事务内 `SELECT on_hand ... FOR SHARE` 读取该仓位全部余额，写入 `count_lines.system_qty_at_count` 和 `counted_qty`，差异 `variance = counted − system_qty_at_count` 在提交时就固定下来。close 时按 variance 生成 **delta** 型 COUNT_ADJUST，不按绝对值覆盖；负 delta 仍走条件扣减，不足时这一行进入复核。规定整仓位提交时未扫到的 SKU 计为 0，并允许新增行。close 前检查全仓是否有待同步的 outbox（第 6 条 b），有则警告；`count_lines` 增加 `client_counted_at`。`snapshot_qty` 只用于展示。

11. **MAJOR** · 02 §5 “不变量”、§4 触发器、08 §3 —— **“只追加”约束与 schema、权限自相矛盾，也不防 TRUNCATE**
    问题：`inv_txns.status default 'POSTED'` 暗示会有状态更新，但触发器禁止 UPDATE。行级触发器拦不住 `TRUNCATE`。应用账号如果是表的属主，可以直接 `ALTER TABLE ... DISABLE TRIGGER`。“更正 = 反向交易”没有字段、类型或端点支撑。
    修复：(a) 去掉 `status`，或改为只写一次的枚举并写明不可变；增加 `reverses_txn_id uuid null`，类型加 `REVERSAL`，端点 `POST /inventory/transactions/:id/reverse`（MANAGER 以上，带幂等键，生成逐行反向分录，余额不足则 422）。(b) 增加语句级 `BEFORE TRUNCATE` 触发器。(c) 拆分数据库角色：`wms_owner` 负责迁移，`wms_app` 是运行时账号，对 ledger 和 audit 表只授予 INSERT 和 SELECT（`REVOKE UPDATE, DELETE, TRUNCATE`）。docker-compose 和 dev-db.sh 都按这个方式创建。

12. **MINOR** · 02 §5 step3、§5 不变量、08 §4 —— **清理 0 余额行与对账的口径**
    问题：清理 0 行之后，某些 (location, sku, lot) 的流水合计为 0 但没有余额行。对账 SQL 如果用 INNER JOIN 不会出错，但用 `FULL JOIN` 并把缺失当错误就会误报。每晚全量 `SUM` 会随流水增长而线性变慢。
    修复：对账用 `FULL OUTER JOIN` 并把 `COALESCE` 缺失视为 0。增加 `reconcile_checkpoints(max_movement_id)` 做增量对账，每周跑一次全量。“最新 movement 的 balance_after = on_hand”只对存在余额行的键检查。

13. **MINOR** · 02 §4 `stock_balances.version` —— 这个字段没有任何读写方。要么删掉，要么写明用途（例如作为 occupancy 的变更游标；第 16 条推荐的是另一种做法）。

## B. 仓位编码、条码命名空间与布局版本

14. **BLOCKER** · 02 §3、ADR-0008、09 §2 seed —— **默认仓位编码不含货架号，同一巷道的多个货架会编码冲突**
    问题：默认模式是 `{Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2}`，而 `rack_types.bays` 是**每个货架**的列数（seed 为 4 列），每条巷道有 8 个货架。如果 bay 在货架内编号（1–4），同巷道 8 个货架都会产生 `A03-01-A01`，撞上 `unique(warehouse_id, code)`，种子数据都无法发布。巷道两侧的货架（背靠背或面对面）也会重号。布局文档里的 rack 没有 `bayStart` 或 `side` 字段，`expandRack(rack, rackType)` 无法算出整条巷道连续的 bay 号。
    修复：二选一写进 ADR-0008 和 02 §7：(a) **巷道连续编号**：rack 增加 `bayStart`，设计器“阵列复制”时自动递增，并按奇偶分侧（左侧奇数、右侧偶数，行业常见做法）；校验器检查同一巷道 bay 区间不重叠。(b) 模式中加入 `{Rack:2}` 段，例如 `A03-01-02-C02`。推荐 (a)，保持编码短，同时增加 `side: 'L'|'R'`。在 domain 单测里加上“seed 布局全部编码唯一”的属性测试。

15. **MAJOR** · 02 §7 发布、05 §2 —— **稳定匹配保留了 id，但编码可能改变，标签失效且可能触发唯一约束**
    问题：仓位以 `(rack.key, bay, level, position)` 匹配并保留 `location.id`，但设计器改了 aisle、rackNo、zone 或 bayStart 之后，`code` 会改变：已贴的标签立即失效，有库存的仓位“换了名字”，作业员扫旧标签会得到 UNKNOWN。两个货架互换编号时，单事务内逐行 UPDATE 会**瞬时违反** `unique(warehouse_id, code)`。
    修复：(a) 发布差异增加“编码变更”类别，有库存仓位改码需要二次确认，并自动生成“待补打标签”清单（链接到标签打印页）。(b) 唯一约束改为 `DEFERRABLE INITIALLY DEFERRED`，或分两阶段更新（先改成临时码再改成目标码）。(c) 可选：新增 `location_aliases(old_code → location_id, valid_until)`，过渡期让旧标签仍能解析。

16. **MAJOR** · 03 §5 `/inventory/locate` 返回 `twinIndex`、06 §5–6 —— **twinIndex 与布局版本耦合，3D 可能高亮错误的仓位**
    问题：twinIndex 是“某个 layoutVersion 下的数组下标”。发布新布局后，持有旧 TwinModel 的客户端（缓存在 IndexedDB 里，SSE 可能错过 `layout.published`）调用 locate 或 occupancy，下标会错位，3D 会把 SKU 高亮到**别的仓位**上，“所见即所存”变成“所见即错存”。
    修复：locate 和 occupancy 的响应必须带 `layoutVersion`，客户端版本不一致时先重新加载 TwinModel。或者 locate 只返回 `locationId`，由客户端用 `id → index` 映射表查下标。occupancy 请求带 `?layoutVersion=`，不匹配返回 409 `LAYOUT_STALE`（加入错误码表）。

17. **MAJOR** · 03 §5 `/twin/occupancy?since=`、06 §6 —— **增量游标在 READ COMMITTED 下会漏更新，且 03 与 06 的格式不一致**
    问题：`since` 的含义没有定义。如果用时间戳或 bigserial，都会因为提交顺序与赋值顺序不同而漏掉变更，导致 3D 长期显示旧库存。03 规定 occupancy 是与 twinIndex 对齐的全量数组，06 则说增量返回 `(twinIndex, qty, fill)` 三元组，两处不一致。
    修复：MVP **取消 `since`**。5,000 个仓位的 `qty`、`skuCount`、`fill` 三个数组 gzip 后约 15–30 KB，收到 SSE 后防抖 500 ms 再全量拉取，配合 `ETag`（例如 `max(stock_movements.id)` 加 layoutVersion 的 hash）返回 304。如果以后要做增量，用“游标减去安全窗口”并让客户端幂等覆盖。

18. **MAJOR** · 02 §3 “条码命名空间”—— **用视图做唯一约束是做不到的；多仓库下还会串仓**
    问题：(a) 视图不能建唯一约束，“写入时校验”在 READ COMMITTED 下有竞态：SKU 条码新增和布局发布可能同时写入相同的字符串。(b) `sku_barcodes.barcode` 是全局唯一，而 `locations.code` 是按仓库唯一，“同一仓库组织内”的范围没有定义。(c) WH1 和 WH2 都会有 `A03-12-C02`，条码内容只有编码（07 §3），作业员拿着 WH2 的设备扫了 WH1 的标签（或者跨仓借用设备），会被**静默解析**成当前仓库的仓位。“标签上印仓库代码”只能防人眼看错。
    修复：建一张实体表 `barcode_registry(value text primary key, kind, warehouse_id null, entity_id)`，SKU 条码、仓位码和货架码的写入都在同一事务里插入它，靠主键裁决冲突。仓位条码内容可选加仓库前缀（`WH1.A03-12-C02`，仓库级开关，单仓库默认关）；`classifyScan` 识别前缀后校验是否与当前仓库一致，不一致返回 `WRONG_WAREHOUSE`。另外写明 `locations.barcode` 与 `code` 的关系（建议删掉 barcode 列，标签内容一律由 code 派生）。

19. **MAJOR** · 02 §4 `zones`/`rack_types`/`racks` vs 02 §7 布局文档、03 §5 —— **结构数据有两个真相源**
    问题：库区既能通过 `/warehouses/:id/zones` 做 CRUD，又存在布局文档的 `zones[]` 里；货架模板既是全局的 `/rack-types` 表（uuid、无 key），又以 `rackTypes[].key` 内嵌在文档里；`racks.rack_type_id` 是 uuid，而文档里的 `"type":"std-4x5"` 是 key。修改全局模板会让已发布布局的仓位几何“悄悄”改变，3D 和编码随之漂移。
    修复：规定**布局文档是结构的唯一真相源**：`zones`、`racks` 表只是发布时生成的投影，只读。`/zones` 的 CRUD 改为编辑草稿文档，或者删掉这个端点。全局 `rack_types` 只作为“模板库”，放进草稿时按值复制到 `doc.rackTypes`（快照），发布后不随模板库变化。`rack_types` 表增加 `key` 列。

20. **MINOR** · 02 §2 vs §4 —— 仓位覆盖字段不一致：§2 写 `disabled`、`max_qty`、`max_weight`，表里是 `is_active`、`max_qty`，**没有** `max_weight`。另外需要写明覆盖项只存在于 `locations` 表、不进布局文档，发布时保留（防止 05 立面视图的批量停用被下次发布覆盖）。有效容量统一为 `effective_max = locations.max_qty ?? rack_type.default_max_qty`，06 着色和 02 容量校验都用它。

21. **MINOR** · 02 §4 `warehouses` vs 02 §6、03 §1 —— `allow_mixed_sku` 和 `timezone`（03 说要加）不在表里；`code_locked` 与“`location_code_pattern` 已有仓位则锁定”重复，二者应以其一为准（建议直接用 `EXISTS(locations)` 推导）。

22. **MINOR** · 02 §3、ADR-0008 —— 编码相关的 code 列应声明 `COLLATE "C"`。否则在 glibc 或 ICU 的 locale 下，`-` 等标点会被忽略后排序，“字典序≈行走顺序”不成立；而且 dev 用的 zonky 二进制与 `postgres:17-alpine`（musl）的默认排序不同（见第 37 条）。

23. **MINOR** · 02 §7 `layout_versions`、03 `PUT /layout/draft (If-Match)`、05 §2.2 —— 草稿乐观锁的“版本”没有对应字段（`version` 是布局版本号，不是行版本），“另存为新草稿”意味着可以有多个 DRAFT，却没有唯一约束。修复：加 `row_version int` 和 `partial unique(warehouse_id) WHERE status='DRAFT'`（每仓库只允许一个草稿），删掉“另存为新草稿”或改为“覆盖前导出”。

## C. 主数据与离线同步

24. **MAJOR** · 03 §5 `/sync/masterdata?since=`、02 §4 —— **增量同步游标和墓碑没有数据支撑**
    问题：用 `updated_at` 作游标同样有提交顺序问题（参照第 17 条），离线缓存会长期漏掉新条码，“离线校验”反而出错。`locations`、`sku_barcodes` 没有 `updated_at`；条码通过 `DELETE` 物理删除，也没有墓碑表，客户端永远不会知道某个条码已经删除。
    修复：给相关表加 `updated_at` 并用触发器维护；新增 `masterdata_tombstones(entity, entity_id, deleted_at)`。游标 = 客户端已见的最大 `updated_at` 减 10 秒安全窗口，客户端按 id 幂等 upsert；每日前台全量校验一次（用 ETag 或计数哈希比对）。

25. **MINOR** · 02 §4 `skus` 全局 vs 仓库授权 —— SKU 主数据是全局的，WH1 的 MANAGER 能修改 WH2 也在用的 SKU，这一点没有在 08 权限矩阵中说明。MVP 可以接受，但应写明“SKU 是组织级数据，只有 ADMIN 或被授权全部仓库的 MANAGER 可以改”，或者接受现状并在审计里记录。

26. **MINOR** · 02 §4 —— `users.role` 是全局单角色，`user_warehouses` 没有角色字段，无法表达“WH1 的主管同时是 WH2 的操作员”。MVP 可以接受，但应在 08 中写明限制，并预留 `user_warehouses.role null`（覆盖全局角色）。

## D. API 一致性

27. **MAJOR** · 03 §1 “仓库作用域”—— **仓库授权的判定规则不统一，存在越权风险**
    问题：仓库 id 有时出现在路径里（`/warehouses/:id/...`），有时在 query 里（`/inventory/*?warehouseId=`），有时在 body 里（交易命令），还有些只能从资源反推（`PATCH /locations/:id`、`/counts/:id/*`、`/inventory/transactions/:id`）。`/counts` 的创建和列表甚至没有 warehouseId。每个路由各写各的检查，迟早会漏。
    修复：统一放在 contracts 中，每个路由声明 `scope: {from: 'path'|'query'|'body'|'resource', resolver}`，由 Fastify `preHandler` 统一解析并校验 `user_warehouses`；资源型路由先查出资源所属仓库再校验，失败一律返回 404（不暴露存在性）。在集成测试中为**每个端点**自动生成越权用例（参见第 41 条）。

28. **MAJOR** · 03 §5 `/events`（SSE）、08 —— **SSE 的鉴权、过期和恢复没有设计**
    问题：浏览器 `EventSource` 不能设置 `Authorization` 头；而 Web 端的 cookie 只给 refresh 端点用（SameSite=Strict），所以 SSE 无法鉴权。连接建立后会活过 15 分钟的 JWT 有效期，权限被撤销后仍能继续收到事件。断线重连期间丢失的事件也不会补发。
    修复：使用基于 fetch 的 SSE（如 `@microsoft/fetch-event-source`），带 `Authorization` 头，遇到 401 先刷新再重连。服务端在 JWT 过期时主动关闭流。每次（重新）连接后客户端都先全量拉一次 occupancy（第 17 条）。不要把 token 放进 query 参数，否则会进入 Caddy 和 pino 日志。连接建立时校验 `warehouseId` 授权。写明 MVP 单实例：事件总线在进程内，多副本需要 PG `LISTEN/NOTIFY`。

29. **MAJOR** · 03 §3、04 §4 —— **离线队列遇到 401/403 时的行为没有定义**
    问题：规则是“4xx 不重试，进入异常单”。设备离线超过 15 分钟后恢复，第一批请求必定 401；按规则会把整个队列打成异常单，或者在刷新失败（refresh 已过期或家族被撤销）时卡死。下一个登录的用户如果用自己的 token 提交上一个人的单据，操作人归属就错了。
    修复：401 → 暂停发送器，刷新后重放；刷新失败则进入 `BLOCKED_AUTH`，要求**原操作员**重新登录，不进异常单。outbox 记录 `operatorUserId`，服务端拒绝 token 用户与 operator 不一致的提交（或记为 `submitted_by` 和 `performed_by` 两个字段）。403（授权被撤销）→ 进异常单，并带上明确原因。409 `IDEMPOTENCY_KEY_REUSED` 视为客户端 bug，上报 traceId。

30. **MINOR** · 03 §5 —— 端点清单缺少其他文档引用的功能：
    - 设备管理 `/devices`（08 §2 禁用设备、05 系统-设备）
    - `/app/version`（08 §5）
    - 修改密码 `/me/password`（09 首次强制改密）
    - 布局历史列表和“基于版本创建草稿”（05 §2.2）
    - 仓位批量编辑 pick_seq（05 §1）
    - 盘点取消（02 状态 CANCELLED）
    - 流水 CSV 导出路径
    - 交易冲正（第 11 条）
    在 M0 冻结契约前补齐。

31. **MINOR** · 03 交易命令 vs 02 §4 —— ADJUST 带 `reason`，但 `inv_txns` 没有 reason 列（只有 `stock_movements.reason`）；原因码枚举（DAMAGE、LOST、FOUND、…）不在 contracts 中；COUNT_ADJUST 不接受客户端提交这一点也没有在判别联合中写明。`clientCreatedAt` 应当存储并用于报表，但“今日出入库”按哪个时间算需要写明（建议业务时间取 `client_created_at`，并截断到服务端时间加减 24 小时内）。

32. **MINOR** · 03 §3 —— problem `type` 用的是 `https://wms3d.dev/errors/...`，这个域名不受控。改为 `urn:wms3d:error:INSUFFICIENT_STOCK`，或者用自托管的 `/api/v1/errors/...`。错误码表补上 `WRONG_WAREHOUSE`、`LAYOUT_STALE`、`DEVICE_DISABLED`、`TXN_ALREADY_REVERSED`。

33. **MINOR** · 03 §1 分页 —— 流水和交易按 `created_at desc, id` 分页时，`created_at` 是事务开始时间，同一时间戳有大量记录，顺序也和提交顺序不一致。台账类列表改为按 `id desc` 的 keyset 游标。

## E. 安全、RBAC 与审计

34. **MAJOR** · 02 §4 `audit_logs`、08 §1、§3 —— **“MANAGER 只读本仓审计”在当前 schema 下无法实现，审计写入的原子性也没有规定**
    问题：`audit_logs` 没有 `warehouse_id`，无法按仓库过滤。审计如果在业务事务提交后另外写入，崩溃时会丢失；如果在事务外写，回滚的操作反而会留下审计记录。
    修复：加 `warehouse_id null`、`trace_id`、`result`（success 或 denied）。关键操作的审计记录与业务数据在**同一事务**内写入。登录失败的审计单独写，并按 IP 和账号做聚合限流，防止刷爆审计表。

35. **MAJOR** · 01 §6、04 §1、08 §2 —— **App 信任内网 CA 和服务器配置二维码存在安全与实现缺口**
    问题：(a) Android 7+ 的 App 默认不信任用户安装的 CA。“内网用内部 CA 并在 App 中信任”要么需要在构建时打包客户的 CA（每个客户一个 APK），要么需要自定义 TrustManager，文档没有给出方案。(b) `wms3d://config?api=` 二维码可以被伪造：攻击者贴一张二维码，就能把 App 指向钓鱼服务器收集账号密码。
    修复：给出两条明确的部署路径：① 公网域名配 ACME（内网环境用 DNS-01 签发，Caddy 支持），这是推荐方案，App 不需要任何特殊信任；② 内部 CA：二维码内容里带上 CA 证书的 SHA-256 指纹，App 的原生插件用自定义 TrustManager 只信任该指纹（固定证书），首次配置时显示主机名和指纹并要求确认。release 构建禁止 `cleartextTraffic`（已写）。

36. **MINOR** · 08 §2、02 `devices` —— 08 写了“后台可禁用设备”，但 `devices` 表没有 `disabled_at` 列；JWT 也不含 deviceId，禁用设备之后已签发的 access token 还能用 15 分钟。修复：加 `disabled_at`，JWT 带 `did`，敏感写接口（库存交易）校验设备状态（可以缓存 60 秒）。另外，refresh 令牌存储安全推迟到“M3 时评估”，应在 M0 选定方案（推荐自研插件里用 AES-GCM 加 Keystore，见 04 §6），避免 M3 返工。

## F. 运维：部署与备份

37. **MAJOR** · 08 §5、01 §7 —— **备份 RPO 24 小时，且备份与数据在同一块磁盘**
    问题：备份放在 `./backups`，与 `pgdata` 位于同一台主机的同一块盘。磁盘损坏时数据和备份一起丢失，“RPO ≤ 24h”实际无法兑现。对扫码作业来说，丢一天流水意味着全仓重新盘点。`postgres:17-alpine` 镜像里没有 cron，`/backup.sh` 的调度方式没有说明。alpine（musl）与开发用的 glibc 二进制排序规则不同，恢复演练和线上行为可能不一致。
    修复：默认启用**异地拷贝**（rclone 到 S3 或 MinIO 等任意对象存储，或另一台主机），并把 WAL 归档或 `pgBackRest`、`wal-g`（RPO 15 分钟）从“可选”升为“推荐默认”。镜像改用 `postgres:17`（Debian），与 dev 保持同一 libc。backup 容器的调度写清楚（用 `sleep` 循环加时间判断，或 supercronic）。恢复演练脚本跑完要执行对账（已写）并输出报告。

38. **MINOR** · 08 §5 —— Caddy 通过 bind mount 挂载 `../apps/admin/dist`，要求在宿主机上构建前端，与“全新机器 30 分钟部署”冲突。改为多阶段 Dockerfile，把 admin 静态资源打进 caddy 镜像，或者由 api 镜像提供。迁移在启动时执行，应加 PG advisory lock，防止误启动多个副本时并发迁移。compose 服务名（db/api/web/backup）与 01 §1 写的（caddy/api/postgres/backup）不一致，统一一下。

39. **MAJOR** · 10 M6-2、01 §8、风险 R7 —— **部署验收在本机无法验证**
    问题：本机没有 Docker，M6 的验收“全新机器 30 分钟部署成功”交给“在有 Docker 的环境验证”，但计划里没有这样的环境，交付物等于没有验收。
    修复：在 M0 加一个 spike：尝试用 Docker 官方 static binaries（`download.docker.com/linux/static`，走 curl 而不是 apt）或 podman 静态包装出可用的容器运行时。如果确实做不到，交付时提供 **systemd + PG 二进制 + node** 的一键脚本作为在本机验证过的部署路径，compose 文件标注“未在本机验证”，并在交付报告中如实说明。

## G. 可测试性

40. **MAJOR** · 09 §1 并发/不变量 —— **关键竞态没有被测试覆盖**
    问题：现有用例只覆盖“同仓位 50 并发出库”和“同键 20 并发”。下面这些都可能出错，却没有测试：
    - 发布布局与入库并发（第 7 条）
    - 容量和混放并发（第 7 条）
    - close 双击（第 5 条）
    - 首请求失败后同键重放（第 1 条）
    - TRANSFER 环形死锁：A→B 与 B→A 同时发生
    - 盘点提交与出库并发（第 10 条）
    - 跨仓库 locationId 越权（第 9 条）
    修复：把以上加入“必过”清单。使用 `pg` 的连接池（`max ≥ 并发数`，否则 `fastify.inject` 下请求会在池里排队，“并发”测试实际是串行）。fast-check 做**基于模型的测试**（commands + 内存模型 oracle），比只断言 SUM 不变量更强。

41. **MINOR** · 09 §1 集成 —— 建议用一个模板库（`CREATE DATABASE t_x TEMPLATE wms_template`）替代“每文件独立 schema 再跑迁移”，速度快一个数量级。RBAC 测试应由路由元数据（第 27 条的 scope 和 role 声明）**自动生成**矩阵用例，而不是手写。

42. **MINOR** · 09 §2 seed —— “30 天随机历史交易”必须通过 `postTransaction` 生成（或者在生成后跑对账），不能直接插表；否则触发器、角色权限（第 11 条）和不变量在 seed 阶段就会被绕过或破坏。

## H. 开发计划（10-dev-plan.md）

43. **BLOCKER** · 10 §1、§2、§4 —— **WS-D 在 M2 和 M4 同时主导两个 5 天任务，且设计器依赖尚未构建的 twin3d**
    问题：WS-D 在 M2 负责布局设计器，在 M4 负责 3D 孪生，两者都在 M0 结束后同时开始、各 5 天，一个 Agent 被重复排期。设计器的“3D 预览分屏”和“立面视图”依赖 `packages/twin3d`，而 twin3d 要到 M4 才做出来，依赖顺序反了。
    修复：把 WS-D 拆成 **WS-D1 设计器**（`apps/admin/src/features/layout-designer/**`）和 **WS-D2 twin3d**（`packages/twin3d/**`）。设计器的 3D 预览推到 M4 之后作为接线任务，或者 twin3d 先在第 2 天交付最小可用版（地面加货架框加仓位方块的静态渲染）。在甘特图上画出这个依赖。

44. **MAJOR** · 10 M0 —— **M0 两天无法完成，而且契约冻结点在本次评审的修复之前**
    问题：M0 两天要做完：monorepo 工具链、全部 MVP 端点的 Zod 契约、全部表的 Drizzle schema 和触发器、domain 的四组核心算法及单测（其中 validateLayout 含 OBB 相交检测）、api-client、MSW mock、两个 App 外壳、APK 构建。而 R1 发现的编码冲突、幂等、盘点和数据真相源等问题（第 1、2、10、14、19 条）都会改动契约。
    修复：M0 拆成两段：**M0a**（1 天：工具链、dev-db、App 外壳、APK 冒烟、Docker spike）和 **M0b**（2–3 天：契约加 schema 加 domain 接口，在 R1/R2 修复合入之后**冻结**）。domain 的算法实现（expandLayout、validateLayout、classifyScan）从 Lead 下放给 WS-D1 或 WS-A，Lead 只负责签名和评审，避免 Lead 成为瓶颈。

45. **MAJOR** · 10 §1 冲突规避 —— **多 Agent 在同一台机器上并行开发，计划没有安排隔离**
    问题：所有 SubAgent 共用这台机器的同一个文件系统。“每个 WS 一个分支”意味着在同一个工作目录里来回 `git checkout`，必然互相覆盖。dev PG 固定端口 55432 和数据目录 `.pgdata/`、Vite 和 api 的端口、`node_modules` 和 pnpm store 的并发写入都会冲突。另外，`packages/api-client`、`packages/ui` 没有指定负责人；lockfile 由谁合并前后矛盾（“WS-F 统一合并”与“Lead 合并时重建”）。
    修复：每个 WS 使用独立的 `git worktree`（`/workspace/wms3d-wt/ws-a` 等）。`dev-db.sh` 支持 `WMS_PG_PORT` 和 `WMS_DB_NAME`，一个 PG 实例按 WS 分库，端口按 WS 偏移（api 3000+n，vite 5173+n）。共享一个 pnpm store（`pnpm install --frozen-lockfile` 可以并发）。`packages/api-client` 归 Lead（随契约生成），`packages/ui` 归 WS-C。lockfile 只由 Lead 在合并时重建，并删掉 WS-F 那句。契约变更请求规定 SLA（Lead 每天批处理两次），在等待期间 WS 用本地 shim 开发。

46. **MAJOR** · 10 §2、§4 —— **收敛阶段的依赖和工期不现实**
    问题：(a) M5 只依赖 M1，但它包含 PC（WS-B）和移动端（WS-C）的盘点界面，而这两个 WS 在 M2/M3 要做到第 7 天，M5 第 7 天就开始，资源冲突。(b) M6 没有声明依赖 M2、M3、M4。(c) “M1 完成后切换到真实 API 联调，每个 WS 预留 0.5 天”过于乐观：基于 mock 开发 5 天后切真实接口，通常会暴露鉴权、错误模型、分页和 SSE 方面的差异。(d) 关键路径漏掉了移动端离线与真实 API 的联调，以及盘点（第 10 条重做后工作量会增加）。
    修复：增加 **M4.5 联调**（2 天，全员，M1 到 M4 完成后开始，集中处理 mock 与真实接口的差异和 SSE 接线）。M5 依赖 M1 和 M4.5；M6 依赖全部前序里程碑。MSW mock 必须由 contracts 的示例数据**自动生成**，并在 CI 中校验与 OpenAPI 一致，从源头减少偏差。总工期从约 13 个工作日调整为 16–18 个工作日。

47. **MINOR** · 01 §1 版本基线（npm registry 实测，2026-11-11 PT）——
    - `antd` 的 latest 已经是 **6.7.0**，设计写的是 AntD 5。新项目应该直接用 v6，或者在文档中说明为什么锁 5.x。
    - `drizzle-orm` 稳定版是 0.45.4，**1.0.0-rc.5** 处于 RC 阶段，迁移目录格式有变化。应锁定 `drizzle-orm@0.45`、`drizzle-kit@0.31`，并写明不追 RC。
    - `fastify-type-provider-zod@7.0.0` 的 peer 依赖要求 `zod>=4.1.5`、`fastify ^5.5`、`@fastify/swagger >=9.5.1`，与选型兼容，应写进版本表。
    - `react-konva@19.3.2` 的 peer 依赖要求 `react ^19.3.0`，需要把 React 锁在 ≥ 19.3。
    - `@capacitor-mlkit/barcode-scanning` 最新是 8.2.2（peer `@capacitor/core>=8`），`@capacitor/core` 最新是 8.6.0，符合设计。
    - `three` 最新是 0.187（r187），“r18x”可以接受，但应锁具体版本。
    - Prisma 的 npm `latest` 标签确实是 8.0.0-rc.x，ADR-0002 的说法成立。

48. **MINOR** · 01 §5 vs 02 §3 —— 函数名不一致：01 写 `domain.classify()`，02 写 `domain.classifyScan()`。01 §2 的后端模块列表（masterdata、count…）与 §3 的目录（users、warehouses、skus、counts…）也不一致。以 01 §3 为准统一。

49. **MINOR** · 06 §4 vs 02 §4 —— 06 的着色规则用 `fill ratio`（有 max_qty 时为数量比），02 的视图 `v_location_occupancy.fill_ratio` 没有给出计算口径，也没有说明 `max_qty` 为空时取什么值。按第 20 条的 `effective_max` 统一定义，并让 `fill` 数组固定在 [0, 1] 区间。

50. **MINOR** · 02 §5 step4、08 §4 —— 事件在提交后由进程内总线发布，进程崩溃时会丢事件。MVP 可以接受，但需要写明兜底：客户端每 60 秒用 ETag 轮询 occupancy，见第 17 条。夜间 `node-cron` 任务运行在 API 进程内，应使用 PG advisory lock 防止重复执行，并把时间按仓库 `timezone` 解析。

---

### 修复优先级建议
1. 契约冻结前必须修掉（BLOCKER）：第 1、2、7、10、14、43 条，以及第 44 条的 M0 拆分（MAJOR，但决定冻结时点）。
2. M1 库存引擎开工前：第 3、4、5、8、9、11、15–19、24、27–29 条。
3. 其余 MAJOR 在对应里程碑的 DoD 中跟踪；MINOR 统一在设计 v2 中批量修正。
