import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { demo } from '@wms3d/domain';
import { createMockApi, type MockApi } from '@wms3d/api-client/mock';
import { createInprocFetch, type InprocNet } from '../dev/inproc-fetch.ts';
import { toEnqueue } from './commit.ts';
import { MasterData, MemoryMasterPersistence } from './masterdata.ts';
import {
  backoffMs,
  classify,
  Outbox,
  WAITING_STOCK_MAX_MS,
  WAITING_STOCK_RETRY_MS,
} from './outbox.ts';
import { MemoryOutboxStore, type OutboxStore } from './outbox-types.ts';
import { SqliteOutboxStore, type SqlConn } from './outbox-sqlite.ts';
import { MemorySecureStore, Session } from './session.ts';
import * as wf from './workflow.ts';
import { ApiError } from '@wms3d/api-client';

const WH1 = demo.demoWarehouse.id;
const PW = 'Wms3d#demo';

interface Rig {
  mock: MockApi;
  net: InprocNet;
  clock: { t: number };
  session: Session;
  outbox: Outbox;
  store: OutboxStore;
  md: MasterData;
  rejected: string[];
  blocked: (string | null)[];
}

function rig(store: OutboxStore = new MemoryOutboxStore(), deviceId = 'dev-test-0001'): Rig {
  const clock = { t: Date.parse('2026-11-12T09:00:00Z') };
  const mock = createMockApi({ now: () => new Date(clock.t) });
  const net: InprocNet = { offline: false, requests: 0 };
  const f = createInprocFetch(mock, net);
  const session = new Session({
    baseUrl: '',
    deviceId,
    appVersion: '0.1.0',
    secure: new MemorySecureStore(),
    fetch: f,
  });
  const rejected: string[] = [];
  const blocked: (string | null)[] = [];
  const outbox = new Outbox(
    store,
    () => session.api,
    () => clock.t,
    { rejected: (e) => rejected.push(e.lastError!.code), authBlocked: (r) => blocked.push(r) },
    { autoSchedule: false },
  );
  const md = new MasterData(new MemoryMasterPersistence(), WH1, 'WH1', ['WH1', 'WH2']);
  return { mock, net, clock, session, outbox, store, md, rejected, blocked };
}

async function loggedIn(r: Rig, user = 'op1') {
  const s = await r.session.login(user, PW);
  await r.outbox.init();
  await r.md.sync(r.session.api);
  return s;
}

function scanAll(r: Rig, mode: wf.Mode, codes: string[]) {
  let st = wf.initialState(mode);
  const effects: wf.Effect[] = [];
  for (const c of codes) {
    const step = wf.onScan(st, r.md.resolveLocal(c), 'HID');
    st = step.state;
    effects.push(...step.effects);
  }
  return { st, effects };
}

const commits = (effects: wf.Effect[]) =>
  effects
    .filter((e): e is Extract<wf.Effect, { type: 'commit' }> => e.type === 'commit')
    .map((e) => e.commit);

describe('主数据同步与本地解析', () => {
  it('首次全量分页 + 进度；本地解析仓位/货架/SKU/外仓/未知', async () => {
    const r = rig();
    await r.session.login('op1', PW);
    expect(r.md.ready).toBe(false);
    const progress: number[] = [];
    await r.md.sync(r.session.api, (d) => progress.push(d));
    expect(r.md.ready).toBe(true);
    expect(progress.length).toBeGreaterThan(1);
    expect(r.md.counts.locations).toBe(386);
    expect(r.md.resolveLocal('WH1.A01-01-A01')).toMatchObject({
      kind: 'LOCATION',
      loc: { code: 'A01-01-A01' },
    });
    expect(r.md.resolveLocal('a01-01-a01').kind).toBe('LOCATION');
    expect(r.md.resolveLocal('WH1.RA01-L01').kind).toBe('RACK');
    expect(r.md.resolveLocal('SKU-001-CASE12')).toMatchObject({
      kind: 'SKU',
      packQty: 12,
      sku: { code: 'SKU-001' },
    });
    expect(r.md.resolveLocal('WH2.A01-01-A01')).toMatchObject({
      kind: 'WRONG_WAREHOUSE',
      other: 'WH2',
    });
    expect(r.md.resolveLocal('NOPE-123').kind).toBe('UNKNOWN');
    expect(await r.md.checkDigest(r.session.api)).toBe(true);
  });
  it('增量同步沿用游标；离线解析未知码 → offline=true', async () => {
    const r = rig();
    await loggedIn(r);
    const cur = r.md.snap.cursor;
    await r.md.sync(r.session.api);
    expect(r.md.snap.cursor).toBe(cur);
    r.net.offline = true;
    expect(await r.md.resolve(r.session.api, 'NEW-BARCODE')).toMatchObject({
      kind: 'UNKNOWN',
      offline: true,
    });
  });
  it('持久化后可离线加载', async () => {
    const p = new MemoryMasterPersistence();
    const r = rig();
    await r.session.login('op1', PW);
    const md = new MasterData(p, WH1, 'WH1', ['WH1']);
    await md.sync(r.session.api);
    const md2 = new MasterData(p, WH1, 'WH1', ['WH1']);
    expect(await md2.load()).toBe(true);
    expect(md2.ready).toBe(true);
    expect(md2.resolveLocal('WH1.A01-01-A02').kind).toBe('LOCATION');
  });
});

describe('作业状态机（04 §3.7 意外码表）', () => {
  let r: Rig;
  beforeEach(async () => {
    r = rig();
    await loggedIn(r);
  });
  const L1 = 'WH1.A01-01-A01';
  const L2 = 'WH1.A01-01-A02';
  const S1 = '6900010000004';
  const S1CASE = 'SKU-001-CASE12';
  const S2 = '6900010000370';

  it('等待仓位：仓位→等待SKU；货架/SKU 提示；外仓/未知 错误', () => {
    const s0 = wf.initialState('PUTAWAY');
    const res = (c: string) => wf.onScan(s0, r.md.resolveLocal(c), 'HID');
    expect(res(L1).state.phase).toBe('WAIT_SKU');
    expect(res('WH1.RA01-L01').effects[0]).toMatchObject({
      type: 'hint',
      message: expect.stringContaining('货架'),
    });
    expect(res(S1).effects[0]).toMatchObject({ type: 'hint', message: '请先扫仓位' });
    expect(res('WH2.A01-01-A01').effects[0]).toMatchObject({
      type: 'error',
      code: 'WRONG_WAREHOUSE',
    });
    expect(res('XYZ-0').effects[0]).toMatchObject({ type: 'error', code: 'UNKNOWN_BARCODE' });
  });
  it('停用仓位：等待仓位/等待SKU 报错；待确认时先提交后报错', () => {
    const inactive: wf.Step['state']['location'] = null;
    void inactive;
    const off = {
      kind: 'LOCATION' as const,
      raw: 'x',
      loc: { id: 'L-off', code: 'Z99', isActive: false },
    };
    expect(wf.onScan(wf.initialState('PUTAWAY'), off, 'HID').effects[0]).toMatchObject({
      code: 'LOCATION_INACTIVE',
    });
    const { st } = scanAll(r, 'PUTAWAY', [L1, S1]);
    const step = wf.onScan(st, off, 'HID');
    expect(step.effects.map((e) => e.type)).toEqual(['commit', 'error']);
    expect(step.state.phase).toBe('WAIT_SKU');
    expect(step.state.location?.code).toBe('A01-01-A01');
  });
  it('连续上架：同 SKU 累加 packQty；异 SKU 先提交；扫仓位先提交后切换（仓位粘滞）', () => {
    const { st, effects } = scanAll(r, 'PUTAWAY', [L1, S1, S1, S1CASE, S2, L2, S2]);
    const c = commits(effects);
    expect(c.map((x) => [x.location.code, x.line.sku?.code, x.line.qty])).toEqual([
      ['A01-01-A01', 'SKU-001', 14],
      ['A01-01-A01', 'SKU-002', 1],
    ]);
    expect(st.phase).toBe('PENDING');
    expect(st.location?.code).toBe('A01-01-A02');
    const done = wf.confirm(st);
    expect(commits(done.effects)[0]).toMatchObject({
      location: { code: 'A01-01-A02' },
      line: { qty: 1 },
    });
    expect(done.state.phase).toBe('WAIT_SKU');
  });
  it('待确认：货架提示不提交；外仓/未知错误不提交', () => {
    const { st } = scanAll(r, 'PUTAWAY', [L1, S1]);
    for (const c of ['WH1.RA01-L01', 'WH2.A01-01-A01', 'XYZ-0']) {
      const step = wf.onScan(st, r.md.resolveLocal(c), 'HID');
      expect(step.effects.some((e) => e.type === 'commit')).toBe(false);
      expect(step.state).toBe(st);
    }
  });
  it('相机来源：同 SKU 不累加（提示用数量键盘）；setQty 生效', () => {
    let st = wf.onScan(wf.initialState('PUTAWAY'), r.md.resolveLocal(L1), 'CAMERA').state;
    st = wf.onScan(st, r.md.resolveLocal(S1), 'CAMERA').state;
    const again = wf.onScan(st, r.md.resolveLocal(S1), 'CAMERA');
    expect(again.effects[0]).toMatchObject({ type: 'hint' });
    expect(again.state.pending?.qty).toBe(1);
    expect(wf.setQty(st, 7).pending?.qty).toBe(7);
    expect(wf.setQty(st, 0).pending?.qty).toBe(1);
    expect(wf.cancelPending(st).phase).toBe('WAIT_SKU');
  });
  it('离线未知条码：等待SKU 时暂存原文；在线未知报错', () => {
    let st = wf.onScan(wf.initialState('PUTAWAY'), r.md.resolveLocal(L1), 'HID').state;
    const off = wf.onScan(st, { kind: 'UNKNOWN', raw: 'NEW-1', offline: true }, 'HID');
    expect(off.state.pending).toMatchObject({ sku: null, rawBarcode: 'NEW-1', qty: 1 });
    st = off.state;
    st = wf.onScan(st, { kind: 'UNKNOWN', raw: 'NEW-1', offline: true }, 'HID').state;
    expect(st.pending?.qty).toBe(2);
    const on = wf.onScan(
      wf.cancelPending(st),
      { kind: 'UNKNOWN', raw: 'NEW-2', offline: false },
      'HID',
    );
    expect(on.effects[0]).toMatchObject({ type: 'error', code: 'UNKNOWN_BARCODE' });
  });
  it('移库：源仓位 → SKU → 目标仓位提交；等待目标时 SKU 提示、同仓位提示', () => {
    const { st, effects } = scanAll(r, 'TRANSFER', [L1, S1]);
    expect(st.phase).toBe('WAIT_TARGET');
    expect(wf.onScan(st, r.md.resolveLocal(S2), 'HID').effects[0]).toMatchObject({
      type: 'hint',
      message: expect.stringContaining('目标仓位'),
    });
    expect(wf.onScan(st, r.md.resolveLocal(L1), 'HID').effects[0]).toMatchObject({ type: 'hint' });
    expect(wf.onScan(st, r.md.resolveLocal('WH1.RA01-L01'), 'HID').effects[0]).toMatchObject({
      type: 'hint',
    });
    expect(wf.onScan(st, r.md.resolveLocal('XYZ'), 'HID').effects[0]).toMatchObject({
      type: 'error',
    });
    const fin = wf.onScan(st, r.md.resolveLocal(L2), 'HID');
    const c = commits(fin.effects)[0]!;
    expect([c.location.code, c.target?.code, c.line.qty]).toEqual(['A01-01-A01', 'A01-01-A02', 1]);
    expect(fin.state.phase).toBe('WAIT_SKU');
    expect(effects.filter((e) => e.type === 'commit')).toHaveLength(0);
    expect(wf.prompt(fin.state)).toContain('源仓位');
  });
  it('toEnqueue：skuId 用件数；原文条码用 skuBarcode', () => {
    const { effects, st } = scanAll(r, 'PICK', [L1, S1, L2]);
    const ctx = { warehouseId: WH1, performedBy: 'u', performerSessionId: 's', online: false };
    const e = toEnqueue(commits(effects)[0]!, ctx);
    expect(e).toMatchObject({ type: 'OUTBOUND', createdOffline: true });
    expect(e.lines[0]).toMatchObject({ skuId: expect.any(String), qty: 1 });
    const raw = wf.onScan(st, { kind: 'UNKNOWN', raw: 'NEW-9', offline: true }, 'HID').state;
    expect(toEnqueue(commits(wf.confirm(raw).effects)[0]!, ctx).lines[0]).toMatchObject({
      skuBarcode: 'NEW-9',
    });
  });
});

describe('离线队列（ADR-0007，03 §3.1 处理矩阵）', () => {
  let r: Rig;
  let sess: Awaited<ReturnType<typeof loggedIn>>;
  beforeEach(async () => {
    r = rig();
    sess = await loggedIn(r);
  });
  const enqueue = (code: string, sku: string, mode: wf.Mode = 'PUTAWAY', online = true) => {
    const { effects } = scanAll(r, mode, [code, sku, code]);
    return r.outbox.enqueue(
      toEnqueue(commits(effects)[0]!, {
        warehouseId: WH1,
        performedBy: r.session.current!.user.id,
        performerSessionId: r.session.current!.sessionId,
        online,
      }),
    );
  };

  it('在线：入队即 PENDING（灰勾），发送后 DONE（绿勾），幂等键 = id；同键重放 replayed', async () => {
    const e = await enqueue('WH1.A01-01-A01', '6900010000004');
    expect(e.status).toBe('PENDING');
    expect(e.payload).not.toHaveProperty('deviceId');
    expect(e.payload).toMatchObject({ performerSessionId: sess.sessionId, createdOffline: false });
    expect(await r.outbox.drain()).toBe(1);
    const done = (await r.store.get(e.id))!;
    expect(done.status).toBe('DONE');
    expect(done.txnId).toBeTruthy();
    const txn = r.mock.store.txns.find((t) => t.idempotencyKey === e.id)!;
    expect(txn.deviceId).toBe('dev-test-0001');
    const replay = await r.session.api.r.postTransaction({ body: e.payload, idempotencyKey: e.id });
    expect(replay.replayed).toBe(true);
  });

  it('离线 10 单 → 网络恢复后按顺序全部同步', async () => {
    r.net.offline = true;
    const ids: string[] = [];
    for (let i = 0; i < 10; i++)
      ids.push((await enqueue('WH1.A01-01-A02', '6900010000370', 'PUTAWAY', false)).id);
    expect(await r.outbox.drain()).toBe(1); // 第一单网络失败 → 退避
    expect((await r.store.get(ids[0]!))!.status).toBe('PENDING');
    expect((await r.store.get(ids[0]!))!.attempts).toBe(1);
    expect(await r.outbox.pendingCount()).toBe(10);
    r.net.offline = false;
    r.clock.t += backoffMs(1);
    expect(await r.outbox.drain()).toBe(10);
    expect(await r.outbox.pendingCount()).toBe(0);
    const keys = r.mock.store.txns.filter((t) => t.createdOffline).map((t) => t.idempotencyKey);
    expect(keys).toEqual(ids);
  });

  it('退避 1s→60s', () => {
    expect([1, 2, 3, 7, 20].map(backoffMs)).toEqual([1000, 2000, 4000, 60000, 60000]);
  });

  it('令牌失效且刷新失败 → BLOCKED_AUTH，暂停；重新登录后继续，不进异常单', async () => {
    // 服务端结束会话（等价于过期/撤销）：access 与 refresh 都失效
    r.mock.store.sessions.get(sess.sessionId)!.endedAt = new Date(r.clock.t).toISOString();
    const a = await enqueue('WH1.A01-01-A01', '6900010000004');
    const b = await enqueue('WH1.A01-01-B01', '6900010000004');
    await r.outbox.drain();
    expect((await r.store.get(a.id))!.status).toBe('BLOCKED_AUTH');
    expect((await r.store.get(b.id))!.status).toBe('BLOCKED_AUTH');
    expect(r.outbox.authBlocked).toBe('UNAUTHENTICATED');
    expect(r.rejected).toEqual([]);
    const c = await enqueue('WH1.A01-01-B02', '6900010000004');
    expect(c.status).toBe('BLOCKED_AUTH');
    await r.session.login('op1', PW);
    await r.outbox.resumeAuth();
    await r.outbox.drain();
    expect((await r.outbox.list()).map((e) => e.status)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(r.blocked).toEqual(['UNAUTHENTICATED', null]);
  });

  it('access 过期但 refresh 有效：single-flight 刷新后透明重发', async () => {
    r.session.dropAccessToken();
    const e = await enqueue('WH1.A01-01-A01', '6900010000004');
    await r.outbox.drain();
    expect((await r.store.get(e.id))!.status).toBe('DONE');
  });

  it('换班代交：A 的离线单由 B 的令牌补传成功（performedBy=A，submittedBy=B）', async () => {
    r.net.offline = true;
    const a = await enqueue('WH1.A01-01-A01', '6900010000004', 'PUTAWAY', false);
    r.net.offline = false;
    await r.session.logout();
    const b = await r.session.login('op2', PW);
    await r.outbox.drain();
    expect((await r.store.get(a.id))!.status).toBe('DONE');
    const txn = r.mock.store.txns.find((t) => t.idempotencyKey === a.id)!;
    expect(txn.performedBy).toBe(sess.user.id);
    expect(txn.submittedBy).toBe(b.user.id);
  });

  it('伪造代交（performerSessionId 不属于 performedBy）→ 403 PERFORMER_NOT_ALLOWED → REJECTED，不阻塞后续', async () => {
    const forged = await r.outbox.enqueue({
      type: 'INBOUND',
      warehouseId: WH1,
      performedBy: demo.demoUsers.find((u) => u.username === 'op2')!.id,
      performerSessionId: sess.sessionId,
      lines: [{ locationCode: 'WH1.A01-01-A01', skuBarcode: '6900010000004', qty: 1 }],
      createdOffline: true,
      label: 'forged',
    });
    const ok = await enqueue('WH1.A01-01-A02', '6900010000370');
    await r.outbox.drain();
    expect((await r.store.get(forged.id))!).toMatchObject({
      status: 'REJECTED',
      lastError: { code: 'PERFORMER_NOT_ALLOWED', status: 403 },
    });
    expect((await r.store.get(ok.id))!.status).toBe('DONE');
    expect(r.rejected).toEqual(['PERFORMER_NOT_ALLOWED']);
  });

  it('库存不足：离线单 → WAITING_STOCK（2 分钟重试，24h 超时转 REJECTED）；在线单 → REJECTED 可“稍后自动重试”', async () => {
    const off = await enqueue('WH1.A01-01-A02', '6900010000004', 'PICK', false);
    await r.outbox.drain();
    let e = (await r.store.get(off.id))!;
    expect(e.status).toBe('WAITING_STOCK');
    expect(e.nextAttemptAt - r.clock.t).toBe(WAITING_STOCK_RETRY_MS);
    // 跨设备乱序：货其实已上架 → 稍后成功
    await enqueue('WH1.A01-01-A02', '6900010000004', 'PUTAWAY');
    await r.outbox.drain();
    r.clock.t += WAITING_STOCK_RETRY_MS;
    await r.outbox.drain();
    expect((await r.store.get(off.id))!.status).toBe('DONE');

    const off2 = await enqueue('WH1.A01-01-B01', '6900010000004', 'PICK', false);
    await r.outbox.drain();
    r.clock.t += WAITING_STOCK_MAX_MS;
    await r.outbox.drain();
    expect((await r.store.get(off2.id))!.status).toBe('REJECTED');

    const on = await enqueue('WH1.A01-01-B02', '6900010000004', 'PICK', true);
    await r.outbox.drain();
    e = (await r.store.get(on.id))!;
    expect(e).toMatchObject({ status: 'REJECTED', canAutoRetry: true });
    await r.outbox.autoRetryLater(on.id);
    expect((await r.store.get(on.id))!.status).toBe('WAITING_STOCK');
  });

  it('业务拒绝不阻塞；同仓位+SKU 后续单标“可能受影响”', async () => {
    const loc = r.mock.store.locations.get(
      r.md.resolveLocal('WH1.A01-01-A01').kind === 'LOCATION'
        ? (r.md.resolveLocal('WH1.A01-01-A01') as { loc: { id: string } }).loc.id
        : '',
    )!;
    const bad = await enqueue('WH1.A01-01-A01', '6900010000004');
    const same = await enqueue('WH1.A01-01-A01', '6900010000004');
    const other = await enqueue('WH1.A01-01-A02', '6900010000004');
    loc.isActive = false;
    r.net.offline = true;
    await r.outbox.drain();
    r.net.offline = false;
    r.clock.t += 1000;
    // 只让第一单被拒：发送第一单后恢复仓位
    const s1 = r.outbox;
    await (async () => {
      const list = await r.store.list(['PENDING']);
      expect(list).toHaveLength(3);
    })();
    // 逐条：先 drain 一条（仓位停用）
    const orig = r.session.api.r.postTransaction;
    let n = 0;
    r.session.api.r.postTransaction = async (a) => {
      n++;
      if (n === 2) loc.isActive = true;
      return orig(a);
    };
    await s1.drain();
    expect((await r.store.get(bad.id))!.lastError?.code).toBe('LOCATION_INACTIVE');
    expect((await r.store.get(same.id))!.mayBeAffected).toBe(true);
    expect((await r.store.get(other.id))!.mayBeAffected).toBe(false);
    expect((await r.store.get(other.id))!.status).toBe('DONE');
    // 异常单：重试（新键）
    const re = await r.outbox.retryWithNewKey(bad.id);
    expect(re!.id).not.toBe(bad.id);
    await r.outbox.drain();
    expect((await r.store.get(re!.id))!.status).toBe('DONE');
    expect((await r.store.get(bad.id))!.status).toBe('CANCELLED');
  });

  it('撤销：未发送 → 作废；已确认 → 冲正', async () => {
    r.net.offline = true;
    const a = await enqueue('WH1.A01-01-A01', '6900010000004');
    expect(await r.outbox.undo(a.id)).toBe('cancelled');
    r.net.offline = false;
    const b = await enqueue('WH1.A01-01-A01', '6900010000004');
    await r.outbox.drain();
    expect(await r.outbox.undo(b.id)).toBe('reversed');
    expect(r.mock.store.txns.some((t) => t.type === 'REVERSAL')).toBe(true);
    expect((await r.outbox.list()).map((e) => e.status)).toEqual(['CANCELLED', 'CANCELLED']);
  });

  it('classify：5xx/429/网络 → 重试；改密 → 暂停；设备禁用 → 拒绝；键复用 → 上报', () => {
    const e = (status: number, code: string) => new ApiError(status, code as never, null);
    expect(classify(e(503, 'INTERNAL'), false).kind).toBe('retry');
    expect(classify(e(429, 'RATE_LIMITED'), false).kind).toBe('retry');
    expect(classify(new Error('x'), false).kind).toBe('retry');
    expect(classify(e(403, 'PASSWORD_CHANGE_REQUIRED'), false)).toEqual({
      kind: 'auth',
      reason: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(classify(e(403, 'DEVICE_DISABLED'), false).kind).toBe('rejected');
    expect(classify(e(409, 'IDEMPOTENCY_KEY_REUSED'), false)).toMatchObject({ report: true });
  });

  it('init：崩溃遗留 SENDING → PENDING；导出 JSON', async () => {
    const e = await enqueue('WH1.A01-01-A01', '6900010000004');
    await r.store.put({ ...e, status: 'SENDING' });
    await r.outbox.init();
    expect((await r.store.get(e.id))!.status).toBe('PENDING');
    expect(JSON.parse(await r.outbox.exportJson()).items).toHaveLength(1);
  });
});

describe('SQLite outbox（node:sqlite 跑同一套 SQL）', () => {
  let db: DatabaseSync;
  const conn = (): SqlConn => ({
    execute: async (sql) => db.exec(sql),
    run: async (sql, v) => {
      db.prepare(sql).run(...(v as never[]));
    },
    query: async (sql, v) => db.prepare(sql).all(...(v as never[])) as never,
  });
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
  });
  afterEach(() => db.close());

  it('完整队列流程在 SQLite 上同样成立（离线 → 恢复、换班代交）', async () => {
    const store = new SqliteOutboxStore(conn());
    const r = rig(store);
    await loggedIn(r);
    r.net.offline = true;
    for (let i = 0; i < 3; i++) {
      const { effects } = scanAll(r, 'PUTAWAY', [
        'WH1.A01-01-A01',
        '6900010000004',
        'WH1.A01-01-A01',
      ]);
      await r.outbox.enqueue(
        toEnqueue(commits(effects)[0]!, {
          warehouseId: WH1,
          performedBy: r.session.current!.user.id,
          performerSessionId: r.session.current!.sessionId,
          online: false,
        }),
      );
    }
    await r.session.logout();
    r.net.offline = false;
    await r.session.login('op2', PW);
    await r.outbox.drain();
    const all = await store.list();
    expect(all.map((e) => e.status)).toEqual(['DONE', 'DONE', 'DONE']);
    expect(all[0]!.createdOffline).toBe(true);
    expect(typeof all[0]!.payload).toBe('object');
    expect(await store.purgeFinished(Date.now() + 10 * 24 * 3600_000)).toBe(3);
    expect(await store.list()).toEqual([]);
  });
});
