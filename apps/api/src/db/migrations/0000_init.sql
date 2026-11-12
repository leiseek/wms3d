CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid,
	"warehouse_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"result" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"device_id" varchar(64),
	"trace_id" varchar(64),
	CONSTRAINT "audit_logs_result_chk" CHECK ("audit_logs"."result" in ('SUCCESS','DENIED','FAILED'))
);
--> statement-breakpoint
CREATE TABLE "barcode_registry" (
	"value" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"warehouse_id" uuid,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "barcode_registry_kind_chk" CHECK ("barcode_registry"."kind" in ('SKU','LOCATION','RACK'))
);
--> statement-breakpoint
CREATE TABLE "count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"lot_no" varchar(32) DEFAULT '' NOT NULL,
	"snapshot_qty" integer,
	"system_qty_at_count" integer NOT NULL,
	"counted_qty" integer NOT NULL,
	"counted_by" uuid NOT NULL,
	"counted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_counted_at" timestamp with time zone,
	"submission_id" uuid,
	"needs_review" boolean DEFAULT false NOT NULL,
	CONSTRAINT "count_lines_cell_uq" UNIQUE("task_id","location_id","sku_id","lot_no")
);
--> statement-breakpoint
CREATE TABLE "count_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"scope" jsonb NOT NULL,
	"blind" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_txn_id" uuid,
	"closed_at" timestamp with time zone,
	CONSTRAINT "count_tasks_wh_code_uq" UNIQUE("warehouse_id","code"),
	CONSTRAINT "count_tasks_status_chk" CHECK ("count_tasks"."status" in ('OPEN','COUNTING','REVIEW','CLOSED','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(64),
	"model" varchar(64),
	"last_user_id" uuid,
	"last_seen_at" timestamp with time zone,
	"app_version" varchar(32),
	"pending_outbox" integer DEFAULT 0 NOT NULL,
	"pending_warehouse_id" uuid,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" varchar(80) NOT NULL,
	"user_id" uuid NOT NULL,
	"request_hash" char(64) NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "inv_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" varchar(80) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"reason" text,
	"ref_no" varchar(64),
	"note" text,
	"reverses_txn_id" uuid,
	"performed_by" uuid NOT NULL,
	"submitted_by" uuid NOT NULL,
	"performer_session_id" uuid,
	"device_id" varchar(64),
	"created_offline" boolean DEFAULT false NOT NULL,
	"client_created_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inv_txns_reverses_txn_id_unique" UNIQUE("reverses_txn_id"),
	CONSTRAINT "inv_txns_wh_key_uq" UNIQUE("warehouse_id","idempotency_key"),
	CONSTRAINT "inv_txns_type_chk" CHECK ("inv_txns"."type" in ('INBOUND','OUTBOUND','TRANSFER','ADJUST','COUNT_ADJUST','REVERSAL'))
);
--> statement-breakpoint
CREATE TABLE "label_reprint_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "label_reprint_kind_chk" CHECK ("label_reprint_requests"."kind" in ('LOCATION','RACK','SKU')),
	CONSTRAINT "label_reprint_status_chk" CHECK ("label_reprint_requests"."status" in ('PENDING','DONE','CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "layout_versions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"version" integer,
	"status" text NOT NULL,
	"doc" jsonb NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	"based_on_version" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	CONSTRAINT "layout_versions_wh_version_uq" UNIQUE("warehouse_id","version"),
	CONSTRAINT "layout_versions_status_chk" CHECK ("layout_versions"."status" in ('DRAFT','PUBLISHED','ARCHIVED'))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"rack_id" uuid,
	"code" varchar(32) NOT NULL,
	"bay" integer,
	"level" integer,
	"position" integer,
	"rack_bay_index" integer,
	"kind" text NOT NULL,
	"pick_seq" integer DEFAULT 0 NOT NULL,
	"max_qty" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_id_wh_uq" UNIQUE("id","warehouse_id"),
	CONSTRAINT "locations_rack_cell_uq" UNIQUE("rack_id","rack_bay_index","level","position"),
	CONSTRAINT "locations_kind_chk" CHECK ("locations"."kind" in ('STORAGE','RECEIVING','SHIPPING','QC'))
);
--> statement-breakpoint
CREATE TABLE "masterdata_tombstones" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops_status" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rack_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(32) NOT NULL,
	"name" varchar(64),
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rack_types_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "racks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"zone_id" uuid NOT NULL,
	"layout_key" varchar(32) NOT NULL,
	"code" varchar(16) NOT NULL,
	"aisle" integer NOT NULL,
	"side" char(1) NOT NULL,
	"rack_no" integer NOT NULL,
	"bay_start" integer NOT NULL,
	"rack_type" jsonb NOT NULL,
	"pos_x" numeric(9, 3) NOT NULL,
	"pos_z" numeric(9, 3) NOT NULL,
	"rotation_deg" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"layout_version" integer NOT NULL,
	CONSTRAINT "racks_wh_code_uq" UNIQUE("warehouse_id","code"),
	CONSTRAINT "racks_wh_key_uq" UNIQUE("warehouse_id","layout_key"),
	CONSTRAINT "racks_side_chk" CHECK ("racks"."side" in ('L','R'))
);
--> statement-breakpoint
CREATE TABLE "reconcile_checkpoints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"max_movement_id" bigint NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mismatches" integer NOT NULL,
	"full_run" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"session_id" uuid,
	"family_id" uuid NOT NULL,
	"token_hash" char(64) NOT NULL,
	"parent_id" uuid,
	"replaced_by" uuid,
	"replaced_at" timestamp with time zone,
	"sibling_of" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sku_barcodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku_id" uuid NOT NULL,
	"barcode" varchar(64) NOT NULL,
	"pack_qty" integer DEFAULT 1 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_barcodes_barcode_unique" UNIQUE("barcode"),
	CONSTRAINT "sku_barcodes_pack_chk" CHECK ("sku_barcodes"."pack_qty" >= 1)
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"spec" varchar(128),
	"uom" varchar(8) DEFAULT 'EA' NOT NULL,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"weight_g" integer,
	"safety_stock" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"lot_no" varchar(32) DEFAULT '' NOT NULL,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_location_id_sku_id_lot_no_pk" PRIMARY KEY("location_id","sku_id","lot_no"),
	CONSTRAINT "stock_balances_onhand_chk" CHECK ("stock_balances"."on_hand" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"txn_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"lot_no" varchar(32) DEFAULT '' NOT NULL,
	"qty_delta" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_delta_chk" CHECK ("stock_movements"."qty_delta" <> 0),
	CONSTRAINT "stock_movements_after_chk" CHECK ("stock_movements"."balance_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_warehouses" (
	"user_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"role_override" text,
	CONSTRAINT "user_warehouses_user_id_warehouse_id_pk" PRIMARY KEY("user_id","warehouse_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" "citext" NOT NULL,
	"display_name" varchar(64) NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"all_warehouses" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_role_chk" CHECK ("users"."role" in ('ADMIN','MANAGER','OPERATOR','VIEWER'))
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(4) NOT NULL,
	"name" varchar(64) NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"width_m" numeric(9, 3) NOT NULL,
	"depth_m" numeric(9, 3) NOT NULL,
	"height_m" numeric(9, 3) NOT NULL,
	"location_code_pattern" text DEFAULT '{Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2}' NOT NULL,
	"barcode_prefix_enabled" boolean DEFAULT true NOT NULL,
	"allow_mixed_sku" boolean DEFAULT true NOT NULL,
	"published_layout_version" integer,
	"lock_seq" integer GENERATED ALWAYS AS IDENTITY (sequence name "warehouses_lock_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "warehouses_code_unique" UNIQUE("code"),
	CONSTRAINT "warehouses_id_code_uq" UNIQUE("id","code"),
	CONSTRAINT "warehouses_code_chk" CHECK ("warehouses"."code" ~ '^[A-Z0-9]{2,4}$')
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"layout_version" integer NOT NULL,
	"code" varchar(4) NOT NULL,
	"name" varchar(64),
	"kind" text NOT NULL,
	"polygon" jsonb NOT NULL,
	"color" varchar(7),
	CONSTRAINT "zones_wh_code_uq" UNIQUE("warehouse_id","code"),
	CONSTRAINT "zones_kind_chk" CHECK ("zones"."kind" in ('STORAGE','RECEIVING','SHIPPING','QC'))
);
--> statement-breakpoint
ALTER TABLE "barcode_registry" ADD CONSTRAINT "barcode_registry_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_task_id_count_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."count_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_lines" ADD CONSTRAINT "count_lines_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_tasks" ADD CONSTRAINT "count_tasks_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_tasks" ADD CONSTRAINT "count_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "count_tasks" ADD CONSTRAINT "count_tasks_closed_txn_id_inv_txns_id_fk" FOREIGN KEY ("closed_txn_id") REFERENCES "public"."inv_txns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_last_user_id_users_id_fk" FOREIGN KEY ("last_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_pending_warehouse_id_warehouses_id_fk" FOREIGN KEY ("pending_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_txns" ADD CONSTRAINT "inv_txns_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_txns" ADD CONSTRAINT "inv_txns_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_txns" ADD CONSTRAINT "inv_txns_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inv_txns" ADD CONSTRAINT "inv_txns_performer_session_id_device_sessions_id_fk" FOREIGN KEY ("performer_session_id") REFERENCES "public"."device_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_reprint_requests" ADD CONSTRAINT "label_reprint_requests_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_reprint_requests" ADD CONSTRAINT "label_reprint_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layout_versions" ADD CONSTRAINT "layout_versions_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layout_versions" ADD CONSTRAINT "layout_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layout_versions" ADD CONSTRAINT "layout_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_rack_id_racks_id_fk" FOREIGN KEY ("rack_id") REFERENCES "public"."racks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "racks" ADD CONSTRAINT "racks_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "racks" ADD CONSTRAINT "racks_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_device_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."device_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_barcodes" ADD CONSTRAINT "sku_barcodes_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_loc_wh_fk" FOREIGN KEY ("location_id","warehouse_id") REFERENCES "public"."locations"("id","warehouse_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_txn_id_inv_txns_id_fk" FOREIGN KEY ("txn_id") REFERENCES "public"."inv_txns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_sku_id_skus_id_fk" FOREIGN KEY ("sku_id") REFERENCES "public"."skus"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_loc_wh_fk" FOREIGN KEY ("location_id","warehouse_id") REFERENCES "public"."locations"("id","warehouse_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_warehouses" ADD CONSTRAINT "user_warehouses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_warehouses" ADD CONSTRAINT "user_warehouses_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_wh_id_idx" ON "audit_logs" USING btree ("warehouse_id","id");--> statement-breakpoint
CREATE INDEX "device_sessions_device_idx" ON "device_sessions" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE INDEX "inv_txns_wh_created_idx" ON "inv_txns" USING btree ("warehouse_id","created_at");--> statement-breakpoint
CREATE INDEX "label_reprint_wh_status_idx" ON "label_reprint_requests" USING btree ("warehouse_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "layout_versions_one_draft" ON "layout_versions" USING btree ("warehouse_id") WHERE "layout_versions"."status" = 'DRAFT';--> statement-breakpoint
CREATE INDEX "locations_wh_updated_idx" ON "locations" USING btree ("warehouse_id","updated_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "sku_barcodes_updated_idx" ON "sku_barcodes" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "skus_updated_idx" ON "skus" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "stock_balances_wh_sku_idx" ON "stock_balances" USING btree ("warehouse_id","sku_id");--> statement-breakpoint
CREATE INDEX "stock_movements_txn_idx" ON "stock_movements" USING btree ("txn_id");--> statement-breakpoint
CREATE INDEX "stock_movements_key_idx" ON "stock_movements" USING btree ("location_id","sku_id","lot_no","id");