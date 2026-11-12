import { z } from 'zod';
import { Barcode, Id, StructCode, Timestamp, WarehouseCode } from './common.ts';
import { Location } from './warehouses.ts';
import { Sku } from './skus.ts';

export const ScanKind = z
  .enum(['LOCATION', 'RACK', 'SKU', 'UNKNOWN', 'WRONG_WAREHOUSE'])
  .meta({ id: 'ScanKind' });
export type ScanKind = z.infer<typeof ScanKind>;

export const ScanResolveQuery = z.object({ warehouseId: Id, code: z.string().min(1).max(128) });
export const ScanResolution = z
  .object({
    kind: ScanKind,
    raw: z.string(),
    location: Location.optional(),
    rack: z.object({ id: Id, code: StructCode }).optional(),
    sku: Sku.optional(),
    packQty: z.number().int().min(1).optional().describe('kind=SKU 时该条码的包装数'),
    otherWarehouseCode: WarehouseCode.optional().describe('kind=WRONG_WAREHOUSE'),
  })
  .meta({ id: 'ScanResolution' });
export type ScanResolution = z.infer<typeof ScanResolution>;

/** 主数据增量（03 §5）：游标 = 已见最大 updated_at − 180s 安全窗口，按 id 幂等 upsert。 */
export const SyncQuery = z.object({
  warehouseId: Id,
  cursor: z.string().max(200).optional().describe('不传 = 首次全量'),
  limit: z.coerce.number().int().min(1).max(2000).default(2000),
});
export const SyncLocation = z
  .object({
    id: Id,
    code: StructCode,
    payload: z.string(),
    kind: z.string(),
    isActive: z.boolean(),
    rackCode: StructCode.nullable(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'SyncLocation' });
export const SyncSku = z
  .object({
    id: Id,
    code: z.string(),
    name: z.string(),
    spec: z.string().nullable(),
    uom: z.string(),
    isActive: z.boolean(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'SyncSku' });
export const SyncBarcode = z
  .object({ id: Id, skuId: Id, barcode: Barcode, packQty: z.number().int(), updatedAt: Timestamp })
  .meta({ id: 'SyncBarcode' });
export const SyncPage = z
  .object({
    skus: z.array(SyncSku),
    barcodes: z.array(SyncBarcode),
    locations: z.array(SyncLocation),
    tombstones: z.array(
      z.object({ entity: z.enum(['sku', 'barcode', 'location']), id: Id, deletedAt: Timestamp }),
    ),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    total: z.number().int().optional().describe('仅首次全量第一页，用于进度条'),
    serverTime: Timestamp,
  })
  .meta({ id: 'SyncPage' });
export const SyncDigest = z
  .object({
    skus: z.number().int(),
    barcodes: z.number().int(),
    locations: z.number().int(),
    hash: z.string(),
  })
  .meta({ id: 'SyncDigest' });
