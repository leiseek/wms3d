/**
 * 数据库 schema（02 §5）。contract-v1 冻结后归 Lead 所有（apps/api/src/db/**），改动走契约请求。
 * Drizzle 不支持的部分（COLLATE "C"、DEFERRABLE、触发器、生成列、角色授权、citext）在 migrations/0001_constraints.sql。
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const meters = (name: string) => numeric(name, { precision: 9, scale: 3, mode: 'number' });

// ---------- 账号 ----------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: citext('username').notNull().unique(),
    displayName: varchar('display_name', { length: 64 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull(),
    allWarehouses: boolean('all_warehouses').notNull().default(false),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [check('users_role_chk', sql`${t.role} in ('ADMIN','MANAGER','OPERATOR','VIEWER')`)],
);

export const warehouses = pgTable(
  'warehouses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 4 }).notNull().unique(),
    name: varchar('name', { length: 64 }).notNull(),
    timezone: text('timezone').notNull().default('Asia/Shanghai'),
    widthM: meters('width_m').notNull(),
    depthM: meters('depth_m').notNull(),
    heightM: meters('height_m').notNull(),
    locationCodePattern: text('location_code_pattern')
      .notNull()
      .default('{Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2}'),
    barcodePrefixEnabled: boolean('barcode_prefix_enabled').notNull().default(true),
    allowMixedSku: boolean('allow_mixed_sku').notNull().default(true),
    publishedLayoutVersion: integer('published_layout_version'),
    /** advisory lock LAYOUT_PUBLISH 的 id（int4） */
    lockSeq: integer('lock_seq').generatedAlwaysAsIdentity().notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('warehouses_id_code_uq').on(t.id, t.code),
    check('warehouses_code_chk', sql`${t.code} ~ '^[A-Z0-9]{2,4}$'`),
  ],
);

export const userWarehouses = pgTable(
  'user_warehouses',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id, { onDelete: 'cascade' }),
    roleOverride: text('role_override'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.warehouseId] })],
);

export const devices = pgTable('devices', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 64 }),
  model: varchar('model', { length: 64 }),
  lastUserId: uuid('last_user_id').references(() => users.id),
  lastSeenAt: ts('last_seen_at'),
  appVersion: varchar('app_version', { length: 32 }),
  pendingOutbox: integer('pending_outbox').notNull().default(0),
  pendingWarehouseId: uuid('pending_warehouse_id').references(() => warehouses.id),
  disabledAt: ts('disabled_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const deviceSessions = pgTable(
  'device_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: varchar('device_id', { length: 64 })
      .notNull()
      .references(() => devices.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    startedAt: ts('started_at').notNull().defaultNow(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('device_sessions_device_idx').on(t.deviceId, t.startedAt)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    deviceId: varchar('device_id', { length: 64 }).notNull(),
    sessionId: uuid('session_id').references(() => deviceSessions.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    parentId: uuid('parent_id'),
    replacedBy: uuid('replaced_by'),
    replacedAt: ts('replaced_at'),
    siblingOf: uuid('sibling_of'),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('refresh_tokens_family_idx').on(t.familyId)],
);

// ---------- 布局 ----------
export const layoutVersions = pgTable(
  'layout_versions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    version: integer('version'),
    status: text('status').notNull(),
    doc: jsonb('doc').notNull(),
    rowVersion: integer('row_version').notNull().default(0),
    basedOnVersion: integer('based_on_version'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
    publishedBy: uuid('published_by').references(() => users.id),
  },
  (t) => [
    unique('layout_versions_wh_version_uq').on(t.warehouseId, t.version),
    uniqueIndex('layout_versions_one_draft')
      .on(t.warehouseId)
      .where(sql`${t.status} = 'DRAFT'`),
    check('layout_versions_status_chk', sql`${t.status} in ('DRAFT','PUBLISHED','ARCHIVED')`),
  ],
);

export const rackTypes = pgTable('rack_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 32 }).notNull().unique(),
  name: varchar('name', { length: 64 }),
  spec: jsonb('spec').notNull().$type<Record<string, unknown>>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const zones = pgTable(
  'zones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    layoutVersion: integer('layout_version').notNull(),
    code: varchar('code', { length: 4 }).notNull(),
    name: varchar('name', { length: 64 }),
    kind: text('kind').notNull(),
    polygon: jsonb('polygon').notNull(),
    color: varchar('color', { length: 7 }),
  },
  (t) => [
    unique('zones_wh_code_uq').on(t.warehouseId, t.code),
    check('zones_kind_chk', sql`${t.kind} in ('STORAGE','RECEIVING','SHIPPING','QC')`),
  ],
);

export const racks = pgTable(
  'racks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => zones.id),
    layoutKey: varchar('layout_key', { length: 32 }).notNull(),
    code: varchar('code', { length: 16 }).notNull(),
    aisle: integer('aisle').notNull(),
    side: char('side', { length: 1 }).notNull(),
    rackNo: integer('rack_no').notNull(),
    bayStart: integer('bay_start').notNull(),
    rackType: jsonb('rack_type').notNull(),
    posX: meters('pos_x').notNull(),
    posZ: meters('pos_z').notNull(),
    rotationDeg: integer('rotation_deg').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    layoutVersion: integer('layout_version').notNull(),
  },
  (t) => [
    unique('racks_wh_code_uq').on(t.warehouseId, t.code),
    unique('racks_wh_key_uq').on(t.warehouseId, t.layoutKey),
    check('racks_side_chk', sql`${t.side} in ('L','R')`),
  ],
);

/** unique(warehouse_id, code) 为 DEFERRABLE INITIALLY DEFERRED，见 0001_constraints.sql（D15）。 */
export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    zoneId: uuid('zone_id')
      .notNull()
      .references(() => zones.id),
    rackId: uuid('rack_id').references(() => racks.id),
    code: varchar('code', { length: 32 }).notNull(),
    bay: integer('bay'),
    level: integer('level'),
    position: integer('position'),
    rackBayIndex: integer('rack_bay_index'),
    kind: text('kind').notNull(),
    pickSeq: integer('pick_seq').notNull().default(0),
    maxQty: integer('max_qty'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('locations_id_wh_uq').on(t.id, t.warehouseId),
    unique('locations_rack_cell_uq').on(t.rackId, t.rackBayIndex, t.level, t.position),
    index('locations_wh_updated_idx').on(t.warehouseId, t.updatedAt),
    check('locations_kind_chk', sql`${t.kind} in ('STORAGE','RECEIVING','SHIPPING','QC')`),
  ],
);

// ---------- 主数据（组织级） ----------
export const skus = pgTable(
  'skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: varchar('code', { length: 64 }).notNull().unique(),
    name: varchar('name', { length: 128 }).notNull(),
    spec: varchar('spec', { length: 128 }),
    uom: varchar('uom', { length: 8 }).notNull().default('EA'),
    lengthMm: integer('length_mm'),
    widthMm: integer('width_mm'),
    heightMm: integer('height_mm'),
    weightG: integer('weight_g'),
    safetyStock: integer('safety_stock').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    imageUrl: text('image_url'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('skus_updated_idx').on(t.updatedAt)],
);

export const skuBarcodes = pgTable(
  'sku_barcodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id, { onDelete: 'cascade' }),
    barcode: varchar('barcode', { length: 64 }).notNull().unique(),
    packQty: integer('pack_qty').notNull().default(1),
    isPrimary: boolean('is_primary').notNull().default(false),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('sku_barcodes_pack_chk', sql`${t.packQty} >= 1`),
    index('sku_barcodes_updated_idx').on(t.updatedAt),
  ],
);

export const masterdataTombstones = pgTable('masterdata_tombstones', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id').notNull(),
  warehouseId: uuid('warehouse_id'),
  deletedAt: ts('deleted_at').notNull().defaultNow(),
});

export const barcodeRegistry = pgTable(
  'barcode_registry',
  {
    value: text('value').primaryKey(),
    kind: text('kind').notNull(),
    warehouseId: uuid('warehouse_id').references(() => warehouses.id),
    entityId: uuid('entity_id').notNull(),
  },
  (t) => [check('barcode_registry_kind_chk', sql`${t.kind} in ('SKU','LOCATION','RACK')`)],
);

// ---------- 库存（ADR-0003） ----------
export const invTxns = pgTable(
  'inv_txns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    type: text('type').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 80 }).notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    reason: text('reason'),
    refNo: varchar('ref_no', { length: 64 }),
    note: text('note'),
    reversesTxnId: uuid('reverses_txn_id').unique(),
    performedBy: uuid('performed_by')
      .notNull()
      .references(() => users.id),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    performerSessionId: uuid('performer_session_id').references(() => deviceSessions.id),
    deviceId: varchar('device_id', { length: 64 }),
    createdOffline: boolean('created_offline').notNull().default(false),
    clientCreatedAt: ts('client_created_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('inv_txns_wh_key_uq').on(t.warehouseId, t.idempotencyKey),
    index('inv_txns_wh_created_idx').on(t.warehouseId, t.createdAt),
    check(
      'inv_txns_type_chk',
      sql`${t.type} in ('INBOUND','OUTBOUND','TRANSFER','ADJUST','COUNT_ADJUST','REVERSAL')`,
    ),
  ],
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    txnId: uuid('txn_id')
      .notNull()
      .references(() => invTxns.id),
    warehouseId: uuid('warehouse_id').notNull(),
    locationId: uuid('location_id').notNull(),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id),
    lotNo: varchar('lot_no', { length: 32 }).notNull().default(''),
    qtyDelta: integer('qty_delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'stock_movements_loc_wh_fk',
      columns: [t.locationId, t.warehouseId],
      foreignColumns: [locations.id, locations.warehouseId],
    }),
    check('stock_movements_delta_chk', sql`${t.qtyDelta} <> 0`),
    check('stock_movements_after_chk', sql`${t.balanceAfter} >= 0`),
    index('stock_movements_txn_idx').on(t.txnId),
    index('stock_movements_key_idx').on(t.locationId, t.skuId, t.lotNo, t.id),
  ],
);

export const stockBalances = pgTable(
  'stock_balances',
  {
    warehouseId: uuid('warehouse_id').notNull(),
    locationId: uuid('location_id').notNull(),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id),
    lotNo: varchar('lot_no', { length: 32 }).notNull().default(''),
    onHand: integer('on_hand').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.locationId, t.skuId, t.lotNo] }),
    foreignKey({
      name: 'stock_balances_loc_wh_fk',
      columns: [t.locationId, t.warehouseId],
      foreignColumns: [locations.id, locations.warehouseId],
    }),
    check('stock_balances_onhand_chk', sql`${t.onHand} >= 0`),
    index('stock_balances_wh_sku_idx').on(t.warehouseId, t.skuId),
  ],
);

export const reconcileCheckpoints = pgTable('reconcile_checkpoints', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  maxMovementId: bigint('max_movement_id', { mode: 'number' }).notNull(),
  ranAt: ts('ran_at').notNull().defaultNow(),
  mismatches: integer('mismatches').notNull(),
  fullRun: boolean('full_run').notNull(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: varchar('key', { length: 80 }).notNull(),
    userId: uuid('user_id').notNull(),
    requestHash: char('request_hash', { length: 64 }).notNull(),
    response: jsonb('response').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

// ---------- 盘点 ----------
export const countTasks = pgTable(
  'count_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    code: varchar('code', { length: 32 }).notNull(),
    scope: jsonb('scope').notNull(),
    blind: boolean('blind').notNull().default(true),
    status: text('status').notNull().default('OPEN'),
    note: text('note'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: ts('created_at').notNull().defaultNow(),
    closedTxnId: uuid('closed_txn_id').references(() => invTxns.id),
    closedAt: ts('closed_at'),
  },
  (t) => [
    unique('count_tasks_wh_code_uq').on(t.warehouseId, t.code),
    check(
      'count_tasks_status_chk',
      sql`${t.status} in ('OPEN','COUNTING','REVIEW','CLOSED','CANCELLED')`,
    ),
  ],
);

/** variance 为生成列（0001_constraints.sql）。 */
export const countLines = pgTable(
  'count_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => countTasks.id),
    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id),
    skuId: uuid('sku_id')
      .notNull()
      .references(() => skus.id),
    lotNo: varchar('lot_no', { length: 32 }).notNull().default(''),
    snapshotQty: integer('snapshot_qty'),
    systemQtyAtCount: integer('system_qty_at_count').notNull(),
    countedQty: integer('counted_qty').notNull(),
    countedBy: uuid('counted_by')
      .notNull()
      .references(() => users.id),
    countedAt: ts('counted_at').notNull().defaultNow(),
    clientCountedAt: ts('client_counted_at'),
    submissionId: uuid('submission_id'),
    needsReview: boolean('needs_review').notNull().default(false),
  },
  (t) => [unique('count_lines_cell_uq').on(t.taskId, t.locationId, t.skuId, t.lotNo)],
);

// ---------- 标签补打 ----------
export const labelReprintRequests = pgTable(
  'label_reprint_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseId: uuid('warehouse_id')
      .notNull()
      .references(() => warehouses.id),
    kind: text('kind').notNull(),
    entityId: uuid('entity_id').notNull(),
    reason: text('reason').notNull(),
    note: text('note'),
    status: text('status').notNull().default('PENDING'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    requestedAt: ts('requested_at').notNull().defaultNow(),
    doneAt: ts('done_at'),
  },
  (t) => [
    index('label_reprint_wh_status_idx').on(t.warehouseId, t.status),
    check('label_reprint_kind_chk', sql`${t.kind} in ('LOCATION','RACK','SKU')`),
    check('label_reprint_status_chk', sql`${t.status} in ('PENDING','DONE','CANCELLED')`),
  ],
);

// ---------- 审计 ----------
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: ts('at').notNull().defaultNow(),
    userId: uuid('user_id'),
    warehouseId: uuid('warehouse_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    result: text('result').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    deviceId: varchar('device_id', { length: 64 }),
    traceId: varchar('trace_id', { length: 64 }),
  },
  (t) => [
    index('audit_logs_wh_id_idx').on(t.warehouseId, t.id),
    check('audit_logs_result_chk', sql`${t.result} in ('SUCCESS','DENIED','FAILED')`),
  ],
);

// ---------- 运维状态（备份/任务心跳，看板读取） ----------
export const opsStatus = pgTable('ops_status', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
