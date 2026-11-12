import { ERROR_TITLES, type ErrorCode } from '@wms3d/contracts';
import { ApiError } from '@wms3d/api-client';

/** 字段路径 → 中文标签（problem.errors[].path 常见字段）。 */
const FIELD_LABELS: Record<string, string> = {
  code: '编码',
  name: '名称',
  username: '用户名',
  displayName: '姓名',
  newPassword: '新密码',
  currentPassword: '当前密码',
  temporaryPassword: '临时密码',
  barcode: '条码',
  qty: '数量',
  qtyDelta: '调整量',
  note: '备注',
  refNo: '单号',
  maxQty: '容量',
};

function fieldLabel(path: string): string {
  const last =
    path
      .split(/[./[\]]/)
      .filter(Boolean)
      .pop() ?? path;
  return FIELD_LABELS[last] ?? path;
}

export interface ErrorView {
  /** 一行中文提示（用于 message.error） */
  message: string;
  code: ErrorCode | 'NETWORK' | 'UNKNOWN';
  /** 逐字段错误（VALIDATION_FAILED） */
  fields: { path: string; label: string; message: string }[];
  traceId?: string;
}

/**
 * problem+json（RFC 9457）→ 中文提示。标题统一取 ERROR_TITLES（服务端 title 可能是英文），
 * detail 作为补充说明；VALIDATION_FAILED 拼上前 3 个字段错误。401 刷新重试由 api-client 负责，这里不重复。
 */
export function toErrorView(err: unknown): ErrorView {
  if (err instanceof ApiError) {
    if (err.code === 'NETWORK')
      return { message: '网络错误：无法连接服务器，请检查网络后重试', code: 'NETWORK', fields: [] };
    const p = err.problem;
    const title = ERROR_TITLES[err.code] ?? err.message;
    const fields = (p?.errors ?? []).map((e) => ({
      path: e.path,
      label: fieldLabel(e.path),
      message: e.message,
    }));
    let message = title;
    const detail = p?.detail;
    if (detail && detail !== title) message += `：${detail}`;
    if (fields.length)
      message +=
        (detail ? '；' : '：') +
        fields
          .slice(0, 3)
          .map((f) => `${f.label} ${f.message}`)
          .join('；') +
        (fields.length > 3 ? ` 等 ${fields.length} 处` : '');
    if (!p && err.status) message = `${title}（HTTP ${err.status}）`;
    const view: ErrorView = { message, code: err.code, fields };
    if (p?.traceId) view.traceId = p.traceId;
    return view;
  }
  if (err instanceof Error && err.name === 'AbortError')
    return { message: '请求已取消', code: 'UNKNOWN', fields: [] };
  return {
    message: err instanceof Error ? err.message : String(err),
    code: 'UNKNOWN',
    fields: [],
  };
}

export const errorMessage = (err: unknown) => toErrorView(err).message;
