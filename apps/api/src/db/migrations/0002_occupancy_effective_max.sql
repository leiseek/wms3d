CREATE OR REPLACE VIEW v_location_occupancy AS
  SELECT l.id AS location_id, l.warehouse_id,
         COUNT(b.sku_id) FILTER (WHERE b.on_hand > 0)::int AS sku_count,
         COALESCE(SUM(b.on_hand), 0)::int AS qty_total,
         COALESCE(l.max_qty, (r.rack_type->>'defaultMaxQty')::int) AS max_qty
  FROM locations l
  LEFT JOIN racks r ON r.id = l.rack_id
  LEFT JOIN stock_balances b ON b.location_id = l.id
  GROUP BY l.id, r.rack_type;
