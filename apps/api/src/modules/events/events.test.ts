import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKit, cmd, fresh, SKUS, WH1, WH2, type Kit } from '../inventory/testkit.ts';

/** 端口取自 ws-a2 额外端口段 4830–4899 */
const PORT = 4831;
const base = `http://127.0.0.1:${PORT}/api/v1`;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwtLike = (exp: number) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'x', exp })}.sig`;

interface Frame {
  event: string;
  data: unknown;
}

/** 读取 SSE 流：收集帧，直到流结束。 */
function readSse(res: Response) {
  const frames: Frame[] = [];
  let buf = '';
  const decoder = new TextDecoder();
  const done = (async () => {
    const reader = res.body!.getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) return;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) frames.push({ event: ev, data: JSON.parse(data) });
      }
    }
  })();
  return { frames, done };
}

async function waitFor(pred: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('SSE /events（真实端口）', () => {
  let k: Kit;
  beforeAll(async () => {
    k = await createKit();
    await k.app.listen({ port: PORT, host: '127.0.0.1' });
  });
  afterAll(async () => k?.close());

  it('登录 → 订阅 → 交易 → 收到 stock.changed{layoutVersion}；令牌 exp 到达时服务端关流', async () => {
    const token = jwtLike(Math.floor(Date.now() / 1000) + 3);
    k.auth.set(token, k.auth.get('op1')!);
    const t0 = Date.now();
    const res = await fetch(`${base}/events?warehouseId=${WH1}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const s = readSse(res);
    const L = fresh();
    const r = await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: SKUS[2]!.id, qty: 3 }]));
    expect(r.statusCode).toBe(201);
    await waitFor(() => s.frames.some((f) => f.event === 'stock.changed'));
    const f = s.frames.find((x) => x.event === 'stock.changed')!;
    expect(f.data).toMatchObject({ layoutVersion: 1, locationIds: [L], txnId: r.json().txn.id });
    await s.done; // 服务端在 exp 关流
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(6000);
  }, 15_000);

  it('只推送本仓事件；未授权仓库 404；无令牌 401；已过期令牌立即关流', async () => {
    const token = jwtLike(Math.floor(Date.now() / 1000) + 2);
    k.auth.set(token, k.auth.get('viewer')!);
    const res = await fetch(`${base}/events?warehouseId=${WH1}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const s = readSse(res);
    k.app.services.bus.publish(WH2, { event: 'layout.published', data: { layoutVersion: 9 } });
    k.app.services.bus.publish(WH1, { event: 'reprint.created', data: { count: 1 } });
    await s.done;
    expect(s.frames.map((x) => x.event)).toEqual(['reprint.created']);

    expect(
      (
        await fetch(`${base}/events?warehouseId=${WH2}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${base}/events?warehouseId=${WH1}`)).status).toBe(401);
    const expired = jwtLike(Math.floor(Date.now() / 1000) - 1);
    k.auth.set(expired, k.auth.get('viewer')!);
    const r3 = await fetch(`${base}/events?warehouseId=${WH1}`, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(await r3.text()).toBe('');
  }, 15_000);

  it('断开后取消订阅（无监听泄漏）', async () => {
    const token = jwtLike(Math.floor(Date.now() / 1000) + 60);
    k.auth.set(token, k.auth.get('viewer')!);
    const ac = new AbortController();
    const res = await fetch(`${base}/events?warehouseId=${WH1}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ac.signal,
    });
    const s = readSse(res);
    const bus = k.app.services.bus as unknown as { ee: import('node:events').EventEmitter };
    await waitFor(() => bus.ee.listenerCount(WH1) === 1);
    ac.abort();
    await s.done.catch(() => undefined);
    await waitFor(() => bus.ee.listenerCount(WH1) === 0);
  });

  it('登出或撤销仓库授权后 SSE 立即关流，不再推送 stock.changed（CR1 #1）', async () => {
    const token = jwtLike(Math.floor(Date.now() / 1000) + 120);
    k.auth.set(token, k.auth.get('op1')!);
    const res = await fetch(`${base}/events?warehouseId=${WH1}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const s = readSse(res);
    const logout = await k.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect([200, 204]).toContain(logout.statusCode);
    await s.done;
    const L = fresh();
    const r = await k.txn('op1', cmd('INBOUND', [{ locationId: L, skuId: SKUS[2]!.id, qty: 1 }]));
    expect([200, 201]).toContain(r.statusCode);
    await new Promise((x) => setTimeout(x, 150));
    expect(s.frames.some((f) => f.event === 'stock.changed')).toBe(false);

    const token2 = jwtLike(Math.floor(Date.now() / 1000) + 120);
    k.auth.set(token2, k.auth.get('op1')!);
    const res2 = await fetch(`${base}/events?warehouseId=${WH1}`, {
      headers: { authorization: `Bearer ${token2}` },
    });
    const s2 = readSse(res2);
    k.app.services.bus.invalidateAuth({
      revokeWarehouses: { userId: k.auth.get('op1')!.userId, warehouseIds: [WH1] },
    });
    await s2.done;
  }, 15_000);
});
