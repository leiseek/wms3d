# R2 独立评审：领域模型 / 库存正确性 / API / 安全 / 运维 / 开发计划（设计 v2）

- 评审人：独立评审 SubAgent（非作者）· 日期：2026-11-12（PT）· 对象：设计 v2，commits `bfafc4a..b7b0aaa`，以及作者的决议 `docs/reviews/R1-resolution.md`
- 方法：
  - 对照 v2 的实际文档，逐条复核 R1 的 D1–D50。
  - 全文 grep 查找 v1 残留（since、face、IndexedDB outbox、5173 等）。
  - 在 npm registry 复核版本（2026-11-12 PT）：typescript-eslint 8.72.2 的 peer 是 `typescript >=4.8.4 <6.1.0`，TS 7.0.2 已是 latest，所以锁 6.0.x 是对的；vitest 5.1.0、vite 8.3.8、@playwright/test 1.65.0、pg 8.23.1、@capacitor-community/sqlite 8.1.1（peer `@capacitor/core>=8`）、@fastify/swagger 9.9.3 均与 01 §1 一致。
- 严重级别：同 R1。BLOCKER 指冻结 M0b 契约前必须修掉。
- **结论：CHANGES-REQUIRED。** 改动面小而集中，修完后只需复核下列条目，不必再做一轮全面评审。
- 汇总：
  - R1 复核：50 条中 **43 条已修复**；**5 条部分修复，需重开**（D5、D6、D17、D24、D45）；**2 条有一致性残留**（D30、D48，见 N17、N18）。三条部分采纳（D15、D26、D37）**接受**。
  - 新问题：**BLOCKER 1 · MAJOR 9 · MINOR 9 · 共 19 条**（N1–N19）。

---

## 第一部分：R1 逐条复核

| R1 | 结论 | 说明 |
|---|---|---|
| D1 | ✅ 已修复 | 02 §6.2、03 §4.1、ADR-0003 §3 的写法正确，并写明“不依赖捕获 23505” |
| D2 | ✅ | `balancesAfter` 从 `balance_after` 重建 |
| D3 | ✅ | `(warehouse_id, key)`；重放时校验 performed_by 和 device_id；必过清单第 2 项覆盖 |
| D4 | ✅ | JCS 规范化原始请求 + golden vectors |
| D5 | ⚠️ 部分修复 → **N4** | close 用了 CAS，但没写明 CAS 与 COUNT_ADJUST 在同一事务；新增的“行级部分成功”不闭环 |
| D6 | ⚠️ 部分修复 → **N5、N6** | `WAITING_STOCK` 对在线操作也生效，会掩盖人为错误；与“登出需清空 outbox”“performedBy 必须等于令牌用户”冲突 |
| D7 | ✅ | 锁顺序和锁内校验写进了 02 §6.2 和 ADR-0003 |
| D8 | ✅ | planMovements |
| D9 | ✅ | 锁查询带 warehouse_id，并加了复合外键 |
| D10 | ✅（附 N12 MINOR） | 提交即对账，方向正确 |
| D11 | ✅ | REVERSAL、TRUNCATE 触发器、角色拆分 |
| D12 / D13 | ✅ | |
| D14 | ✅ 编码不再冲突，但引入了 **N1（BLOCKER）**：右侧货架 bay 方向反了 |
| D15 | ✅ 部分采纳，**接受**（别名表推迟到 v1.1）。但发布匹配有新问题，见 **N3** |
| D16 | ✅ | locate 只返回 locationId 加 layoutVersion |
| D17 | ⚠️ 部分修复 → **N2** | 取消 since 是对的，但新的 ETag 定义 `max(stock_movements.id)` 又引入了提交顺序问题 |
| D18 | ✅ | 实体登记表加 advisory lock，载荷带前缀 |
| D19 | ✅ | 布局文档是唯一真相源 |
| D20–D23 | ✅ | |
| D24 | ⚠️ 部分修复 → **N7** | 10 秒安全窗口小于长事务时长（CSV 单事务 5 万行） |
| D25 | ✅ | |
| D26 | ✅ 部分采纳，**接受** | |
| D27 / D28 / D29 | ✅（D29 的换班场景见 N6） | |
| D30 | ✅（路径不一致的残留见 N18） | |
| D31–D36 | ✅ | |
| D37 | ✅ 部分采纳，**有条件接受** | 条件：部署检查清单里“异地拷贝”必须是上线签收的阻断项，不能只是看板告警 |
| D38 / D39 / D40 / D41 / D42 | ✅ | |
| D43 / D44 / D46 | ✅ | |
| D45 | ⚠️ 部分修复 → **N8、N9、N10** | 测试模板库共用一个名字、`--frozen-lockfile` 与“WS 新增依赖”冲突、merge-queue 和 contract-requests 落在 Lead 独占的 docs/** 里 |
| D47 | ✅ 已在 npm 核实 | |
| D48 / D49 / D50 | ✅（D48 的残留见 N17） | |

---

## 第二部分：新问题（v2 引入的，以及 R1 漏掉的）

1. **N1 · BLOCKER** · 02 §2“编号方向”+ 02 §3.1“bay = bayStart + 2i”+ ADR-0008 —— **右侧货架的巷道 bay 方向是反的**
   问题：02 §2 规定“面对取货面，bay 从左到右递增”，02 §3.1 规定货架第 i 列的 bay 为 `bayStart + 2i`（i 也按面对取货面从左到右计）。设操作员沿巷道方向 d 行走：
   - 转向**左侧**货架时，他的右手指向 +d，所以左侧 bay 沿 d 递增，正确。
   - 转向**右侧**货架时，右手指向 −d，所以右侧每个货架内部的 bay 是逆着 d 递增的。
   阵列复制时 bayStart 又是沿 d 递增的，结果右侧编码在行走方向上呈锯齿：8,6,4,2 | 16,14,12,10。bay 1 的对面不是 bay 2，而是 bay 8，ADR-0008 说的“按编码排序即行走顺序”也不成立。这条规则会被 M0b 的 `geometry-golden.json` 和标签固化，冻结后再改，所有已打印标签都要作废。
   修复：把 bay 编号定义在**巷道轴**上，不按操作员朝向。
   - 每条巷道有方向（由 `aisle` 的起点端确定，例如 rotation 0 时沿 +X）。
   - 左侧 `bay = bayStart + 2i`，右侧 `bay = bayStart + 2·(bays−1−i)`，其中 i 是面对取货面从左到右的局部列序号。
   - `position` 仍按面对取货面从左到右，或同样改为巷道轴方向，二选一写明。
   - `validateLayout` 校验 `side` 与几何一致：L 货架的取货面中心必须位于巷道中线左侧。
   - 黄金样例加上“同一巷道左右两个货架：bay 1 与 bay 2 正对”的断言。

2. **N2 · MAJOR** · 03 §7 `ETag = hash(layoutVersion, max(stock_movements.id))`、06 §6 —— **occupancy 的 ETag 会把 3D 永久卡在旧库存**（D17 重开）
   问题：bigserial 的分配顺序不等于提交顺序。事务 T1 拿到 id=100 后，T2 拿到 id=101 并先提交；此时客户端拉到的 occupancy 不含 T1，ETag 记为 101。T1 随后提交，SSE 触发客户端重新拉取，max(id) 仍是 101，返回 304，客户端**一直显示旧库存**，直到下一笔交易。另外，停用仓位和 `PATCH max_qty` 会改变 occupancy 的着色或 fill，但不产生 movement，ETag 也不会变。同理，`/twin` 里包含 `effectiveMax`，ETag 如果只基于 layoutVersion，运行时属性一改就过期。
   修复：occupancy 的 ETag 改为**对响应内容求哈希**（5k 仓位三个数组算 xxhash 或 sha1，不到 1 ms），一次计算、可短时缓存。`/twin` 去掉 `effectiveMax`，移入 occupancy；或者让 `/twin` 的 ETag 同样包含运行时属性的 `max(locations.updated_at)` 并取内容哈希。必过清单加一项：“乱序提交后 occupancy 最终一致”。

3. **N3 · MAJOR** · 02 §9 step 3–5、02 §5 `locations unique(warehouse_id, code)` —— **删掉货架再在原位置画新货架，发布会因编码冲突失败**
   问题：稳定匹配只按 `(rack.layout_key, rack_bay_index, level, position)` 进行。设计器中最常见的操作是删除货架 r1、在原地画一个新货架（新 key），新货架生成相同的编码 `A03-01-A01`。旧仓位被**停用但没有删除**，它的 code 仍占着 `unique(warehouse_id, code)`，`barcode_registry` 里也还有旧载荷，于是发布在提交时触发唯一冲突（DEFERRABLE 只是把冲突推迟到提交时）。另外，`ON CONFLICT` 不能用 DEFERRABLE 唯一约束作仲裁，投影写入无法按 code 做 upsert。
   修复：匹配分两轮。第一轮按 layout_key 匹配；第二轮把未匹配的新仓位按 **code** 与现有的停用仓位或本次待停用仓位匹配，命中后复用其 `location.id` 并改绑到新 rack，库存和历史连续，标签也不需要补打。按 id 写投影，不依赖 ON CONFLICT。停用仓位的载荷从 `barcode_registry` 中删除（或标记释放）。补一条集成测试：“删货架后原地重画，发布成功，且 id 复用”。

4. **N4 · MAJOR** · 02 §8 step 4、03 §4.2 —— **盘点关闭的原子性没有写明，“行级部分成功”不闭环**（D5 重开）
   问题：(a) CAS 把状态置为 CLOSED，再“调用 postTransaction”。如果两者不在同一事务里，进程在中间崩溃，任务会停在 CLOSED 且 `closed_txn_id` 为 NULL，重试时只会返回“已关闭”，调整永远不会生成。(b) 负 delta 行余额不足时标记 `needs_review`，跳过扣减，整单其余照常关闭；但任务已经 CLOSED，这些行之后没有任何流程处理，账实差异被悄悄保留。(c) 这种“部分成功”破坏了 postTransaction“整单原子”的语义，需要单独的代码路径，却没有设计。
   修复：CAS、写入 COUNT_ADJUST、回写 `closed_txn_id` 必须在**同一事务**里完成，写进 02 §8。去掉部分成功：close 时只要有任何一行会扣成负数，就整单失败，任务留在 REVIEW，这些行标记 `needs_review` 并返回给前端重盘；或者自动为这些仓位生成跟进盘点任务，并在原任务上记录关联。二选一，推荐前者，更简单也更可测。

5. **N5 · MAJOR** · 03 §3.1、04 §3.1、§5 —— **`WAITING_STOCK` 对在线操作也生效，会掩盖扫错仓位等人为错误**
   问题：处理矩阵对**所有** 422 `INSUFFICIENT_STOCK` 都静默重试 24 小时。在线拣货扫错仓位（该仓位本来就没有这个 SKU）时，作业员只看到灰勾，以为已经提交然后离开，打断式提示要到 24 小时后才出现。D6 的初衷只是处理**离线产生的跨设备乱序**。
   修复：只有离线时创建的单据（outbox 记录 `createdOffline=true`），或服务端提示“该仓位有其他设备的待同步入库”时，才进入 `WAITING_STOCK`。在线创建的单据收到 422 立即打断，提供“稍后自动重试”按钮，由作业员主动选择。组件测试和 e2e 覆盖这两条分支。

6. **N6 · MAJOR** · 04 §5、03 §5“performedBy 必须等于令牌用户”、ADR-0007 —— **换班场景走不通**
   问题：以下几条规则叠加：
   - 登出前 outbox 必须为空；
   - `WAITING_STOCK` 最长可达 24 小时；
   - `BLOCKED_AUTH` 只能由原操作员处理；
   - 服务端拒绝 performedBy 与令牌用户不一致的提交。
   结果是：平板交接班时，A 名下还有 WAITING_STOCK 或 BLOCKED_AUTH 的单据，A 无法登出，B 无法登录，或者只能由 MANAGER“强制清空”。强制清空会丢掉**实物已经发生**的入库或出库，账实不符。而共享终端轮班恰恰是仓库的常态。
   修复：增加服务端会话表 `device_sessions(device_id, user_id, started_at, ended_at)`。服务端接受 `performedBy ≠ 令牌用户` 的提交，条件是 `device_id` 一致，且 `client_created_at` 落在 performedBy 在该设备上的某个会话区间内（允许 ±5 分钟时钟偏差）。审计中分别记录 `performed_by` 和 `submitted_by`，这两个字段正好已经有了。允许 A 带着未同步单据登出，单据归属不变，由设备继续发送。必过清单加“换班代交”和“伪造 performedBy 被拒”两项。

7. **N7 · MAJOR** · 03 §5 `/sync/masterdata` 游标“−10s 安全窗口”、05 §3 CSV“单事务 upsert ≤ 5 万行” —— **主数据增量同步会漏掉长事务的变更**（D24 重开）
   问题：`updated_at = now()` 取的是事务开始时间。CSV 导入 5 万行在一个事务里，还要逐行写 `barcode_registry` 并持有 barcode-ns 锁，很容易超过 10 秒；布局发布也可能较慢。这些行提交时 `updated_at` 已经落在客户端游标窗口之外，就会被永久漏掉，最多要等每日 digest 比对才补回，最长 24 小时。
   修复：给 `wms_app` 设置 PG17 的 `transaction_timeout`（例如 30s，PG17 新增的 GUC），把安全窗口设为 `transaction_timeout + 30s`。CSV 导入改为每 1,000 行一个事务分批提交（预检仍做全量），布局发布控制在超时之内。或者改用每个变更行写一条 `masterdata_changes(seq bigserial)`，游标按 seq，客户端减去一个安全余量后幂等 upsert。

8. **N8 · MAJOR** · 09 §3、10 §6.2 —— **多个 WS 共用同名测试模板库 `wms_template`，会互相破坏**
   问题：所有 WS 共用一个 PG 实例和一个名为 `wms_template` 的模板库，但各 WS 分支上的迁移版本不同：WS-A 改了迁移，WS-C 的测试就会克隆到错误的 schema。PG 的 `CREATE DATABASE ... TEMPLATE` 要求模板库**没有其他会话连接**；某个 WS 正在重建模板时，其他 WS 克隆会报 “source database is being accessed by other users”，测试随机失败。
   修复：模板库按 WS 和迁移哈希命名：`wms_tpl_<ws>_<migrationsHash8>`。由 `scripts/test-db.sh` 在 `flock /tmp/wms3d-tpl-<ws>.lock` 下按需创建，并清理旧哈希的模板。克隆时只连 `postgres` 维护库。`wms_owner/wms_app` 是集群级角色，禁止任何 WS 在测试中执行 `ALTER ROLE`。

9. **N9 · MAJOR** · 10 §1“lockfile 只由 Lead 重建”与 §6.5 step 1“WS 执行 `pnpm install --frozen-lockfile`” —— **WS 无法引入新依赖**
   问题：WS 在自己的包里新增依赖后，lockfile 没有更新，`--frozen-lockfile` 直接失败，WS 在合并前既装不上也测不了新依赖。如果改成非 frozen 安装，各 worktree 会各自生成不同的 lockfile，合并时冲突。
   修复：允许 WS 在自己的 worktree 里执行 `pnpm install`（非 frozen）并把 lockfile 改动一起提交；Lead 合并时如有冲突，就以 main 的 lockfile 为基础重新执行 `pnpm install` 生成后提交。或者 M0b 一次性把预期依赖全部装好（01 §1 已经列全了版本），之后新增依赖走契约请求通道，由 Lead 当天合入 main，WS 再 rebase。推荐后者，更符合单 Lead 合并的模式。

10. **N10 · MINOR** · 10 §1、§6.5 —— `docs/contract-requests/*.md` 和 `docs/merge-queue.md` 都位于 Lead 独占的 `docs/**` 下，WS 分支修改它们会被 `check-ownership` 拒绝。如果 WS 直接写主仓的工作目录，多个 Agent 并发追加同一个文件也会互相覆盖。
    修复：合并队列放在 git 之外，例如 `/workspace/.wms3d-queue/<ts>-<ws>.json`，每个请求一个文件，天然无冲突；契约请求同样一个请求一个文件，并把 `docs/contract-requests/**` 列为所有 WS 都可写的例外路径。另外观察到，本轮评审时作者正直接在主仓 `/workspace/wms3d` 编写 M0a，有未提交文件，与 10 §6.1“主仓不开发”相矛盾。M0a 可以作为例外，但建议从 M0b 起严格执行。

11. **N11 · MAJOR** · 10 §3 M1 —— **WS-A 在 5 天内工作量过载，是隐藏的关键路径**
    问题：M1 只有一个 Agent，要完成认证（轮换和宽限窗口）、设备、仓库、模板库、布局发布（四类差异、改码、DEFERRABLE 处理，以及 N3 的两轮匹配）、SKU 和 CSV 导入、条码登记表、库存引擎、冲正、9 类查询、sync 和 digest、twin 和 occupancy、SSE、审计、夜间任务，还要让必过清单里 9 项竞态测试和 RBAC 全矩阵变绿。工作量明显多于 M3，却只排了 5 天。
    修复：把 WS-A 按 `apps/api/src/modules/*` 拆成 **WS-A1**（auth、users、devices、warehouses、layout、skus、labels 端点）和 **WS-A2**（inventory、counts 后端、sync、twin、events、audit、jobs）。`db/schema.ts` 和迁移归 Lead 所有，M0b 冻结后通过契约请求修改。端口和数据库按 n=8 继续分配。

12. **N12 · MINOR** · 02 §8 step 2 —— 离线盘点仍按服务端提交时刻的余额对账。如果作业员数完一个仓位后过了很久才提交，期间其他人的正常拣货会被算成盘盈。
    修复：当 `server_now − client_counted_at > 5 分钟` 时，自动将该行标记 `needs_review`。另外，“提交前本机 outbox 必须为空”改为“只阻塞涉及该仓位的待传单据”，避免一条处于 WAITING_STOCK 的单据（最长 24 小时）卡住整台设备的盘点。

13. **N13 · MINOR** · 03 §2 刷新宽限 —— 规定 60 秒内同设备重用旧 token 时“返回同一个新 token”，但 refresh_tokens 只存哈希，无法返回原 token 明文。
    修复：在 60 秒内以服务端密钥 AES-GCM 加密暂存子 token，过期后清除；或者签发一个兄弟 token（同 parent，标记 sibling），两者都有效。在 02 §5 的表中加上对应字段。

14. **N14 · MINOR** · 03 §3.1 —— 处理矩阵没有区分 403 `PASSWORD_CHANGE_REQUIRED`。管理员重置密码后，该作业员设备上的离线单据会被按“403 → REJECTED”打成异常单。
    修复：`PASSWORD_CHANGE_REQUIRED` 归入 `BLOCKED_AUTH`，即暂停发送，作业员改密后继续发送。

15. **N15 · MINOR** · 02 §6.4、03 错误码 `REVERSAL_NOT_ALLOWED` —— 冲正规则不完整：
    - REVERSAL 能否再被冲正？（建议禁止）
    - COUNT_ADJUST 能否冲正？（建议仅 MANAGER）
    - 原仓位已停用时怎么办？反向入库会遇到 LOCATION_INACTIVE，需要说明。
    - OPERATOR 撤销一条正处于 SENDING 的单据会产生竞态，应等待响应后改走 reverse。
    把以上写进 02 §6.4 并加上单测。

16. **N16 · MINOR** · 02 §3.2、§6.5、08 §4、08 §5.1 —— advisory lock 使用 `hashtext('barcode-ns')` 的单 key 形式，与迁移锁、夜间任务锁共用同一个 64 位键空间，存在碰撞风险。
    修复：统一用双 int 形式 `pg_advisory_xact_lock(<NS_CONST>, <id>)`，并在 `apps/api/src/db/locks.ts` 中集中定义常量。

17. **N17 · MINOR** · 01 §5 时序图 —— 参与者仍写着“离线队列(IndexedDB)”，与 ADR-0007 v2 的 SQLite 不一致；01 §2 组件图的标题仍是“服务器 (docker compose)”，而已验证的路径是 systemd。两处同步更新。

18. **N18 · MINOR** · 05 §2.1 立面视图 vs 03 §5 —— 05 写的是 `PATCH /locations/bulk`，03 写的是 `PATCH /warehouses/:id/locations/bulk`，统一为后者，作用域来自路径。另外，03 §1.1 的 dev CORS 写的是 `http://localhost:5173+n`，而 10 §6.3 的端口方案是 `4010/4020 + 100n`，改为“按 `.env.local` 端口生成”。prod 的 allowlist 应去掉 `http://localhost` 和 `capacitor://localhost`（后者是 iOS 用的，MVP 不需要）。

19. **N19 · MINOR** · 01 §1、03 §6 —— `@microsoft/fetch-event-source` 2.0.1 是 2021 年的版本，之后基本无人维护。它默认在页面隐藏时断开（`openWhenHidden=false`），而且只要服务端的 401 抛错，就需要自定义 `onerror` 才能阻止无限重试。
    修复：在 M0b 中写一个约 100 行的 `api-client/sse.ts`（fetch + ReadableStream + `eventsource-parser`），明确处理 401 刷新、exp 关流、退避和隐藏页策略，并补单测；或者保留这个库，但把上述配置写进契约。

---

### 冻结 M0b 前必须完成（最小集合）
- N1：bay 方向。会影响编码、黄金样例和标签。
- N2：occupancy 和 twin 的 ETag 定义。
- N3：发布的两轮匹配，以及停用后释放 code 和载荷。
- N4：盘点关闭的单事务处理，去掉部分成功。
- N5、N6：WAITING_STOCK 的适用范围；`device_sessions` 和代交规则。会改契约与 schema。
- N7：`transaction_timeout`、安全窗口、CSV 分批。
- N8、N9：测试模板库命名和依赖流程。会影响 M0a 已在写的脚本。

N10–N19 可以在 M0b 期间顺手修正。修完后，只需复核上述条目即可冻结 `contract-v1`。
