-- 0001：Drizzle 无法表达的约束（02 §5、§5.1）。以 wms_owner 运行。
-- 1) code 列一律 COLLATE "C"（D22）
ALTER TABLE warehouses ALTER COLUMN code TYPE varchar(4) COLLATE "C";
--> statement-breakpoint
ALTER TABLE zones ALTER COLUMN code TYPE varchar(4) COLLATE "C";
--> statement-breakpoint
ALTER TABLE racks ALTER COLUMN code TYPE varchar(16) COLLATE "C";
--> statement-breakpoint
ALTER TABLE locations ALTER COLUMN code TYPE varchar(32) COLLATE "C";
--> statement-breakpoint
ALTER TABLE skus ALTER COLUMN code TYPE varchar(64) COLLATE "C";
--> statement-breakpoint
ALTER TABLE sku_barcodes ALTER COLUMN barcode TYPE varchar(64) COLLATE "C";
--> statement-breakpoint
ALTER TABLE barcode_registry ALTER COLUMN value TYPE text COLLATE "C";
--> statement-breakpoint
ALTER TABLE count_tasks ALTER COLUMN code TYPE varchar(32) COLLATE "C";
--> statement-breakpoint
-- 2) 改码互换：仓位编码唯一约束延迟到提交时检查（D15）。注意：DEFERRABLE 约束不能作 ON CONFLICT 仲裁（B-N3）
ALTER TABLE locations ADD CONSTRAINT locations_wh_code_uq UNIQUE (warehouse_id, code) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- 3) 盘点差异生成列
ALTER TABLE count_lines ADD COLUMN variance integer GENERATED ALWAYS AS (counted_qty - system_qty_at_count) STORED;
--> statement-breakpoint
-- 4) updated_at 触发器
CREATE OR REPLACE FUNCTION wms_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION wms_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER warehouses_touch BEFORE UPDATE ON warehouses FOR EACH ROW EXECUTE FUNCTION wms_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER rack_types_touch BEFORE UPDATE ON rack_types FOR EACH ROW EXECUTE FUNCTION wms_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER locations_touch BEFORE UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION wms_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER skus_touch BEFORE UPDATE ON skus FOR EACH ROW EXECUTE FUNCTION wms_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER sku_barcodes_touch BEFORE UPDATE ON sku_barcodes FOR EACH ROW EXECUTE FUNCTION wms_touch_updated_at();
--> statement-breakpoint
-- 5) 台账/交易/审计只追加（D11）：行级 UPDATE/DELETE + 语句级 TRUNCATE
CREATE OR REPLACE FUNCTION wms_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (%)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
CREATE TRIGGER inv_txns_append_only BEFORE UPDATE OR DELETE ON inv_txns FOR EACH ROW EXECUTE FUNCTION wms_append_only();
--> statement-breakpoint
CREATE TRIGGER inv_txns_no_truncate BEFORE TRUNCATE ON inv_txns FOR EACH STATEMENT EXECUTE FUNCTION wms_append_only();
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION wms_append_only();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements FOR EACH STATEMENT EXECUTE FUNCTION wms_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION wms_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION wms_append_only();
--> statement-breakpoint
-- 6) 只读视图（02 §5）
CREATE VIEW v_sku_stock AS
  SELECT sku_id, warehouse_id, SUM(on_hand)::int AS on_hand_total, COUNT(*) FILTER (WHERE on_hand > 0)::int AS location_count
  FROM stock_balances GROUP BY sku_id, warehouse_id;
--> statement-breakpoint
CREATE VIEW v_location_occupancy AS
  SELECT l.id AS location_id, l.warehouse_id,
         COUNT(b.sku_id) FILTER (WHERE b.on_hand > 0)::int AS sku_count,
         COALESCE(SUM(b.on_hand), 0)::int AS qty_total,
         l.max_qty AS max_qty
  FROM locations l LEFT JOIN stock_balances b ON b.location_id = l.id
  GROUP BY l.id;
--> statement-breakpoint
-- 7) 运行时角色 wms_app：非属主；台账三表仅 INSERT/SELECT（02 §5.1）
GRANT USAGE ON SCHEMA public TO wms_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wms_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wms_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON inv_txns, stock_movements, audit_logs FROM wms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO wms_app;
