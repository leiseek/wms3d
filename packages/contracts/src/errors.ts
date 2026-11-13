import { z } from 'zod';

/** 错误码 → HTTP 状态（RFC 9457 problem+json，03 §3）。新增错误码属于向后兼容变更。 */
export const ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  PASSWORD_CHANGE_REQUIRED: 403,
  DEVICE_DISABLED: 403,
  PERFORMER_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  TXN_ALREADY_REVERSED: 409,
  LAYOUT_STALE: 409,
  BARCODE_CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  INSUFFICIENT_STOCK: 422,
  LOCATION_INACTIVE: 422,
  SKU_INACTIVE: 422,
  LOCATION_CAPACITY_EXCEEDED: 422,
  MIXED_SKU_NOT_ALLOWED: 422,
  UNKNOWN_BARCODE: 422,
  WRONG_WAREHOUSE: 422,
  LAYOUT_INVALID: 422,
  LAYOUT_HAS_STOCK: 422,
  LAYOUT_RECODE_NEEDS_CONFIRM: 422,
  REVERSAL_NOT_ALLOWED: 422,
  COUNT_OUTBOX_PENDING: 422,
  COUNT_RECOUNT_REQUIRED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export const ErrorCodeSchema = z
  .enum(Object.keys(ERROR_STATUS) as [ErrorCode, ...ErrorCode[]])
  .meta({ id: 'ErrorCode' });

export const Problem = z
  .object({
    type: z.string().describe('urn:wms3d:error:<CODE>'),
    title: z.string(),
    status: z.number().int(),
    code: ErrorCodeSchema,
    detail: z.string().optional(),
    traceId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    context: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'Problem' });
export type Problem = z.infer<typeof Problem>;

export const ERROR_TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: '请求参数不正确',
  UNAUTHENTICATED: '未登录或登录已过期',
  FORBIDDEN: '没有权限',
  PASSWORD_CHANGE_REQUIRED: '需要先修改密码',
  DEVICE_DISABLED: '设备已被禁用',
  PERFORMER_NOT_ALLOWED: '操作人校验未通过',
  NOT_FOUND: '资源不存在',
  CONFLICT: '状态冲突',
  IDEMPOTENCY_KEY_REUSED: '幂等键已被不同请求使用',
  TXN_ALREADY_REVERSED: '该交易已冲正',
  LAYOUT_STALE: '布局版本已更新',
  BARCODE_CONFLICT: '条码已被占用',
  PRECONDITION_FAILED: '数据已被他人修改',
  INSUFFICIENT_STOCK: '库存不足',
  LOCATION_INACTIVE: '仓位已停用',
  SKU_INACTIVE: 'SKU 已停用',
  LOCATION_CAPACITY_EXCEEDED: '超出仓位容量',
  MIXED_SKU_NOT_ALLOWED: '该仓库不允许混放',
  UNKNOWN_BARCODE: '未知条码',
  WRONG_WAREHOUSE: '不是本仓库的条码',
  LAYOUT_INVALID: '布局校验未通过',
  LAYOUT_HAS_STOCK: '待停用仓位仍有库存',
  LAYOUT_RECODE_NEEDS_CONFIRM: '有库存仓位改码需要确认',
  REVERSAL_NOT_ALLOWED: '不允许冲正',
  COUNT_OUTBOX_PENDING: '仍有待同步单据',
  COUNT_RECOUNT_REQUIRED: '部分仓位需要重盘',
  RATE_LIMITED: '请求过于频繁',
  INTERNAL: '服务器内部错误',
  NOT_IMPLEMENTED: '尚未实现',
};

export function problem(code: ErrorCode, detail?: string, extra?: Partial<Problem>): Problem {
  return {
    type: `urn:wms3d:error:${code}`,
    title: ERROR_TITLES[code],
    status: ERROR_STATUS[code],
    code,
    ...(detail === undefined ? {} : { detail }),
    ...extra,
  };
}
