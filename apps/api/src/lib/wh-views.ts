import type { Location, Warehouse, ZoneKind } from '@wms3d/contracts';
import { toPayload } from '@wms3d/domain';
import { iso, num, type Queryable } from './db.ts';

export interface WarehouseRow {
  id: string;
  code: string;
  name: string;
  timezone: string;
  width_m: string;
  depth_m: string;
  height_m: string;
  location_code_pattern: string;
  barcode_prefix_enabled: boolean;
  allow_mixed_sku: boolean;
  published_layout_version: number | null;
  lock_seq: number;
  locked: boolean;
  created_at: Date;
  updated_at: Date;
}
export const WAREHOUSE_SQL = `SELECT w.*, EXISTS (SELECT 1 FROM locations l WHERE l.warehouse_id = w.id) AS locked FROM warehouses w`;

export function warehouseView(w: WarehouseRow): Warehouse {
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    timezone: w.timezone,
    widthM: num(w.width_m),
    depthM: num(w.depth_m),
    heightM: num(w.height_m),
    locationCodePattern: w.location_code_pattern,
    locationCodePatternLocked: w.locked,
    barcodePrefixEnabled: w.barcode_prefix_enabled,
    allowMixedSku: w.allow_mixed_sku,
    publishedLayoutVersion: w.published_layout_version,
    createdAt: iso(w.created_at),
    updatedAt: iso(w.updated_at),
  };
}

export async function loadWarehouse(q: Queryable, id: string): Promise<WarehouseRow | null> {
  const r = await q.query<WarehouseRow>(`${WAREHOUSE_SQL} WHERE w.id = $1`, [id]);
  return r.rows[0] ?? null;
}

export interface LocationRow {
  id: string;
  warehouse_id: string;
  zone_id: string;
  rack_id: string | null;
  code: string;
  kind: ZoneKind;
  bay: number | null;
  level: number | null;
  position: number | null;
  rack_bay_index: number | null;
  pick_seq: number;
  max_qty: number | null;
  is_active: boolean;
  updated_at: Date;
  wh_code: string;
  prefix: boolean;
  effective_max: number | null;
}
export const LOCATION_SQL = `SELECT l.id, l.warehouse_id, l.zone_id, l.rack_id, l.code, l.kind, l.bay, l.level, l.position,
       l.rack_bay_index, l.pick_seq, l.max_qty, l.is_active, l.updated_at,
       w.code AS wh_code, w.barcode_prefix_enabled AS prefix,
       COALESCE(l.max_qty, NULLIF(r.rack_type->>'defaultMaxQty', '')::int) AS effective_max
  FROM locations l
  JOIN warehouses w ON w.id = l.warehouse_id
  LEFT JOIN racks r ON r.id = l.rack_id`;

export function locationView(l: LocationRow): Location {
  return {
    id: l.id,
    warehouseId: l.warehouse_id,
    zoneId: l.zone_id,
    rackId: l.rack_id,
    code: l.code,
    payload: toPayload(l.wh_code, l.code, l.prefix),
    kind: l.kind,
    bay: l.bay,
    level: l.level,
    position: l.position,
    rackBayIndex: l.rack_bay_index,
    pickSeq: l.pick_seq,
    maxQty: l.max_qty,
    effectiveMax: l.effective_max,
    isActive: l.is_active,
    updatedAt: iso(l.updated_at),
  };
}

export async function loadLocations(q: Queryable, ids: string[]): Promise<Location[]> {
  if (!ids.length) return [];
  const r = await q.query<LocationRow>(
    `${LOCATION_SQL} WHERE l.id = ANY($1::uuid[]) ORDER BY l.code`,
    [ids],
  );
  return r.rows.map(locationView);
}
