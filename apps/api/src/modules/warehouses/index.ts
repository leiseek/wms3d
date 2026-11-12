import { routes } from '@wms3d/contracts';
import { compilePattern, PatternError } from '@wms3d/domain';
import { auditCtx, writeAudit } from '../../lib/audit.ts';
import { isUniqueViolation, num, poolOf, withTx } from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { lockBarcodes, rebuildWarehouseRegistry } from '../../lib/registry.ts';
import {
  WAREHOUSE_SQL,
  loadWarehouse,
  warehouseView,
  type WarehouseRow,
} from '../../lib/wh-views.ts';
import type { ApiModule } from '../types.ts';

function assertPattern(p: string): void {
  try {
    compilePattern(p);
  } catch (e) {
    if (e instanceof PatternError || e instanceof RangeError)
      throw new ApiError('VALIDATION_FAILED', e.message, {
        errors: [{ path: 'locationCodePattern', message: e.message }],
      });
    throw e;
  }
}

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ApiError('VALIDATION_FAILED', `未知时区 ${tz}`, {
      errors: [{ path: 'timezone', message: '不是有效的 IANA 时区' }],
    });
  }
}

/** warehouses 模块（03 §5）：仓库 CRUD（编码模式在已有仓位时锁定）、库区/货架只读投影。 */
export const warehousesModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.listWarehouses, async ({ auth }) => {
    const pool = poolOf(services);
    const all = auth.warehouseIds === 'all';
    const rows = await pool.query<WarehouseRow>(
      `${WAREHOUSE_SQL} WHERE $1::boolean OR w.id = ANY($2::uuid[]) ORDER BY w.code`,
      [all, all ? [] : auth.warehouseIds],
    );
    return { items: rows.rows.map(warehouseView) };
  });

  r.register(routes.createWarehouse, async ({ body, auth, req }) => {
    assertPattern(body.locationCodePattern);
    assertTimezone(body.timezone);
    const pool = poolOf(services);
    try {
      return await withTx(pool, async (c) => {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO warehouses (code, name, timezone, width_m, depth_m, height_m, location_code_pattern, barcode_prefix_enabled, allow_mixed_sku)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            body.code,
            body.name,
            body.timezone,
            body.widthM,
            body.depthM,
            body.heightM,
            body.locationCodePattern,
            body.barcodePrefixEnabled,
            body.allowMixedSku,
          ],
        );
        const id = ins.rows[0]!.id;
        if (auth.warehouseIds !== 'all')
          await c.query(`INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1,$2)`, [
            auth.userId,
            id,
          ]);
        const w = warehouseView((await loadWarehouse(c, id))!);
        await writeAudit(c, {
          ...auditCtx(req),
          warehouseId: id,
          action: 'warehouse.create',
          entity: 'warehouse',
          entityId: id,
          after: w,
        });
        return w;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError('CONFLICT', '仓库代码已存在');
      throw e;
    }
  });

  r.register(routes.getWarehouse, async ({ warehouseId }) => {
    const w = await loadWarehouse(poolOf(services), warehouseId!);
    if (!w) throw new ApiError('NOT_FOUND', '仓库不存在');
    return warehouseView(w);
  });

  r.register(routes.patchWarehouse, async ({ warehouseId, body, req }) => {
    const pool = poolOf(services);
    if (body.locationCodePattern !== undefined) assertPattern(body.locationCodePattern);
    if (body.timezone !== undefined) assertTimezone(body.timezone);
    return withTx(pool, async (c) => {
      // 前缀开关会重建登记表：先取条码锁，再锁仓库行（与发布相同的锁顺序）
      if (body.barcodePrefixEnabled !== undefined) await lockBarcodes(c);
      const cur = await c.query<WarehouseRow>(`${WAREHOUSE_SQL} WHERE w.id = $1 FOR UPDATE OF w`, [
        warehouseId,
      ]);
      const before = cur.rows[0];
      if (!before) throw new ApiError('NOT_FOUND', '仓库不存在');
      if (
        body.locationCodePattern !== undefined &&
        body.locationCodePattern !== before.location_code_pattern &&
        before.locked
      )
        throw new ApiError('CONFLICT', '仓库内已存在仓位，编码模式不可修改');
      await c.query(
        `UPDATE warehouses SET
           name = COALESCE($2, name), timezone = COALESCE($3, timezone),
           width_m = COALESCE($4, width_m), depth_m = COALESCE($5, depth_m), height_m = COALESCE($6, height_m),
           location_code_pattern = COALESCE($7, location_code_pattern),
           barcode_prefix_enabled = COALESCE($8, barcode_prefix_enabled),
           allow_mixed_sku = COALESCE($9, allow_mixed_sku)
         WHERE id = $1`,
        [
          warehouseId,
          body.name ?? null,
          body.timezone ?? null,
          body.widthM ?? null,
          body.depthM ?? null,
          body.heightM ?? null,
          body.locationCodePattern ?? null,
          body.barcodePrefixEnabled ?? null,
          body.allowMixedSku ?? null,
        ],
      );
      if (
        body.barcodePrefixEnabled !== undefined &&
        body.barcodePrefixEnabled !== before.barcode_prefix_enabled
      )
        await rebuildWarehouseRegistry(c, warehouseId!);
      const after = warehouseView((await loadWarehouse(c, warehouseId!))!);
      await writeAudit(c, {
        ...auditCtx(req),
        warehouseId,
        action: 'warehouse.update',
        entity: 'warehouse',
        entityId: warehouseId,
        before: warehouseView(before),
        after,
      });
      return after;
    });
  });

  r.register(routes.listZones, async ({ warehouseId }) => {
    const rows = await poolOf(services).query<{
      id: string;
      warehouse_id: string;
      layout_version: number;
      code: string;
      name: string | null;
      kind: 'STORAGE' | 'RECEIVING' | 'SHIPPING' | 'QC';
      polygon: [number, number][];
      color: string | null;
    }>(
      `SELECT z.* FROM zones z JOIN warehouses w ON w.id = z.warehouse_id
        WHERE z.warehouse_id = $1 AND z.layout_version = w.published_layout_version ORDER BY z.code`,
      [warehouseId],
    );
    return {
      items: rows.rows.map((z) => ({
        id: z.id,
        warehouseId: z.warehouse_id,
        layoutVersion: z.layout_version,
        code: z.code,
        name: z.name,
        kind: z.kind,
        polygon: z.polygon,
        color: z.color,
      })),
    };
  });

  r.register(routes.listRacks, async ({ warehouseId }) => {
    const rows = await poolOf(services).query<{
      id: string;
      warehouse_id: string;
      zone_id: string;
      layout_key: string;
      code: string;
      aisle: number;
      side: 'L' | 'R';
      rack_no: number;
      bay_start: number;
      rack_type: never;
      pos_x: string;
      pos_z: string;
      rotation_deg: 0 | 90 | 180 | 270;
      is_active: boolean;
      layout_version: number;
    }>(`SELECT * FROM racks WHERE warehouse_id = $1 AND is_active ORDER BY code`, [warehouseId]);
    return {
      items: rows.rows.map((k) => ({
        id: k.id,
        warehouseId: k.warehouse_id,
        zoneId: k.zone_id,
        layoutKey: k.layout_key,
        code: k.code,
        aisle: k.aisle,
        side: k.side,
        rackNo: k.rack_no,
        bayStart: k.bay_start,
        rackType: k.rack_type,
        x: num(k.pos_x),
        z: num(k.pos_z),
        rotationDeg: k.rotation_deg,
        isActive: k.is_active,
        layoutVersion: k.layout_version,
      })),
    };
  });
};
