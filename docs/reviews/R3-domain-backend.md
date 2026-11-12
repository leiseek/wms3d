# R3 定向复核：领域与后端（设计 v2.1，commit 21ac495）

- 评审人：独立评审 SubAgent · 日期：2026-11-12（PT）
- 范围：只复核我重开的 R1 条目（D5、D6、D17、D24、D45，以及 D37 的接受条件）和 R2 的 B-N1…N19。核对对象是 v2.1 文档，以及 `scripts/test-db.sh`、`scripts/check-ownership.mjs` 两个脚本。
- **结论：APPROVE-WITH-NITS**，可以冻结 `contract-v1`。下面 4 条 MINOR 可以在 M0b 期间顺手修掉，不阻塞打 tag。

## 1. N1 验算（02 §2、§3.1、ADR-0008）

坐标约定：俯视时 +X 向右、+Z 向下；rotation 为俯视顺时针；货架局部 +x 是“面对取货面时的右手方向”。

**例：水平巷道 A03，行进方向 +X。** 每侧 2 个货架，每个 4 列，列宽按 2.7m 计（忽略立柱）。

左侧（L）货架，rotation 0，位于巷道北侧，取货面朝 +Z：
- 局部 +x = 世界 +X，`bay = bayStart + 2i`
- L1：起点 x=0，bayStart=1 → x≈1.35/4.05/6.75/9.45 处依次为 bay 1/3/5/7
- L2：起点 x=10.8，bayStart=9 → bay 9/11/13/15

右侧（R）货架，rotation 180，位于巷道南侧，取货面朝 −Z：
- 局部 +x = 世界 −X，局部原点在货架的 +X 端，`bay = bayStart + 2·(3 − i)`
- R1：原点 x=10.8，bayStart=2 → i=0..3 对应 x=9.45/6.75/4.05/1.35，bay 为 8/6/4/2
- R2：原点 x=21.6，bayStart=10 → bay 16/14/12/10

结果：
- **按 x 排序：** 左侧 1,3,…,15，右侧 2,4,…,16，两侧都沿 +X 单调递增。
- **隔巷道正对：** 在同一个 x 位置上依次是 1↔2、3↔4、…、15↔16，满足 bay 1 正对 bay 2。✅

**竖直巷道，行进方向 +Z：**
- rotation 90 的货架取货面朝 −X，位于巷道东侧，属于 L；局部 +x → +Z，bay 1/3/5/7 沿 +Z 排列。
- rotation 270 的货架位于巷道西侧，属于 R；局部 +x → −Z，原点在货架的 +Z 端，按公式得到 bay 2/4/6/8，同样沿 +Z 排列。✅

**其他检查：**
- three.js 的 `rotation.y = −deg` 与“俯视顺时针”一致：绕 Y 轴 +90° 会把 +X 转到 −Z，在俯视图上是逆时针，所以取负号是对的。
- 侧别推导（0/90 → L，180/270 → R）正确。
- 几何校验（水平巷道 `z_face(R) > z_face(L)`，竖直巷道 `x_face(L) > x_face(R)`）与上面的推导一致。

**N1 关闭。**

## 2. 逐条复核

| 条目 | 结论 | 依据 |
|---|---|---|
| D5 / N4 | ✅ | 02 §8 step 4：CAS、COUNT_ADJUST、`closed_txn_id` 在同一事务；任一行扣减不足就整单回滚，返回 `COUNT_RECOUNT_REQUIRED`；必过测试 14 |
| D6 / N5 | ✅ | 03 §3.1 的处理矩阵只对 `createdOffline` 的单据进入 WAITING_STOCK，在线单据立即打断；`inv_txns.created_offline` 已加 |
| D6 / N6 | ✅（附 nit 1） | `device_sessions` 表 + 02 §6.6 的代交条件 + 必过测试 15 |
| D17 / N2 | ✅ | occupancy ETag 改为内容哈希，`isActive/effectiveMax` 移入 occupancy，`/twin` 只用 layoutVersion，新增 `locations.changed`；必过测试 12 |
| D24 / N7 | ✅（附 nit 3） | `transaction_timeout` 30s（发布 120s）+ 同步窗口 180s + CSV 每 1000 行一个事务 |
| D37 | ✅ 条件满足 | 08 §6：异地拷贝已列为上线签收的阻断项 |
| D45 / N8 | ✅（附 nit 2） | `test-db.sh`：模板库按 `wms_tpl_<ws>_<hash>` 命名，flock 串行，IS_TEMPLATE，克隆时只连维护库 |
| D45 / N9 | ✅ | 依赖在 M0b 预装；check-ownership 拦截 WS 分支里的 `package.json` 和 lockfile 改动 |
| D45 / N10 | ✅ | 合并队列放在 git 之外；`docs/contract-requests/**` 列为共享可写；Lead 从 M0b 起使用自己的 worktree |
| N3 | ✅ | 02 §9：两轮匹配、按 id 写投影、释放停用仓位的载荷；必过测试 13 |
| N11 | ✅ | WS-A 拆为 A1/A2，check-ownership 中已有对应的目录表 |
| N12–N15、N17–N19 | ✅ | 已在对应章节落地 |
| N16 | ⚠️ 残留（nit 4） | |

## 3. 剩余 MINOR（不阻塞冻结）

1. **代交可伪造操作人时间窗**（02 §6.6）：B 只要把 `clientCreatedAt` 设成 A 过去在该设备上的某个会话时间，就能把交易记到 A 名下。
   建议：额外要求 `client_created_at < 当前令牌会话的 started_at + 5 分钟`，且时间在最近 72 小时内。两个字段（performed_by 和 submitted_by）都写进审计，并在 03 中写明单据的 `deviceId` 从哪里来（`X-Device-Id` 头或 JWT 的 `did`）。
2. **`test-db.sh` 吞掉迁移失败**：`db:migrate:url ... >/dev/null 2>&1; then :; fi` 会把迁移失败当成成功，空 schema 的模板库仍被标记 IS_TEMPLATE，并按该哈希一直缓存。
   建议：脚本存在但执行失败时，删除模板并 `exit 1`；只有脚本不存在时才跳过。
3. **`SET LOCAL transaction_timeout='120s'` 是否生效需要实测**：在已经开始的事务里修改这个 GUC，计时是否从事务开始算，需要实际验证。
   建议：在必过测试 17 中补一条“发布事务运行 60 秒不被终止”，M0b 在本机 PG 17.11 上跑一次确认。
4. **双 int advisory lock 的残留**：02 §9 发布流程的 step 1 仍是 `pg_advisory_xact_lock(hashtext('barcode-ns'))`，应改为 `(LOCK_NS.BARCODE, 0)`；02 §6.5 的 `pg_try_advisory_lock` 应写明 `(LOCK_NS.JOB, n)`。另外，10 §6.5 step 3 里的“若 WS 新增依赖，Lead 重建 lockfile”与 B-N9 的新规则冲突，删掉这句。
