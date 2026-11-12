import { z } from 'zod';

/** 契约版本：contract-v1 冻结后只允许向后兼容的新增（新可选字段、新端点）。破坏性变更 = contract-v2。 */
export const CONTRACT_VERSION = '1.2.0';
export const API_PREFIX = '/api/v1';

// ---------- 基础类型 ----------
export const Id = z
  .uuid()
  .meta({ id: 'Id', description: 'UUID（服务端生成；库存交易幂等键为客户端 UUIDv7）' });
export type Id = z.infer<typeof Id>;
export const DeviceId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .meta({
    id: 'DeviceId',
    description: '设备 ID：移动端安装时生成并持久化；PC 浏览器存 localStorage',
  });
export const Timestamp = z.iso
  .datetime({ offset: true })
  .meta({ id: 'Timestamp', description: 'ISO-8601 时间（服务端输出 UTC Z）' });
export const WarehouseCode = z
  .string()
  .regex(/^[A-Z0-9]{2,4}$/)
  .meta({ id: 'WarehouseCode' });
/** 结构编码（仓位/货架/库区）：字符集 [A-Z0-9-]，不含 '.'（'.' 只出现在条码载荷里）。 */
export const StructCode = z
  .string()
  .regex(/^[A-Z0-9-]{1,32}$/)
  .meta({ id: 'StructCode' });
export const SkuCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._\-/]+$/)
  .meta({ id: 'SkuCode' });
export const Barcode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x21-\x7E]+$/)
  .meta({ id: 'Barcode', description: '可打印 ASCII，原样保存（区分大小写）' });
export const Qty = z.number().int().positive().max(1_000_000);
export const IdempotencyKey = z
  .string()
  .min(8)
  .max(80)
  .regex(/^[A-Za-z0-9_:.-]+$/);
export const Meters = z.number().finite().min(-10_000).max(10_000);
export const RowVersion = z.number().int().nonnegative();

// ---------- 枚举 ----------
export const Role = z.enum(['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER']).meta({ id: 'Role' });
export type Role = z.infer<typeof Role>;
export const ZoneKind = z.enum(['STORAGE', 'RECEIVING', 'SHIPPING', 'QC']).meta({ id: 'ZoneKind' });
export type ZoneKind = z.infer<typeof ZoneKind>;
export const Side = z.enum(['L', 'R']).meta({ id: 'Side' });
export type Side = z.infer<typeof Side>;
export const TxnType = z
  .enum(['INBOUND', 'OUTBOUND', 'TRANSFER', 'ADJUST', 'COUNT_ADJUST', 'REVERSAL'])
  .meta({ id: 'TxnType' });
export type TxnType = z.infer<typeof TxnType>;
export const AdjustReason = z
  .enum(['DAMAGE', 'LOST', 'FOUND', 'EXPIRED', 'DATA_FIX', 'OTHER'])
  .meta({ id: 'AdjustReason' });
export const CountStatus = z
  .enum(['OPEN', 'COUNTING', 'REVIEW', 'CLOSED', 'CANCELLED'])
  .meta({ id: 'CountStatus' });
export const LayoutStatus = z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).meta({ id: 'LayoutStatus' });
export const AuditResult = z.enum(['SUCCESS', 'DENIED', 'FAILED']).meta({ id: 'AuditResult' });

// ---------- 分页（keyset，03 §1） ----------
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(200).optional(),
});
export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const Empty = z.object({}).strict();
export const IdParams = z.object({ id: Id });
export const WarehouseQuery = z.object({ warehouseId: Id });
