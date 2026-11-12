import { expect, test } from '@playwright/test';
import { call, state } from '../../lib/api.ts';

test.describe('运维端点', () => {
  test('health 返回 ok + contractVersion', async () => {
    const r = await call<{ status: string; contractVersion: string }>('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
    expect(r.body.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(r.headers.get('x-trace-id') ?? (state().target === 'mock' ? 'mock' : null)).toBeTruthy();
  });

  test('ready 连库成功', async () => {
    const r = await call<{ status: string; database?: string }>('GET', '/ready');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ready');
    if (state().db) expect(r.body.database).toBe(state().db);
  });

  test('未登录访问受保护端点 → 401 problem+json', async () => {
    const r = await call<{ code: string }>('GET', '/me');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('UNAUTHENTICATED');
  });

  test('安全响应头（08 §2）', async () => {
    test.skip(state().target === 'mock', 'mock 不模拟安全头');
    const r = await call('GET', '/health');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
