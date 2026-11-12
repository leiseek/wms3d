import { routes, type ScanResolution } from '@wms3d/contracts';
import { classifyScan, scanLookupKeys } from '@wms3d/domain';
import { poolOf } from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { loadLocations } from '../../lib/wh-views.ts';
import { loadSku } from '../skus/service.ts';
import type { ApiModule } from '../types.ts';

/**
 * 扫码解析（02 §3.2，M-N12）：先整串原文精确匹配登记表，再大写匹配，再按前缀（WRONG_WAREHOUSE / 本仓裸编码），
 * 最后无前缀裸编码。所有可能的查找键一次批量取回，再调用 domain.classifyScan（与移动端同一分类器）。
 */
export const scanModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.scanResolve, async ({ query, warehouseId }) => {
    const pool = poolOf(services);
    const keys = scanLookupKeys(query.code);
    const [whs, reg, locs, racks] = await Promise.all([
      pool.query<{ id: string; code: string }>(`SELECT id, code FROM warehouses`),
      pool.query<{
        value: string;
        kind: 'SKU' | 'LOCATION' | 'RACK';
        wh_code: string | null;
        entity_id: string;
      }>(
        `SELECT g.value, g.kind, w.code AS wh_code, g.entity_id FROM barcode_registry g
           LEFT JOIN warehouses w ON w.id = g.warehouse_id WHERE g.value = ANY($1::text[])`,
        [keys.registry],
      ),
      pool.query<{ id: string; code: string }>(
        `SELECT id, code FROM locations WHERE warehouse_id = $1 AND code = ANY($2::text[])`,
        [warehouseId, keys.codes],
      ),
      pool.query<{ id: string; code: string }>(
        `SELECT id, code FROM racks WHERE warehouse_id = $1 AND is_active AND code = ANY($2::text[])`,
        [warehouseId, keys.codes],
      ),
    ]);
    const self = whs.rows.find((w) => w.id === warehouseId);
    if (!self) throw new ApiError('NOT_FOUND', '仓库不存在');
    const regMap = new Map(reg.rows.map((x) => [x.value, x]));
    const locMap = new Map(locs.rows.map((x) => [x.code, x.id]));
    const rackMap = new Map(racks.rows.map((x) => [x.code, x.id]));
    const res = classifyScan(query.code, {
      warehouseCode: self.code,
      knownWarehouseCodes: new Set(whs.rows.map((w) => w.code)),
      lookupRegistry: (v) => {
        const h = regMap.get(v);
        return h ? { kind: h.kind, warehouseCode: h.wh_code, entityId: h.entity_id } : null;
      },
      lookupLocationCode: (c) => locMap.get(c) ?? null,
      lookupRackCode: (c) => rackMap.get(c) ?? null,
    });
    const out: ScanResolution = { kind: res.kind, raw: query.code };
    if (res.kind === 'LOCATION' && res.entityId) {
      const l = (await loadLocations(pool, [res.entityId]))[0];
      if (l) out.location = l;
      else out.kind = 'UNKNOWN';
    } else if (res.kind === 'RACK' && res.entityId) {
      const k = await pool.query<{ id: string; code: string }>(
        `SELECT id, code FROM racks WHERE id = $1`,
        [res.entityId],
      );
      if (k.rows[0]) out.rack = k.rows[0];
      else out.kind = 'UNKNOWN';
    } else if (res.kind === 'SKU' && res.entityId) {
      const sku = await loadSku(pool, res.entityId);
      if (!sku) out.kind = 'UNKNOWN';
      else {
        out.sku = sku;
        const hit =
          sku.barcodes.find((b) => b.barcode === res.text) ??
          sku.barcodes.find((b) => b.barcode === res.text.toUpperCase());
        out.packQty = hit?.packQty ?? 1;
      }
    } else if (res.kind === 'WRONG_WAREHOUSE' && res.otherWarehouseCode) {
      out.otherWarehouseCode = res.otherWarehouseCode;
    }
    return out;
  });
};
