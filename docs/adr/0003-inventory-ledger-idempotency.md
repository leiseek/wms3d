# ADR-0003 · 库存：不可变流水 + 物化余额 + 幂等键 + 全局锁顺序（v2）
- 状态：已接受 · v1 2026-11-11 · **v2 2026-11-12**（按 R1 D1/D2/D3/D4/D5/D7/D8/D9/D11 修订）

## 决策
1. **台账**：`stock_movements` 只追加（行级 UPDATE/DELETE 触发器 + 语句级 TRUNCATE 触发器），`wms_app` 运行时角色对其仅 INSERT/SELECT 且非属主；更正 = `REVERSAL` 交易（`reverses_txn_id unique`）。
2. **余额**：`stock_balances` 与流水同事务更新；扣减 `UPDATE ... WHERE on_hand >= q RETURNING`，增加 `INSERT ... ON CONFLICT DO UPDATE RETURNING`；`CHECK (on_hand >= 0)`；movement 记录 `balance_after`。
3. **幂等**（PG 正确写法）：`INSERT INTO inv_txns ... ON CONFLICT (warehouse_id, idempotency_key) DO NOTHING RETURNING id`。返回 0 行 → 同事务新语句 SELECT 已提交行（READ COMMITTED 下 ON CONFLICT 会先等待冲突事务结束），比对 `request_hash`（RFC 8785 JCS 规范化的**原始请求**）与 `performed_by/device_id`：一致 → 200 重放，`balancesAfter` 由 movements 重建；否则 409（不泄露）。**首请求 4xx 回滚则键不留痕，同键重放会重新执行**——这是移动端 `WAITING_STOCK` 同键重试的前提。不在事务中依赖捕获 23505（会使事务进入 aborted 状态）。
4. **全局锁顺序**：`locations`（id 升序，`FOR SHARE`；涉及容量/禁混放的入库或停用/发布/盘点提交用 `FOR UPDATE`）→ `stock_balances`（(location_id, sku_id, lot_no) 升序）。仓位级约束（is_active、容量、混放）在锁内校验；锁仓位查询带 `warehouse_id = $wh`（跨仓 IDOR 防护），并有复合外键 `(location_id, warehouse_id)` 兜底。
5. **计划纯函数**：`planMovements` 展开 TRANSFER、同键合并、排序；每命令 ≤ 200 行。
6. **非库存写入**：状态 CAS（盘点关闭、布局发布）+ `idempotency_keys` 通用表；盘点提交天然幂等（整体覆盖）。
7. 隔离级别 READ COMMITTED；死锁（40P01）兜底重试 1 次。

## 否决的方案
- `SUM(流水)` 即余额：无法加锁、O(n)。
- SERIALIZABLE：原子语句 + 锁顺序已足够，避免重试风暴。
- 在 `inv_txns` 存完整响应 JSON：冗余；以 `balance_after` 重建即可。

## 依据
sources [L1][L2][L3][L4]；PostgreSQL `INSERT ... ON CONFLICT` 文档语义。
