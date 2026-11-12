import { z } from 'zod';
import { Id, ListQuery, StructCode, Timestamp } from './common.ts';

/** 内置模板（07 §2）。 */
export const LabelTemplateKey = z
  .enum(['loc-100x50', 'loc-60x40', 'loc-70x30', 'rack-100x150', 'a4-3x8', 'a4-2x7', 'sku-60x40'])
  .meta({ id: 'LabelTemplateKey' });
export type LabelTemplateKey = z.infer<typeof LabelTemplateKey>;
export const LabelKind = z.enum(['LOCATION', 'RACK', 'SKU']).meta({ id: 'LabelKind' });
export type LabelKind = z.infer<typeof LabelKind>;

export const LabelTemplate = z
  .object({
    key: LabelTemplateKey,
    name: z.string(),
    kinds: z.array(LabelKind),
    widthMm: z.number(),
    heightMm: z.number(),
    sheet: z
      .object({ cols: z.number().int(), rows: z.number().int() })
      .nullable()
      .describe('A4 多联模板'),
    maxModules: z.object({ dpi203: z.number().int(), dpi300: z.number().int() }).nullable(),
    supportsBarePayload: z.boolean(),
  })
  .meta({ id: 'LabelTemplate' });
export type LabelTemplate = z.infer<typeof LabelTemplate>;

export const LabelRenderRequest = z
  .object({
    template: LabelTemplateKey,
    kind: LabelKind,
    warehouseId: Id.describe(
      'v1.2（WS-A1-2）：必填（SKU 标签也带当前仓库，用于作用域、审计与补打队列归属）',
    ),
    ids: z.array(Id).max(5000).optional(),
    filter: z
      .object({
        zone: z.string().optional(),
        rack: StructCode.optional(),
        codeFrom: StructCode.optional(),
        codeTo: StructCode.optional(),
      })
      .optional(),
    format: z.enum(['PDF', 'ZPL']).default('PDF'),
    dpi: z.union([z.literal(203), z.literal(300)]).default(203),
    startCell: z.number().int().min(1).max(64).optional().describe('A4 起始格（1 起）'),
    offsetMm: z
      .object({ x: z.number().min(-10).max(10), y: z.number().min(-10).max(10) })
      .optional(),
    reprintRequestIds: z.array(Id).optional().describe('打印完成后标记这些补打请求为 DONE'),
  })
  .refine((r) => !!r.ids?.length !== !!r.filter, { message: 'ids 与 filter 必须且只能给一个' })
  .meta({ id: 'LabelRenderRequest' });

export const CalibrationQuery = z.object({
  template: LabelTemplateKey,
  dpi: z.coerce.number().int().default(203),
});

export const ReprintStatus = z.enum(['PENDING', 'DONE', 'CANCELLED']).meta({ id: 'ReprintStatus' });
export const ReprintRequest = z
  .object({
    id: Id,
    warehouseId: Id,
    kind: LabelKind,
    entityId: Id,
    code: z.string(),
    reason: z.enum(['DAMAGED', 'MISSING', 'LAYOUT_RECODE', 'LAYOUT_NEW', 'OTHER']),
    note: z.string().nullable(),
    status: ReprintStatus,
    requestedBy: Id,
    requestedAt: Timestamp,
    doneAt: Timestamp.nullable(),
  })
  .meta({ id: 'ReprintRequest' });
export const ReprintCreate = z
  .object({
    warehouseId: Id,
    kind: LabelKind,
    entityId: Id,
    reason: z.enum(['DAMAGED', 'MISSING', 'OTHER']),
    note: z.string().max(200).optional(),
  })
  .meta({ id: 'ReprintCreate' });
export const ReprintPatch = z
  .object({ status: z.enum(['DONE', 'CANCELLED']) })
  .meta({ id: 'ReprintPatch' });
export const ReprintQuery = ListQuery.extend({ warehouseId: Id, status: ReprintStatus.optional() });
