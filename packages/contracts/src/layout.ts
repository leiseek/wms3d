import { z } from 'zod';
import { Id, LayoutStatus, Meters, RowVersion, StructCode, Timestamp, ZoneKind } from './common.ts';

/** 布局文档（02 §9）：几何与编码的唯一真相源。坐标约定见 02 §2（米；+X 右、+Z 下；rotationDeg 俯视顺时针）。 */
export const Point2 = z.tuple([Meters, Meters]).meta({ id: 'Point2', description: '[x, z]（米）' });

export const RackTypeSpec = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
    name: z.string().max(64).optional(),
    bays: z.number().int().min(1).max(49),
    levels: z.number().int().min(1).max(26),
    positionsPerLevel: z.number().int().min(1).max(99),
    bayWidthM: z.number().positive().max(10),
    depthM: z.number().positive().max(5),
    levelHeightsM: z.array(z.number().positive().max(5)).min(1).max(26),
    beamM: z.number().nonnegative().max(0.5),
    uprightM: z.number().nonnegative().max(0.5),
    defaultMaxQty: z.number().int().positive().nullable(),
  })
  .refine((t) => t.levelHeightsM.length === t.levels, {
    message: 'levelHeightsM 长度必须等于 levels',
    path: ['levelHeightsM'],
  })
  .meta({ id: 'RackTypeSpec' });
export type RackTypeSpec = z.infer<typeof RackTypeSpec>;

export const LayoutZone = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9]{0,3}$/),
    name: z.string().max(64).optional(),
    kind: ZoneKind,
    polygon: z.array(Point2).min(3).max(200),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
  })
  .meta({ id: 'LayoutZone' });
export type LayoutZone = z.infer<typeof LayoutZone>;

export const RotationDeg = z
  .union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
  .meta({ id: 'RotationDeg' });
export type RotationDeg = z.infer<typeof RotationDeg>;

export const LayoutRack = z
  .object({
    key: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/)
      .describe('稳定键：发布时第一轮匹配依据（02 §9）'),
    zone: z.string().regex(/^[A-Z][A-Z0-9]{0,3}$/),
    type: z.string().describe('doc.rackTypes[].key（按值快照）'),
    aisle: z.number().int().min(1).max(99),
    rackNo: z.number().int().min(1).max(99),
    bayStart: z
      .number()
      .int()
      .min(1)
      .max(999)
      .describe('靠行进起点一端的巷道级 bay 号；L 奇 R 偶（side 由 rotationDeg 推导）'),
    x: Meters,
    z: Meters,
    rotationDeg: RotationDeg,
  })
  .meta({ id: 'LayoutRack' });
export type LayoutRack = z.infer<typeof LayoutRack>;

export const FloorArea = z
  .object({
    zone: z.string().regex(/^[A-Z][A-Z0-9]{0,3}$/),
    locationCode: StructCode,
    polygon: z.array(Point2).min(3).max(200),
  })
  .meta({ id: 'FloorArea' });
export type FloorArea = z.infer<typeof FloorArea>;

export const LayoutDoc = z
  .object({
    schemaVersion: z.literal(2),
    warehouse: z.object({
      widthM: z.number().positive().max(2000),
      depthM: z.number().positive().max(2000),
      heightM: z.number().positive().max(60),
    }),
    zones: z.array(LayoutZone).max(200),
    rackTypes: z.array(RackTypeSpec).max(100),
    racks: z.array(LayoutRack).max(5000),
    floorAreas: z.array(FloorArea).max(500),
  })
  .meta({ id: 'LayoutDoc' });
export type LayoutDoc = z.infer<typeof LayoutDoc>;

export const LayoutVersion = z
  .object({
    id: z.number().int(),
    warehouseId: Id,
    version: z.number().int().nullable(),
    status: LayoutStatus,
    rowVersion: RowVersion,
    basedOnVersion: z.number().int().nullable(),
    doc: LayoutDoc,
    createdBy: Id,
    createdAt: Timestamp,
    publishedAt: Timestamp.nullable(),
    publishedBy: Id.nullable(),
  })
  .meta({ id: 'LayoutVersion' });
export type LayoutVersion = z.infer<typeof LayoutVersion>;

export const LayoutVersionSummary = LayoutVersion.omit({ doc: true }).meta({
  id: 'LayoutVersionSummary',
});

export const LayoutIssue = z
  .object({
    severity: z.enum(['ERROR', 'WARNING']),
    code: z.enum([
      'RACK_OVERLAP',
      'OUT_OF_BOUNDS',
      'AISLE_TOO_NARROW',
      'AISLE_FACE_MISALIGNED',
      'BAY_RANGE_OVERLAP',
      'BAY_PARITY',
      'CODE_DUPLICATE',
      'CODE_TOO_LONG',
      'UNKNOWN_ZONE',
      'UNKNOWN_RACK_TYPE',
      'RACK_OUTSIDE_ZONE',
      'OTHER',
    ]),
    message: z.string(),
    rackKeys: z.array(z.string()).default([]),
    codes: z.array(z.string()).default([]),
  })
  .meta({ id: 'LayoutIssue' });
export type LayoutIssue = z.infer<typeof LayoutIssue>;

export const LayoutDiff = z
  .object({
    added: z.array(z.object({ code: StructCode })),
    kept: z.number().int().nonnegative(),
    recoded: z.array(
      z.object({ locationId: Id, from: StructCode, to: StructCode, onHand: z.number().int() }),
    ),
    deactivated: z.array(z.object({ locationId: Id, code: StructCode, onHand: z.number().int() })),
    reused: z
      .array(z.object({ locationId: Id, code: StructCode }))
      .describe('第二轮按 code 复用的停用仓位（B-N3）'),
  })
  .meta({ id: 'LayoutDiff' });
export type LayoutDiff = z.infer<typeof LayoutDiff>;
