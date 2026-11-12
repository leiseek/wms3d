# ADR-0003 · 库存：不可变流水台账 + 物化余额 + 幂等键
- 状态：已接受（v1）

## 决策
- `stock_movements` 只追加（触发器禁止改删），`stock_balances` 物化余额与流水**同事务**更新；movement 记录 `balance_after`，形成三重冗余以便对账。
- 余额更新用单语句原子操作：出库 `UPDATE ... WHERE on_hand >= q`，入库 `INSERT ... ON CONFLICT DO UPDATE`；多行按键排序加锁防死锁；`CHECK (on_hand >= 0)` 兜底。
- 幂等：`inv_txns.idempotency_key` 唯一索引是**保证**；`request_hash` 区分合法重放（200 返回原结果）与键复用（409）。应用层预查只是快速路径。
- 不用"SUM(流水) 即余额"：无法加锁、O(n)。不用 SERIALIZABLE：原子语句在 READ COMMITTED 下已足够且无需重试风暴。

## 依据
- 行业实践：ledger + balance、补偿交易代替修改、唯一索引保证幂等、夜间对账（参见 docs/sources.md [L1][L2][L3]）。
