import { describe, expect, it } from 'vitest';
import { problem } from '@wms3d/contracts';
import { ApiError, createApiClient } from '@wms3d/api-client';
import { toErrorView } from './errors';

describe('problem+json → 中文提示', () => {
  it('用 ERROR_TITLES 作标题，detail 作补充', () => {
    const p = problem('INSUFFICIENT_STOCK', 'A01-01-A01 上 SKU-001 仅剩 5');
    const v = toErrorView(new ApiError(422, 'INSUFFICIENT_STOCK', p));
    expect(v.message).toBe('库存不足：A01-01-A01 上 SKU-001 仅剩 5');
    expect(v.code).toBe('INSUFFICIENT_STOCK');
  });

  it('英文 title 不外露', () => {
    const p = { ...problem('LOCATION_INACTIVE'), title: 'Location inactive' };
    expect(toErrorView(new ApiError(422, 'LOCATION_INACTIVE', p)).message).toBe('仓位已停用');
  });

  it('VALIDATION_FAILED 拼字段错误（最多 3 个）并映射字段名', () => {
    const p = problem('VALIDATION_FAILED', undefined, {
      errors: [
        { path: 'body.code', message: '格式不正确' },
        { path: 'body.name', message: '必填' },
        { path: 'body.lines[0].qty', message: '必须为正整数' },
        { path: 'body.note', message: '过长' },
      ],
    });
    const v = toErrorView(new ApiError(400, 'VALIDATION_FAILED', p));
    expect(v.message).toBe('请求参数不正确：编码 格式不正确；名称 必填；数量 必须为正整数 等 4 处');
    expect(v.fields).toHaveLength(4);
  });

  it('带 traceId', () => {
    const p = problem('INTERNAL', undefined, { traceId: 'abc123' });
    expect(toErrorView(new ApiError(500, 'INTERNAL', p)).traceId).toBe('abc123');
  });

  it('网络错误与非 JSON 响应', () => {
    expect(toErrorView(new ApiError(0, 'NETWORK', null, 'fetch failed')).message).toMatch(
      /^网络错误/,
    );
    expect(toErrorView(new ApiError(502, 'INTERNAL', null, 'HTTP 502')).message).toBe(
      '服务器内部错误（HTTP 502）',
    );
    expect(toErrorView(new Error('x')).message).toBe('x');
  });

  it('端到端：api-client 解析 problem+json 响应后可映射', async () => {
    const fetch = async () =>
      new Response(JSON.stringify(problem('WRONG_WAREHOUSE', 'WH2.A01-01-A01 属于 WH2')), {
        status: 422,
        headers: { 'content-type': 'application/problem+json' },
      });
    const api = createApiClient({ getAccessToken: () => 't', fetch });
    const err = await api.r.me({}).catch((e: unknown) => e);
    expect(toErrorView(err).message).toBe('不是本仓库的条码：WH2.A01-01-A01 属于 WH2');
  });
});
