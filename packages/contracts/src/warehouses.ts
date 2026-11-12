import { z } from 'zod';
import {
  Id,
  ListQuery,
  Meters,
  RowVersion,
  Side,
  StructCode,
  Timestamp,
  WarehouseCode,
  ZoneKind,
} from './common.ts';
import { LayoutDiff, LayoutDoc, LayoutIssue, Point2, RackTypeSpec, RotationDeg } from './layout.ts';

export const DEFAULT_LOCATION_CODE_PATTERN = '{Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2}';

export const Warehouse = z
  .object({
    id: Id,
    code: WarehouseCode,
    name: z.string(),
    timezone: z.string(),
    widthM: z.number(),
    depthM: z.number(),
    heightM: z.number(),
    locationCodePattern: z.string(),
    locationCodePatternLocked: z.boolean().describe('已存在仓位时不可改（由 EXISTS 推导）'),
    barcodePrefixEnabled: z.boolean(),
    allowMixedSku: z.boolean(),
    publishedLayoutVersion: z.number().int().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Warehouse' });
export type Warehouse = z.infer<typeof Warehouse>;

export const WarehouseCreate = z
  .object({
    code: WarehouseCode,
    name: z.string().min(1).max(64),
    timezone: z.string().max(64).default('Asia/Shanghai'),
    widthM: z.number().positive().max(2000),
    depthM: z.number().positive().max(2000),
    heightM: z.number().positive().max(60),
    locationCodePattern: z.string().max(80).default(DEFAULT_LOCATION_CODE_PATTERN),
    barcodePrefixEnabled: z.boolean().default(true),
    allowMixedSku: z.boolean().default(true),
  })
  .meta({ id: 'WarehouseCreate' });
export const WarehousePatch = WarehouseCreate.omit({ code: true })
  .partial()
  .meta({ id: 'WarehousePatch' });

export const Zone = z
  .object({
    id: Id,
    warehouseId: Id,
    layoutVersion: z.number().int(),
    code: z.string(),
    name: z.string().nullable(),
    kind: ZoneKind,
    polygon: z.array(Point2),
    color: z.string().nullable(),
  })
  .meta({ id: 'Zone' });

export const Rack = z
  .object({
    id: Id,
    warehouseId: Id,
    zoneId: Id,
    layoutKey: z.string(),
    code: StructCode,
    aisle: z.number().int(),
    side: Side,
    rackNo: z.number().int(),
    bayStart: z.number().int(),
    rackType: RackTypeSpec,
    x: Meters,
    z: Meters,
    rotationDeg: RotationDeg,
    isActive: z.boolean(),
    layoutVersion: z.number().int(),
  })
  .meta({ id: 'Rack' });

export const RackTypeLib = RackTypeSpec.and(z.object({ id: Id })).meta({ id: 'RackTypeLib' });
export const RackTypeCreate = RackTypeSpec.meta({ id: 'RackTypeCreate' });

export const Location = z
  .object({
    id: Id,
    warehouseId: Id,
    zoneId: Id,
    rackId: Id.nullable(),
    code: StructCode,
    payload: z
      .string()
      .describe('条码载荷：barcodePrefixEnabled ? `${warehouse.code}.${code}` : code'),
    kind: ZoneKind,
    bay: z.number().int().nullable(),
    level: z.number().int().nullable(),
    position: z.number().int().nullable(),
    rackBayIndex: z.number().int().nullable(),
    pickSeq: z.number().int(),
    maxQty: z.number().int().nullable(),
    effectiveMax: z.number().int().nullable(),
    isActive: z.boolean(),
    updatedAt: Timestamp,
  })
  .meta({ id: 'Location' });
export type Location = z.infer<typeof Location>;

export const LocationsQuery = ListQuery.extend({
  zone: z.string().max(4).optional(),
  rack: StructCode.optional(),
  q: z.string().max(32).optional(),
  kind: ZoneKind.optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

export const LocationPatch = z
  .object({
    isActive: z.boolean(),
    maxQty: z.number().int().positive().nullable(),
    pickSeq: z.number().int().nonnegative(),
  })
  .partial()
  .meta({ id: 'LocationPatch' });

export const LocationsBulkPatch = z
  .object({ ids: z.array(Id).min(1).max(5000), patch: LocationPatch })
  .meta({ id: 'LocationsBulkPatch' });
export const BulkResult = z
  .object({ updated: z.number().int(), failed: z.array(z.object({ id: Id, code: z.string() })) })
  .meta({ id: 'BulkResult' });

// ---------- 布局 ----------
export const WarehouseIdParams = z.object({ id: Id });
export const LayoutQuery = z.object({
  version: z
    .union([z.literal('draft'), z.literal('published'), z.coerce.number().int().positive()])
    .default('published'),
});
export const DraftCreate = z
  .object({ basedOnVersion: z.number().int().nullable() })
  .meta({ id: 'DraftCreate' });
export const DraftSave = z.object({ doc: LayoutDoc }).meta({ id: 'DraftSave' });
export const ValidateResult = z
  .object({ issues: z.array(LayoutIssue), diff: LayoutDiff, locationCount: z.number().int() })
  .meta({ id: 'ValidateResult' });
export const PublishRequest = z
  .object({ rowVersion: RowVersion, confirmRecode: z.boolean().default(false) })
  .meta({ id: 'PublishRequest' });
export const PublishResult = z
  .object({
    layoutVersion: z.number().int(),
    diff: LayoutDiff,
    reprintRequestIds: z.array(Id).describe('自动进入补打队列（07 §4）'),
  })
  .meta({ id: 'PublishResult' });

// ---------- 3D（03 §7） ----------
export const TwinModel = z
  .object({
    warehouseId: Id,
    warehouseCode: WarehouseCode,
    layoutVersion: z.number().int(),
    layout: LayoutDoc,
    locations: z.object({
      id: z.array(Id),
      code: z.array(z.string()),
      rackKey: z.array(z.string().nullable()).describe('地面仓位为 null'),
      rackBayIndex: z.array(z.number().int().nullable()),
      level: z.array(z.number().int().nullable()),
      pos: z.array(z.number().int().nullable()),
    }),
  })
  .meta({
    id: 'TwinModel',
    description: '下标 = twinIndex，仅在该 layoutVersion 内有效；ETag = layoutVersion',
  });
export type TwinModel = z.infer<typeof TwinModel>;

export const OccupancyQuery = z.object({ layoutVersion: z.coerce.number().int().positive() });
export const Occupancy = z
  .object({
    layoutVersion: z.number().int(),
    asOf: Timestamp,
    qty: z.array(z.number().int()),
    skuCount: z.array(z.number().int()),
    fill: z.array(z.number().min(0).max(1)),
    isActive: z.array(z.union([z.literal(0), z.literal(1)])),
    effectiveMax: z.array(z.number().int().nullable()),
  })
  .meta({
    id: 'Occupancy',
    description: 'ETag = 内容哈希（v2.1 N2）；数组与 TwinModel.locations 等长同序',
  });
export type Occupancy = z.infer<typeof Occupancy>;
