-- 全量对账（08 §6 恢复演练 / 02 台账不变量）。只读；输出一行 JSON。psql -v ON_ERROR_STOP=1 -qAt -f reconcile.sql
-- 不变量：
--   ledger_mismatch    每个 (location, sku, lot) 台账 Σqty_delta = stock_balances.on_hand（缺任一侧视为 0）
--   last_after_mismatch 每个键最新一条 movement 的 balance_after = on_hand
--   negative_balance   on_hand < 0（有 CHECK，兜底）
--   inactive_with_stock 停用仓位上仍有库存（09 §2 #5）
--   txn_without_lines  没有任何 movement 的库存交易
--   wh_mismatch        movement 与所属交易的 warehouse_id 不一致
WITH led AS (
  SELECT location_id, sku_id, lot_no, SUM(qty_delta)::bigint AS q FROM stock_movements GROUP BY 1, 2, 3
), bal AS (
  SELECT location_id, sku_id, lot_no, on_hand::bigint AS q FROM stock_balances
), diff AS (
  SELECT COALESCE(l.location_id, b.location_id) AS location_id, COALESCE(l.sku_id, b.sku_id) AS sku_id,
         COALESCE(l.lot_no, b.lot_no) AS lot_no, COALESCE(l.q, 0) AS ledger, COALESCE(b.q, 0) AS balance
  FROM led l FULL OUTER JOIN bal b USING (location_id, sku_id, lot_no)
  WHERE COALESCE(l.q, 0) <> COALESCE(b.q, 0)
), last_mv AS (
  SELECT DISTINCT ON (location_id, sku_id, lot_no) location_id, sku_id, lot_no, balance_after
  FROM stock_movements ORDER BY location_id, sku_id, lot_no, id DESC
)
SELECT json_build_object(
  'database', current_database(),
  'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'counts', json_build_object(
    'txns', (SELECT COUNT(*) FROM inv_txns),
    'movements', (SELECT COUNT(*) FROM stock_movements),
    'balances', (SELECT COUNT(*) FROM stock_balances),
    'onHandTotal', (SELECT COALESCE(SUM(on_hand), 0) FROM stock_balances),
    'locations', (SELECT COUNT(*) FROM locations),
    'skus', (SELECT COUNT(*) FROM skus),
    'auditLogs', (SELECT COUNT(*) FROM audit_logs)
  ),
  'checks', json_build_object(
    'ledger_mismatch', (SELECT COUNT(*) FROM diff),
    'last_after_mismatch', (SELECT COUNT(*) FROM last_mv m JOIN stock_balances b USING (location_id, sku_id, lot_no) WHERE m.balance_after <> b.on_hand),
    'negative_balance', (SELECT COUNT(*) FROM stock_balances WHERE on_hand < 0),
    'inactive_with_stock', (SELECT COUNT(*) FROM stock_balances b JOIN locations l ON l.id = b.location_id WHERE b.on_hand > 0 AND NOT l.is_active),
    'txn_without_lines', (SELECT COUNT(*) FROM inv_txns t WHERE NOT EXISTS (SELECT 1 FROM stock_movements m WHERE m.txn_id = t.id)),
    'wh_mismatch', (SELECT COUNT(*) FROM stock_movements m JOIN inv_txns t ON t.id = m.txn_id WHERE m.warehouse_id <> t.warehouse_id)
  ),
  'sample', (SELECT COALESCE(json_agg(d), '[]'::json) FROM (SELECT * FROM diff LIMIT 5) d)
);
