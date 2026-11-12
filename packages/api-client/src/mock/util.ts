import type { ErrorCode, Problem } from '@wms3d/contracts';

export type MockBody =
  | { kind: 'json'; value: unknown }
  | { kind: 'text'; value: string; contentType: string }
  | { kind: 'none' }
  | { kind: 'sse'; warehouseId: string };

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: MockBody;
}

export class MockError extends Error {
  readonly code: ErrorCode;
  readonly extra: Partial<Problem> | undefined;
  constructor(code: ErrorCode, detail?: string, extra?: Partial<Problem>) {
    super(detail ?? code);
    this.code = code;
    this.extra = extra;
  }
}

/** handler 可返回 raw(...) 自定义状态码/头/非 JSON 响应 */
export function raw(
  status: number,
  body: MockBody,
  headers: Record<string, string> = {},
): { __mock: MockResponse } {
  return { __mock: { status, headers, body } };
}
