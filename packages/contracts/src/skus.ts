import { z } from 'zod';
import { Barcode, Id, ListQuery, SkuCode, Timestamp } from './common.ts';

export const SkuBarcode = z
  .object({ id: Id, barcode: Barcode, packQty: z.number().int().min(1), isPrimary: z.boolean() })
  .meta({ id: 'SkuBarcode' });

export const Sku = z
  .object({
    id: Id,
    code: SkuCode,
    name: z.string(),
    spec: z.string().nullable(),
    uom: z.string(),
    lengthMm: z.number().int().nullable(),
    widthMm: z.number().int().nullable(),
    heightMm: z.number().int().nullable(),
    weightG: z.number().int().nullable(),
    safetyStock: z.number().int().nonnegative(),
    isActive: z.boolean(),
    imageUrl: z.string().nullable(),
    barcodes: z.array(SkuBarcode),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'Sku' });
export type Sku = z.infer<typeof Sku>;

export const SkuCreate = z
  .object({
    code: SkuCode,
    name: z.string().min(1).max(128),
    spec: z.string().max(128).nullable().default(null),
    uom: z.string().max(8).default('EA'),
    lengthMm: z.number().int().positive().nullable().default(null),
    widthMm: z.number().int().positive().nullable().default(null),
    heightMm: z.number().int().positive().nullable().default(null),
    weightG: z.number().int().positive().nullable().default(null),
    safetyStock: z.number().int().nonnegative().default(0),
    barcodes: z
      .array(
        z.object({
          barcode: Barcode,
          packQty: z.number().int().min(1).default(1),
          isPrimary: z.boolean().default(false),
        }),
      )
      .max(20)
      .default([]),
  })
  .meta({ id: 'SkuCreate' });
export const SkuPatch = SkuCreate.omit({ code: true, barcodes: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .meta({ id: 'SkuPatch' });
export const SkuBarcodeCreate = z
  .object({
    barcode: Barcode,
    packQty: z.number().int().min(1).default(1),
    isPrimary: z.boolean().default(false),
  })
  .meta({ id: 'SkuBarcodeCreate' });

export const SkusQuery = ListQuery.extend({
  q: z.string().max(64).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

/** CSV 列（05 §3）：code,name,spec,uom,barcode,pack_qty,safety_stock,length_mm,width_mm,height_mm,weight_g */
export const SKU_CSV_COLUMNS = [
  'code',
  'name',
  'spec',
  'uom',
  'barcode',
  'pack_qty',
  'safety_stock',
  'length_mm',
  'width_mm',
  'height_mm',
  'weight_g',
] as const;
export const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).default('true') });
export const ImportResult = z
  .object({
    dryRun: z.boolean(),
    totalRows: z.number().int(),
    created: z.number().int(),
    updated: z.number().int(),
    committedBatches: z.number().int().describe('每 1000 行一个事务（B-N7）'),
    errors: z.array(
      z.object({
        row: z.number().int(),
        column: z.string().nullable(),
        code: z.enum(['DUPLICATE', 'BARCODE_CONFLICT', 'FORMAT', 'REQUIRED']),
        message: z.string(),
      }),
    ),
  })
  .meta({ id: 'ImportResult' });
