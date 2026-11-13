import type {
  ParsedBody,
  ParsedParams,
  ParsedQuery,
  Role,
  RouteResponse,
  Routes,
  WmsEvent,
} from '@wms3d/contracts';
import { CONTRACT_VERSION } from '@wms3d/contracts';
import { classifyScan, compilePattern, expandLayout, validateLayout } from '@wms3d/domain';
import {
  balanceKey,
  type MCount,
  type MCountLine,
  type MLocation,
  type MSku,
  type MTxn,
  type MTxnLine,
  type MUser,
  type MWarehouse,
  type MockStore,
} from './store.ts';
import { byteCompare, MockError, raw, sha256Hex, type MockResponse } from './util.ts';

export interface MockAuth {
  userId: string;
  role: Role;
  deviceId: string;
  sessionId: string;
  mustChangePassword: boolean;
  exp: number;
}

interface Tokens {
  access(a: Omit<MockAuth, 'exp'>): { token: string; expiresIn: number };
  refresh(a: { userId: string; deviceId: string; sessionId: string }): string;
  parseRefresh(
    t: string | undefined,
  ): { userId: string; deviceId: string; sessionId: string } | null;
}

export interface Ctx<K extends keyof Routes> {
  store: MockStore;
  auth: Routes[K]['roles'] extends 'public' ? MockAuth | null : MockAuth;
  params: ParsedParams<Routes[K]>;
  query: ParsedQuery<Routes[K]>;
  body: ParsedBody<Routes[K]>;
  headers: Record<string, string>;
  warehouseId: string | null;
  tokens: Tokens;
  emit(warehouseId: string, e: WmsEvent): void;
  idempotencyKey: string | null;
  ifMatch: number | null;
}
type Out<K extends keyof Routes> = RouteResponse<Routes[K]> | { __mock: MockResponse };
type Handlers = { [K in keyof Routes]?: (ctx: Ctx<K>) => Out<K> | Promise<Out<K>> };

// ---------- 视图 ----------
function paginate<T>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): { items: T[]; nextCursor: string | null } {
  const start = cursor ? Number(cursor) || 0 : 0;
  const slice = items.slice(start, start + limit);
  return { items: slice, nextCursor: start + limit < items.length ? String(start + limit) : null };
}
const whRef = (w: MWarehouse) => ({ id: w.id, code: w.code, name: w.name });
function userWarehouses(s: MockStore, u: MUser) {
  return [...s.warehouses.values()]
    .filter((w) => u.allWarehouses || u.warehouseIds.includes(w.id))
    .map(whRef);
}
function userView(s: MockStore, u: MUser) {
  const { password: _p, warehouseIds: _w, ...rest } = u;
  return { ...rest, warehouses: userWarehouses(s, u) };
}
function meView(s: MockStore, u: MUser) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    allWarehouses: u.allWarehouses,
    warehouses: userWarehouses(s, u),
    mustChangePassword: u.mustChangePassword,
  };
}
function warehouseView(s: MockStore, w: MWarehouse) {
  const locked = [...s.locations.values()].some((l) => l.warehouseId === w.id);
  return { ...w, locationCodePatternLocked: locked };
}
function locationView(l: MLocation) {
  const { rackKey: _r, defaultMax, ...rest } = l;
  return { ...rest, effectiveMax: l.maxQty ?? defaultMax };
}
function skuView(s: MSku) {
  return { ...s, barcodes: s.barcodes.map(({ updatedAt: _u, ...b }) => b) };
}
const userName = (s: MockStore, id: string | null) =>
  id ? (s.users.get(id)?.displayName ?? null) : null;
function txnView(s: MockStore, t: MTxn) {
  const { requestHash: _h, ...rest } = t;
  return {
    ...rest,
    performedByName: userName(s, t.performedBy),
    submittedByName: userName(s, t.submittedBy),
  };
}
function need<T>(v: T | undefined | null, what = '资源'): T {
  if (v === undefined || v === null) throw new MockError('NOT_FOUND', `${what}不存在`);
  return v;
}
function wh(s: MockStore, id: string | null): MWarehouse {
  return need(id ? s.warehouses.get(id) : undefined, '仓库');
}

// ---------- 库存（简化版 02 §6） ----------
function findLocation(
  s: MockStore,
  w: MWarehouse,
  ref: { locationId?: string | undefined; locationCode?: string | undefined },
): MLocation {
  if (ref.locationId) {
    const l = s.locations.get(ref.locationId);
    if (!l || l.warehouseId !== w.id) throw new MockError('NOT_FOUND', '仓位不存在');
    return l;
  }
  let code = (ref.locationCode ?? '').toUpperCase();
  const dot = code.indexOf('.');
  if (dot > 0) {
    if (code.slice(0, dot) !== w.code)
      throw new MockError('WRONG_WAREHOUSE', `不是本仓库（${code.slice(0, dot)}）的仓位`);
    code = code.slice(dot + 1);
  }
  const l = [...s.locations.values()].find((x) => x.warehouseId === w.id && x.code === code);
  if (!l) throw new MockError('UNKNOWN_BARCODE', `未知仓位 ${ref.locationCode}`);
  return l;
}
function findSku(
  s: MockStore,
  ref: { skuId?: string | undefined; skuBarcode?: string | undefined },
): { sku: MSku; packQty: number } {
  if (ref.skuId) return { sku: need(s.skus.get(ref.skuId), 'SKU'), packQty: 1 };
  for (const sku of s.skus.values()) {
    const b = sku.barcodes.find((x) => x.barcode === ref.skuBarcode);
    if (b) return { sku, packQty: b.packQty };
  }
  throw new MockError('UNKNOWN_BARCODE', `未知条码 ${ref.skuBarcode}`);
}

interface Delta {
  loc: MLocation;
  sku: MSku;
  qty: number;
}
function applyDeltas(
  s: MockStore,
  w: MWarehouse,
  deltas: Delta[],
  opts: { force?: boolean; checkCapacity?: boolean; rejectInactiveSku?: boolean },
): MTxnLine[] {
  // 先整体校验再写入（原子）
  const next = new Map<string, number>();
  for (const d of deltas) {
    if (!d.loc.isActive && d.qty > 0)
      throw new MockError('LOCATION_INACTIVE', `${d.loc.code} 已停用`);
    if (opts.rejectInactiveSku && d.qty > 0 && !d.sku.isActive)
      throw new MockError('SKU_INACTIVE', `${d.sku.code} 已停用`);
    const k = balanceKey(d.loc.id, d.sku.id);
    const cur = next.get(k) ?? s.balances.get(k)?.onHand ?? 0;
    const after = cur + d.qty;
    if (after < 0)
      throw new MockError('INSUFFICIENT_STOCK', `${d.loc.code} / ${d.sku.code} 库存不足`, {
        context: { locationId: d.loc.id, skuId: d.sku.id, onHand: cur, requested: -d.qty },
      });
    next.set(k, after);
  }
  if (opts.checkCapacity && !opts.force) {
    for (const d of deltas) {
      if (d.qty <= 0) continue;
      const max = d.loc.maxQty ?? d.loc.defaultMax;
      if (max === null) continue;
      let total = 0;
      for (const [k, v] of s.balances)
        if (k.startsWith(`${d.loc.id}|`) && !next.has(k)) total += v.onHand;
      for (const [k, v] of next) if (k.startsWith(`${d.loc.id}|`)) total += v;
      if (total > max)
        throw new MockError('LOCATION_CAPACITY_EXCEEDED', `${d.loc.code} 超出容量 ${max}`);
      if (!w.allowMixedSku) {
        const others = [...s.balances.values()].some(
          (b) => b.locationId === d.loc.id && b.skuId !== d.sku.id && b.onHand > 0,
        );
        if (others) throw new MockError('MIXED_SKU_NOT_ALLOWED');
      }
    }
  }
  const at = s.iso();
  return deltas.map((d) => {
    const k = balanceKey(d.loc.id, d.sku.id);
    const prev = s.balances.get(k)?.onHand ?? 0;
    const onHand = prev + d.qty;
    s.balances.set(k, {
      warehouseId: w.id,
      locationId: d.loc.id,
      skuId: d.sku.id,
      lotNo: '',
      onHand,
      updatedAt: at,
    });
    return {
      locationId: d.loc.id,
      locationCode: d.loc.code,
      skuId: d.sku.id,
      skuCode: d.sku.code,
      lotNo: '',
      qtyDelta: d.qty,
      balanceAfter: onHand,
    };
  });
}
function recordTxn(
  s: MockStore,
  t: Omit<MTxn, 'id' | 'createdAt' | 'reversedByTxnId'>,
  emit: Ctx<'postTransaction'>['emit'],
): MTxn {
  const txn: MTxn = { ...t, id: s.newId('txn'), createdAt: s.iso(), reversedByTxnId: null };
  s.txns.push(txn);
  for (const l of txn.lines) {
    s.movements.push({
      id: s.movements.length + 1,
      txnId: txn.id,
      txnType: txn.type,
      warehouseId: txn.warehouseId,
      ...l,
      performedBy: txn.performedBy,
      createdAt: txn.createdAt,
    });
  }
  const w = s.warehouses.get(txn.warehouseId)!;
  emit(txn.warehouseId, {
    event: 'stock.changed',
    data: {
      layoutVersion: w.publishedLayoutVersion ?? 0,
      locationIds: [...new Set(txn.lines.map((l) => l.locationId))],
      txnId: txn.id,
    },
  });
  return txn;
}
function balancesAfter(lines: MTxnLine[]) {
  const m = new Map<string, { locationId: string; skuId: string; lotNo: string; onHand: number }>();
  for (const l of lines)
    m.set(balanceKey(l.locationId, l.skuId), {
      locationId: l.locationId,
      skuId: l.skuId,
      lotNo: '',
      onHand: l.balanceAfter,
    });
  return [...m.values()];
}

function countView(s: MockStore, c: MCount) {
  const lines = s.countLines.filter((l) => l.taskId === c.id);
  const submitted = new Set(lines.map((l) => l.locationId));
  const { locationIds, snapshot: _s, ...rest } = c;
  return {
    ...rest,
    progress: {
      locationsTotal: locationIds.length,
      locationsSubmitted: submitted.size,
      linesNeedingReview: lines.filter((l) => l.needsReview).length,
    },
  };
}
function countLineView(l: MCountLine, hide: boolean) {
  return {
    ...l,
    snapshotQty: hide ? null : l.snapshotQty,
    systemQtyAtCount: hide ? null : l.systemQtyAtCount,
    variance: hide || l.systemQtyAtCount === null ? null : l.countedQty - l.systemQtyAtCount,
  };
}

/** 照抄 @wms3d/labels 的 labelTemplates（contract-v1.2，WS-A1-3；07 §2）。RACK 只允许 rack-100x150。 */
const LABEL_TEMPLATES = [
  {
    key: 'loc-100x50',
    name: '仓位 100×50',
    kinds: ['LOCATION'],
    widthMm: 100,
    heightMm: 50,
    sheet: null,
    maxModules: { dpi203: 253, dpi300: 281 },
    supportsBarePayload: true,
  },
  {
    key: 'loc-60x40',
    name: '仓位 60×40',
    kinds: ['LOCATION'],
    widthMm: 60,
    heightMm: 40,
    sheet: null,
    maxModules: { dpi203: 230, dpi300: 230 },
    supportsBarePayload: true,
  },
  {
    key: 'loc-70x30',
    name: '横梁窄标 70×30',
    kinds: ['LOCATION'],
    widthMm: 70,
    heightMm: 30,
    sheet: null,
    maxModules: { dpi203: 264, dpi300: 259 },
    supportsBarePayload: true,
  },
  {
    key: 'rack-100x150',
    name: '货架端头 100×150',
    kinds: ['RACK'],
    widthMm: 100,
    heightMm: 150,
    sheet: null,
    maxModules: null,
    supportsBarePayload: true,
  },
  {
    key: 'a4-3x8',
    name: 'A4 3×8（70×37mm）',
    kinds: ['LOCATION', 'SKU'],
    widthMm: 210,
    heightMm: 297,
    sheet: { cols: 3, rows: 8 },
    maxModules: { dpi203: 270, dpi300: 270 },
    supportsBarePayload: true,
  },
  {
    key: 'a4-2x7',
    name: 'A4 2×7（99×38mm）',
    kinds: ['LOCATION', 'SKU'],
    widthMm: 210,
    heightMm: 297,
    sheet: { cols: 2, rows: 7 },
    maxModules: { dpi203: 254, dpi300: 282 },
    supportsBarePayload: true,
  },
  {
    key: 'sku-60x40',
    name: 'SKU 60×40',
    kinds: ['SKU'],
    widthMm: 60,
    heightMm: 40,
    sheet: null,
    maxModules: { dpi203: 230, dpi300: 230 },
    supportsBarePayload: false,
  },
] as const;

/** 极简合法 PDF（标签/校准页 mock 返回；真实渲染见 packages/labels） */
const MOCK_PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 283 142]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

/** 极简 RFC 4180 解析（引号、转义引号、CRLF）。 */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function issueSession(
  c: { store: MockStore; tokens: Tokens },
  u: MUser,
  deviceId: string,
  client: 'web' | 'mobile',
) {
  const s = c.store;
  const session = {
    id: s.newId('session'),
    deviceId,
    userId: u.id,
    startedAt: s.iso(),
    endedAt: null as string | null,
  };
  s.sessions.set(session.id, session);
  const at = c.tokens.access({
    userId: u.id,
    role: u.role,
    deviceId,
    sessionId: session.id,
    mustChangePassword: u.mustChangePassword,
  });
  const refresh = c.tokens.refresh({ userId: u.id, deviceId, sessionId: session.id });
  return { session, at, refresh, client };
}

export const handlers: Handlers = {
  // ---------- 运维 ----------
  health: () => ({ status: 'ok', service: 'wms3d-mock', contractVersion: CONTRACT_VERSION }),
  ready: () => ({ status: 'ready', database: 'mock' }),
  appVersion: () => ({
    latest: '0.1.0',
    minSupported: '0.1.0',
    apkUrl: null,
    releaseNotes: 'mock',
  }),

  // ---------- 认证 ----------
  authLogin: (c) => {
    const s = c.store;
    const b = c.body;
    const u = [...s.users.values()].find(
      (x) => x.username.toLowerCase() === b.username.toLowerCase(),
    );
    if (!u || !u.isActive || u.password !== b.password)
      throw new MockError('UNAUTHENTICATED', '用户名或密码错误');
    const dev = s.devices.get(b.deviceId);
    if (dev?.disabledAt) throw new MockError('DEVICE_DISABLED');
    s.devices.set(b.deviceId, {
      id: b.deviceId,
      name: b.deviceName ?? dev?.name ?? null,
      model: b.deviceModel ?? dev?.model ?? null,
      lastUserId: u.id,
      lastSeenAt: s.iso(),
      appVersion: b.appVersion ?? dev?.appVersion ?? null,
      pendingOutbox: dev?.pendingOutbox ?? 0,
      disabledAt: null,
    });
    const { session, at, refresh } = issueSession(c, u, b.deviceId, b.client);
    s.addAudit({
      userId: u.id,
      warehouseId: null,
      action: 'auth.login',
      entity: 'user',
      entityId: u.id,
      result: 'SUCCESS',
      deviceId: b.deviceId,
    });
    const value = {
      accessToken: at.token,
      expiresIn: at.expiresIn,
      ...(b.client === 'mobile' ? { refreshToken: refresh } : {}),
      serverTime: s.iso(),
      user: meView(s, u),
      session,
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (b.client === 'web')
      headers['set-cookie'] = `wms_rt=${refresh}; HttpOnly; SameSite=Strict; Path=/api/v1/auth`;
    return raw(200, { kind: 'json', value }, headers);
  },
  authRefresh: (c) => {
    const s = c.store;
    const cookie = /(?:^|;\s*)wms_rt=([^;]+)/.exec(c.headers['cookie'] ?? '')?.[1];
    const r = c.tokens.parseRefresh(c.body.refreshToken ?? cookie);
    if (!r || r.deviceId !== c.body.deviceId) throw new MockError('UNAUTHENTICATED');
    const sess = s.sessions.get(r.sessionId);
    const u = s.users.get(r.userId);
    if (!sess || sess.endedAt || !u?.isActive) throw new MockError('UNAUTHENTICATED');
    if (s.devices.get(r.deviceId)?.disabledAt) throw new MockError('DEVICE_DISABLED');
    const at = c.tokens.access({
      userId: u.id,
      role: u.role,
      deviceId: r.deviceId,
      sessionId: sess.id,
      mustChangePassword: u.mustChangePassword,
    });
    return {
      accessToken: at.token,
      expiresIn: at.expiresIn,
      ...(c.body.refreshToken ? { refreshToken: c.tokens.refresh(r) } : {}),
      serverTime: s.iso(),
    };
  },
  authLogout: (c) => {
    const sess = c.store.sessions.get(c.auth.sessionId);
    if (sess) sess.endedAt = c.store.iso();
    return raw(204, { kind: 'none' }, { 'set-cookie': 'wms_rt=; Max-Age=0; Path=/api/v1/auth' });
  },
  me: (c) => meView(c.store, need(c.store.users.get(c.auth.userId))),
  changePassword: (c) => {
    const u = need(c.store.users.get(c.auth.userId));
    if (u.password !== c.body.currentPassword)
      throw new MockError('VALIDATION_FAILED', '当前密码不正确', {
        errors: [{ path: 'currentPassword', message: '当前密码不正确' }],
      });
    if (c.body.newPassword === c.body.currentPassword)
      throw new MockError('VALIDATION_FAILED', '新密码不能与当前密码相同', {
        errors: [{ path: 'newPassword', message: '新密码不能与当前密码相同' }],
      });
    u.password = c.body.newPassword;
    u.mustChangePassword = false;
    u.updatedAt = c.store.iso();
    return undefined;
  },

  // ---------- 用户与设备 ----------
  listUsers: (c) => {
    const q = c.query.q?.toLowerCase();
    const items = [...c.store.users.values()].filter(
      (u) => !q || u.username.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q),
    );
    return paginate(
      items.map((u) => userView(c.store, u)),
      c.query.limit,
      c.query.cursor,
    );
  },
  createUser: (c) => {
    const s = c.store;
    if (
      [...s.users.values()].some((u) => u.username.toLowerCase() === c.body.username.toLowerCase())
    )
      throw new MockError('CONFLICT', '用户名已存在');
    const at = s.iso();
    const u: MUser = {
      id: s.newId('user'),
      username: c.body.username,
      displayName: c.body.displayName,
      role: c.body.role,
      allWarehouses: c.body.allWarehouses,
      warehouseIds: c.body.warehouseIds,
      password: c.body.temporaryPassword,
      isActive: true,
      mustChangePassword: true,
      createdAt: at,
      updatedAt: at,
    };
    s.users.set(u.id, u);
    return userView(s, u);
  },
  getUser: (c) => userView(c.store, need(c.store.users.get(c.params.id), '用户')),
  patchUser: (c) => {
    const u = need(c.store.users.get(c.params.id), '用户');
    Object.assign(u, c.body, { updatedAt: c.store.iso() });
    return userView(c.store, u);
  },
  resetPassword: (c) => {
    const u = need(c.store.users.get(c.params.id), '用户');
    u.password = c.body.temporaryPassword;
    u.mustChangePassword = true;
    return undefined;
  },
  listDevices: (c) => ({ items: [...c.store.devices.values()] }),
  patchDevice: (c) => {
    const d = need(c.store.devices.get(c.params.id), '设备');
    if (c.body.name !== undefined) d.name = c.body.name;
    if (c.body.disabled !== undefined) d.disabledAt = c.body.disabled ? c.store.iso() : null;
    return d;
  },
  heartbeat: (c) => {
    const s = c.store;
    const d = s.devices.get(c.body.deviceId);
    if (d)
      Object.assign(d, {
        lastSeenAt: s.iso(),
        appVersion: c.body.appVersion,
        pendingOutbox: c.body.pendingOutbox,
        lastUserId: c.auth.userId,
      });
    return { serverTime: s.iso(), disabled: !!d?.disabledAt };
  },

  // ---------- 仓库与布局 ----------
  listWarehouses: (c) => {
    const u = need(c.store.users.get(c.auth.userId));
    return {
      items: [...c.store.warehouses.values()]
        .filter((w) => u.allWarehouses || u.warehouseIds.includes(w.id))
        .map((w) => warehouseView(c.store, w)),
    };
  },
  createWarehouse: (c) => {
    const s = c.store;
    if ([...s.warehouses.values()].some((w) => w.code === c.body.code))
      throw new MockError('CONFLICT', '仓库代码已存在');
    const at = s.iso();
    const w: MWarehouse = {
      id: s.newId('warehouse'),
      ...c.body,
      publishedLayoutVersion: null,
      createdAt: at,
      updatedAt: at,
    };
    s.warehouses.set(w.id, w);
    return warehouseView(s, w);
  },
  getWarehouse: (c) => warehouseView(c.store, wh(c.store, c.warehouseId)),
  patchWarehouse: (c) => {
    const w = wh(c.store, c.warehouseId);
    if (
      c.body.locationCodePattern &&
      c.body.locationCodePattern !== w.locationCodePattern &&
      warehouseView(c.store, w).locationCodePatternLocked
    ) {
      throw new MockError('CONFLICT', '已存在仓位，编码模式不可修改');
    }
    Object.assign(w, c.body, { updatedAt: c.store.iso() });
    return warehouseView(c.store, w);
  },
  listZones: (c) => ({ items: c.store.zones.filter((z) => z.warehouseId === c.warehouseId) }),
  listRacks: (c) => ({ items: c.store.racks.filter((r) => r.warehouseId === c.warehouseId) }),
  listRackTypes: (c) => ({ items: [...c.store.rackTypes.values()] }),
  createRackType: (c) => {
    if ([...c.store.rackTypes.values()].some((t) => t.key === c.body.key))
      throw new MockError('CONFLICT', '模板 key 已存在');
    const t = { ...c.body, id: c.store.newId('racktype') };
    c.store.rackTypes.set(t.id, t);
    return t;
  },
  patchRackType: (c) => {
    const t = need(c.store.rackTypes.get(c.params.id), '模板');
    const next = { ...c.body, id: t.id };
    c.store.rackTypes.set(t.id, next);
    return next;
  },
  listLayoutVersions: (c) => ({
    items: c.store.layoutVersions
      .filter((v) => v.warehouseId === c.warehouseId)
      .map(({ doc: _d, ...v }) => v),
  }),
  getLayout: (c) => {
    const w = wh(c.store, c.warehouseId);
    const want = c.query.version;
    const vs = c.store.layoutVersions.filter((v) => v.warehouseId === w.id);
    const v =
      want === 'draft'
        ? vs.find((x) => x.status === 'DRAFT')
        : want === 'published'
          ? vs.find((x) => x.version === w.publishedLayoutVersion)
          : vs.find((x) => x.version === want);
    return need(v, '布局版本');
  },
  createDraft: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const vs = s.layoutVersions.filter((v) => v.warehouseId === w.id);
    if (vs.some((v) => v.status === 'DRAFT')) throw new MockError('CONFLICT', '已存在草稿');
    const base =
      c.body.basedOnVersion === null
        ? null
        : need(
            vs.find((v) => v.version === c.body.basedOnVersion),
            '基础版本',
          );
    const doc = base?.doc ?? {
      schemaVersion: 2,
      warehouse: { widthM: w.widthM, depthM: w.depthM, heightM: w.heightM },
      zones: [],
      rackTypes: [],
      racks: [],
      floorAreas: [],
    };
    const d = {
      id: s.layoutVersions.length + 1,
      warehouseId: w.id,
      version: null,
      status: 'DRAFT' as const,
      rowVersion: 0,
      basedOnVersion: base?.version ?? null,
      doc: structuredClone(doc),
      createdBy: c.auth.userId,
      createdAt: s.iso(),
      publishedAt: null,
      publishedBy: null,
    };
    s.layoutVersions.push(d);
    return d;
  },
  saveDraft: (c) => {
    const d = need(
      c.store.layoutVersions.find((v) => v.warehouseId === c.warehouseId && v.status === 'DRAFT'),
      '草稿',
    );
    if (c.ifMatch !== d.rowVersion)
      throw new MockError('PRECONDITION_FAILED', '草稿已被他人修改', {
        context: { currentRowVersion: d.rowVersion },
      });
    d.doc = c.body.doc;
    d.rowVersion += 1;
    return d;
  },
  deleteDraft: (c) => {
    const s = c.store;
    const i = s.layoutVersions.findIndex(
      (v) => v.warehouseId === c.warehouseId && v.status === 'DRAFT',
    );
    if (i < 0) throw new MockError('NOT_FOUND', '草稿不存在');
    s.layoutVersions.splice(i, 1);
    return undefined;
  },
  validateLayout: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const d = need(
      s.layoutVersions.find((v) => v.warehouseId === w.id && v.status === 'DRAFT'),
      '草稿',
    );
    const issues = validateLayout(d.doc, {
      pattern: w.locationCodePattern,
      maxCodeLength: compilePattern(w.locationCodePattern).maxLength,
      minAisleWidthM: 2.5,
    });
    const codes = new Set(
      [...s.locations.values()]
        .filter((l) => l.warehouseId === w.id && l.isActive)
        .map((l) => l.code),
    );
    const next = issues.some((i) => i.severity === 'ERROR') ? [] : planCodes(w, d.doc);
    const nextSet = new Set(next);
    const added = next.filter((x) => !codes.has(x)).map((code) => ({ code }));
    const deactivated = [...s.locations.values()]
      .filter((l) => l.warehouseId === w.id && l.isActive && !nextSet.has(l.code))
      .map((l) => ({ locationId: l.id, code: l.code, onHand: s.onHandAt(l.id) }));
    return {
      issues,
      diff: { added, kept: next.length - added.length, recoded: [], deactivated, reused: [] },
      locationCount: next.length,
    };
  },
  publishLayout: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const d = need(
      s.layoutVersions.find((v) => v.warehouseId === w.id && v.status === 'DRAFT'),
      '草稿',
    );
    if (c.body.rowVersion !== d.rowVersion)
      throw new MockError('PRECONDITION_FAILED', '草稿已被他人修改');
    const issues = validateLayout(d.doc, { pattern: w.locationCodePattern });
    if (issues.some((i) => i.severity === 'ERROR'))
      throw new MockError('LAYOUT_INVALID', undefined, { context: { issues } });
    const nextSet = new Set(planCodes(w, d.doc));
    const withStock = [...s.locations.values()].filter(
      (l) => l.warehouseId === w.id && l.isActive && !nextSet.has(l.code) && s.onHandAt(l.id) > 0,
    );
    if (withStock.length)
      throw new MockError('LAYOUT_HAS_STOCK', undefined, {
        context: {
          locations: withStock.map((l) => ({
            locationId: l.id,
            code: l.code,
            onHand: s.onHandAt(l.id),
          })),
        },
      });
    const version =
      Math.max(
        0,
        ...s.layoutVersions.filter((v) => v.warehouseId === w.id).map((v) => v.version ?? 0),
      ) + 1;
    for (const v of s.layoutVersions)
      if (v.warehouseId === w.id && v.status === 'PUBLISHED') v.status = 'ARCHIVED';
    Object.assign(d, {
      status: 'PUBLISHED',
      version,
      publishedAt: s.iso(),
      publishedBy: c.auth.userId,
    });
    const diff = s.applyProjection(w.id, d.doc, version, s.iso());
    const reprintRequestIds = diff.added.map((a) => {
      const loc = [...s.locations.values()].find(
        (l) => l.warehouseId === w.id && l.code === a.code,
      )!;
      const r = {
        id: s.newId('reprint'),
        warehouseId: w.id,
        kind: 'LOCATION' as const,
        entityId: loc.id,
        code: loc.code,
        reason: 'LAYOUT_NEW' as const,
        note: null,
        status: 'PENDING' as const,
        requestedBy: c.auth.userId,
        requestedAt: s.iso(),
        doneAt: null,
      };
      s.reprints.push(r);
      return r.id;
    });
    c.emit(w.id, { event: 'layout.published', data: { layoutVersion: version } });
    if (reprintRequestIds.length)
      c.emit(w.id, { event: 'reprint.created', data: { count: reprintRequestIds.length } });
    return { layoutVersion: version, diff, reprintRequestIds };
  },

  // ---------- 仓位 ----------
  listLocations: (c) => {
    const s = c.store;
    const q = c.query;
    const zoneIds = q.zone
      ? new Set(
          s.zones
            .filter((z) => z.warehouseId === c.warehouseId && z.code === q.zone)
            .map((z) => z.id),
        )
      : null;
    const rackId = q.rack
      ? s.racks.find((r) => r.warehouseId === c.warehouseId && r.code === q.rack)?.id
      : undefined;
    const items = [...s.locations.values()]
      .filter((l) => l.warehouseId === c.warehouseId)
      .filter((l) => !zoneIds || zoneIds.has(l.zoneId))
      .filter((l) => !q.rack || l.rackId === rackId)
      .filter((l) => !q.q || l.code.includes(q.q.toUpperCase()))
      .filter((l) => !q.kind || l.kind === q.kind)
      .filter((l) => q.isActive === undefined || String(l.isActive) === q.isActive)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map(locationView);
    return paginate(items, q.limit, q.cursor);
  },
  patchLocation: (c) => {
    const s = c.store;
    const l = need(s.locations.get(c.params.id), '仓位');
    if (c.body.isActive === false && s.onHandAt(l.id) > 0)
      throw new MockError('CONFLICT', '仓位有库存，不能停用');
    Object.assign(l, c.body, { updatedAt: s.iso() });
    c.emit(l.warehouseId, {
      event: 'locations.changed',
      data: {
        layoutVersion: s.warehouses.get(l.warehouseId)!.publishedLayoutVersion ?? 0,
        locationIds: [l.id],
      },
    });
    return locationView(l);
  },
  bulkPatchLocations: (c) => {
    const s = c.store;
    const failed: { id: string; code: string }[] = [];
    const ok: string[] = [];
    for (const id of c.body.ids) {
      const l = s.locations.get(id);
      if (!l || l.warehouseId !== c.warehouseId) continue;
      if (c.body.patch.isActive === false && s.onHandAt(id) > 0) {
        failed.push({ id, code: l.code });
        continue;
      }
      Object.assign(l, c.body.patch, { updatedAt: s.iso() });
      ok.push(id);
    }
    if (ok.length)
      c.emit(c.warehouseId!, {
        event: 'locations.changed',
        data: {
          layoutVersion: s.warehouses.get(c.warehouseId!)!.publishedLayoutVersion ?? 0,
          locationIds: ok,
        },
      });
    return { updated: ok.length, failed };
  },

  // ---------- SKU ----------
  listSkus: (c) => {
    const q = c.query.q?.toLowerCase();
    const items = [...c.store.skus.values()]
      .filter(
        (s) =>
          !q ||
          s.code.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.barcodes.some((b) => b.barcode.toLowerCase() === q),
      )
      .filter((s) => c.query.isActive === undefined || String(s.isActive) === c.query.isActive)
      .map(skuView);
    return paginate(items, c.query.limit, c.query.cursor);
  },
  createSku: (c) => {
    const s = c.store;
    if ([...s.skus.values()].some((x) => x.code === c.body.code))
      throw new MockError('CONFLICT', 'SKU 编码已存在');
    for (const b of c.body.barcodes) assertBarcodeFree(s, b.barcode);
    const at = s.iso();
    const { barcodes, ...rest } = c.body;
    const sku: MSku = {
      id: s.newId('sku'),
      ...rest,
      isActive: true,
      imageUrl: null,
      barcodes: barcodes.map((b) => ({ id: s.newId('barcode'), ...b, updatedAt: at })),
      createdAt: at,
      updatedAt: at,
    };
    s.skus.set(sku.id, sku);
    return skuView(sku);
  },
  getSku: (c) => skuView(need(c.store.skus.get(c.params.id), 'SKU')),
  patchSku: (c) => {
    const sku = need(c.store.skus.get(c.params.id), 'SKU');
    Object.assign(sku, c.body, { updatedAt: c.store.iso() });
    return skuView(sku);
  },
  addSkuBarcode: (c) => {
    const s = c.store;
    const sku = need(s.skus.get(c.params.id), 'SKU');
    assertBarcodeFree(s, c.body.barcode);
    sku.barcodes.push({ id: s.newId('barcode'), ...c.body, updatedAt: s.iso() });
    sku.updatedAt = s.iso();
    return skuView(sku);
  },
  deleteSkuBarcode: (c) => {
    const s = c.store;
    const sku = need(s.skus.get(c.params.id), 'SKU');
    const i = sku.barcodes.findIndex((b) => b.id === c.params.barcodeId);
    if (i < 0) throw new MockError('NOT_FOUND', '条码不存在');
    sku.barcodes.splice(i, 1);
    s.tombstones.push({ entity: 'barcode', id: c.params.barcodeId, deletedAt: s.iso() });
    sku.updatedAt = s.iso();
    return skuView(sku);
  },
  importSkus: async (c) => {
    // v1.3（WS-B-1）：multipart 字段 `file`（UTF-8 CSV）；按 code 统计新增/更新，条码冲突与重复行报错；dryRun=false 时写入
    const form = c.body as unknown;
    const file =
      form && typeof (form as FormData).get === 'function' ? (form as FormData).get('file') : null;
    if (!file || typeof file === 'string')
      throw new MockError('VALIDATION_FAILED', '缺少上传文件（multipart 字段 file）', {
        errors: [{ path: 'file', message: '缺少上传文件' }],
      });
    const rows = parseCsv((await (file as Blob).text()).replace(/^\uFEFF/, ''));
    const header = (rows.shift() ?? []).map((h) => h.trim());
    const col = (r: string[], name: string) => {
      const i = header.indexOf(name);
      return i < 0 ? '' : (r[i] ?? '').trim();
    };
    const s = c.store;
    const byCode = new Map([...s.skus.values()].map((k) => [k.code, k]));
    const barcodeOwner = new Map<string, string>();
    for (const k of s.skus.values())
      for (const b of k.barcodes) barcodeOwner.set(b.barcode, k.code);
    const dryRun = c.query.dryRun === 'true';
    const errors: {
      row: number;
      column: string | null;
      code: 'DUPLICATE' | 'BARCODE_CONFLICT' | 'FORMAT' | 'REQUIRED';
      message: string;
    }[] = [];
    const seen = new Set<string>();
    const ok: {
      code: string;
      name: string;
      barcode: string;
      uom: string;
      safety: string;
      hasUom: boolean;
      hasSafety: boolean;
      hasName: boolean;
    }[] = [];
    rows.forEach((r, i) => {
      const row = i + 2;
      if (r.every((x) => !x.trim())) return;
      const code = col(r, 'code');
      const name = col(r, 'name');
      const barcode = col(r, 'barcode');
      if (!code)
        return void errors.push({ row, column: 'code', code: 'REQUIRED', message: '缺少 code' });
      if (!name && !byCode.has(code))
        return void errors.push({
          row,
          column: 'name',
          code: 'REQUIRED',
          message: '新 SKU 缺少 name',
        });
      const key = `${code}|${barcode}`;
      if (seen.has(key))
        return void errors.push({
          row,
          column: 'code',
          code: 'DUPLICATE',
          message: `重复行 ${code}`,
        });
      seen.add(key);
      const owner = barcode ? barcodeOwner.get(barcode) : undefined;
      if (owner && owner !== code)
        return void errors.push({
          row,
          column: 'barcode',
          code: 'BARCODE_CONFLICT',
          message: `条码已属于 ${owner}`,
        });
      const safety = col(r, 'safety_stock');
      if (safety && !/^\d+$/.test(safety))
        return void errors.push({
          row,
          column: 'safety_stock',
          code: 'FORMAT',
          message: '安全库存须为非负整数',
        });
      const has = (n: string) => header.includes(n);
      ok.push({
        code,
        name,
        barcode,
        uom: col(r, 'uom'),
        safety,
        hasUom: has('uom'),
        hasSafety: has('safety_stock'),
        hasName: has('name'),
      });
    });
    const codes = [...new Set(ok.map((x) => x.code))];
    const created = codes.filter((x) => !byCode.has(x)).length;
    const updated = codes.length - created;
    if (!dryRun && errors.length === 0) {
      const at = s.iso();
      for (const x of ok) {
        let sku = byCode.get(x.code);
        if (!sku) {
          sku = {
            id: s.newId('sku'),
            code: x.code,
            name: x.name,
            spec: null,
            uom: x.uom || 'EA',
            lengthMm: null,
            widthMm: null,
            heightMm: null,
            weightG: null,
            safetyStock: x.safety ? Number(x.safety) : 0,
            isActive: true,
            imageUrl: null,
            barcodes: [],
            createdAt: at,
            updatedAt: at,
          };
          s.skus.set(sku.id, sku);
          byCode.set(x.code, sku);
        } else {
          if (x.hasName && x.name) sku.name = x.name;
          if (x.hasUom && x.uom) sku.uom = x.uom;
          if (x.hasSafety && x.safety !== '') sku.safetyStock = Number(x.safety);
          sku.updatedAt = at;
        }
        if (x.barcode && !sku.barcodes.some((b) => b.barcode === x.barcode)) {
          sku.barcodes.push({
            id: s.newId('barcode'),
            barcode: x.barcode,
            packQty: 1,
            isPrimary: sku.barcodes.length === 0,
            updatedAt: at,
          });
          barcodeOwner.set(x.barcode, x.code);
        }
      }
    }
    return {
      dryRun,
      totalRows: rows.filter((r) => r.some((x) => x.trim())).length,
      created,
      updated,
      committedBatches: !dryRun && errors.length === 0 ? Math.ceil(ok.length / 1000) : 0,
      errors,
    };
  },
  exportSkus: (c) => {
    const rows = [
      [
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
      ].join(','),
    ];
    for (const s of c.store.skus.values()) {
      for (const b of s.barcodes.length ? s.barcodes : [null]) {
        rows.push(
          [
            s.code,
            s.name,
            s.spec,
            s.uom,
            b?.barcode,
            b?.packQty,
            s.safetyStock,
            s.lengthMm,
            s.widthMm,
            s.heightMm,
            s.weightG,
          ]
            .map(csvCell)
            .join(','),
        );
      }
    }
    return raw(
      200,
      {
        kind: 'text',
        value: '\uFEFF' + rows.join('\r\n') + '\r\n',
        contentType: 'text/csv; charset=utf-8',
      },
      { 'content-disposition': 'attachment; filename="skus.csv"' },
    );
  },

  // ---------- 扫码与同步 ----------
  scanResolve: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const r = classifyScan(c.query.code, {
      warehouseCode: w.code,
      knownWarehouseCodes: new Set([...s.warehouses.values()].map((x) => x.code)),
      lookupRegistry: (v) => {
        for (const l of s.locations.values())
          if (l.payload === v)
            return {
              kind: 'LOCATION',
              warehouseCode: s.warehouses.get(l.warehouseId)!.code,
              entityId: l.id,
            };
        for (const rk of s.racks) {
          const wc = s.warehouses.get(rk.warehouseId)!.code;
          if (`${wc}.${rk.code}` === v) return { kind: 'RACK', warehouseCode: wc, entityId: rk.id };
        }
        for (const sku of s.skus.values())
          if (sku.barcodes.some((b) => b.barcode === v))
            return { kind: 'SKU', warehouseCode: null, entityId: sku.id };
        return null;
      },
      lookupLocationCode: (code) =>
        [...s.locations.values()].find((l) => l.warehouseId === w.id && l.code === code)?.id ??
        null,
      lookupRackCode: (code) =>
        s.racks.find((rk) => rk.warehouseId === w.id && rk.code === code)?.id ?? null,
    });
    const out: RouteResponse<Routes['scanResolve']> = { kind: r.kind, raw: c.query.code };
    if (r.kind === 'LOCATION') out.location = locationView(s.locations.get(r.entityId!)!);
    if (r.kind === 'RACK') {
      const rk = s.racks.find((x) => x.id === r.entityId)!;
      out.rack = { id: rk.id, code: rk.code };
    }
    if (r.kind === 'SKU') {
      const sku = s.skus.get(r.entityId!)!;
      out.sku = skuView(sku);
      out.packQty =
        sku.barcodes.find((b) => b.barcode === r.text || b.barcode === r.text.toUpperCase())
          ?.packQty ?? 1;
    }
    if (r.kind === 'WRONG_WAREHOUSE' && r.otherWarehouseCode)
      out.otherWarehouseCode = r.otherWarehouseCode;
    return out;
  },
  syncMasterdata: (c) => {
    const s = c.store;
    // mock：游标 = 已返回条数偏移；一次返回 limit 条（按 sku → barcode → location 顺序拼接）
    const all = [
      ...[...s.skus.values()].map((x) => ({ t: 'sku' as const, x })),
      ...[...s.skus.values()].flatMap((sku) =>
        sku.barcodes.map((b) => ({
          t: 'barcode' as const,
          x: {
            id: b.id,
            skuId: sku.id,
            barcode: b.barcode,
            packQty: b.packQty,
            updatedAt: b.updatedAt,
          },
        })),
      ),
      ...[...s.locations.values()]
        .filter((l) => l.warehouseId === c.warehouseId)
        .map((x) => ({ t: 'location' as const, x })),
    ];
    const start = c.query.cursor ? Number(c.query.cursor) || 0 : 0;
    const slice = all.slice(start, start + c.query.limit);
    const hasMore = start + c.query.limit < all.length;
    return {
      skus: slice
        .filter((e) => e.t === 'sku')
        .map(({ x }) => {
          const k = x as MSku;
          return {
            id: k.id,
            code: k.code,
            name: k.name,
            spec: k.spec,
            uom: k.uom,
            isActive: k.isActive,
            updatedAt: k.updatedAt,
          };
        }),
      barcodes: slice
        .filter((e) => e.t === 'barcode')
        .map(
          ({ x }) =>
            x as { id: string; skuId: string; barcode: string; packQty: number; updatedAt: string },
        ),
      locations: slice
        .filter((e) => e.t === 'location')
        .map(({ x }) => {
          const l = x as MLocation;
          return {
            id: l.id,
            code: l.code,
            payload: l.payload,
            kind: l.kind,
            isActive: l.isActive,
            rackCode: l.rackId ? (s.racks.find((r) => r.id === l.rackId)?.code ?? null) : null,
            updatedAt: l.updatedAt,
          };
        }),
      tombstones: start === 0 ? [] : s.tombstones,
      nextCursor: hasMore ? String(start + c.query.limit) : String(all.length),
      hasMore,
      ...(start === 0 ? { total: all.length } : {}),
      serverTime: s.iso(),
    };
  },
  syncDigest: (c) => {
    const s = c.store;
    const skus = s.skus.size;
    const barcodes = [...s.skus.values()].reduce((n, x) => n + x.barcodes.length, 0);
    const locations = [...s.locations.values()].filter(
      (l) => l.warehouseId === c.warehouseId,
    ).length;
    // 与真实 API 同一算法（contract-v1.2 SyncDigest.hash）
    const lines: string[] = [];
    for (const k of s.skus.values()) {
      lines.push(`sku|${k.id}|${k.updatedAt}`);
      for (const b of k.barcodes) lines.push(`barcode|${b.id}|${b.updatedAt}`);
    }
    for (const l of s.locations.values())
      if (l.warehouseId === c.warehouseId) lines.push(`location|${l.id}|${l.updatedAt}`);
    lines.sort(byteCompare);
    return { skus, barcodes, locations, hash: sha256Hex(lines.join('\n')) };
  },

  // ---------- 库存 ----------
  postTransaction: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const b = c.body;
    const key = c.idempotencyKey!;
    const hash = JSON.stringify({
      ...b,
      clientCreatedAt: undefined,
      createdOffline: undefined,
      performerSessionId: undefined,
    });
    const prev = s.txns.find((t) => t.warehouseId === w.id && t.idempotencyKey === key);
    if (prev) {
      if (prev.requestHash !== hash) throw new MockError('IDEMPOTENCY_KEY_REUSED');
      return raw(
        200,
        {
          kind: 'json',
          value: {
            txn: txnView(c.store, prev),
            balancesAfter: balancesAfter(prev.lines),
            replayed: true,
          },
        },
        { 'content-type': 'application/json' },
      );
    }
    if (b.performedBy !== c.auth.userId) {
      // 换班代交（02 §6.6，R3）：performerSessionId 属于 performedBy、同设备、72h 内、早于当前会话
      const ps = b.performerSessionId ? s.sessions.get(b.performerSessionId) : undefined;
      const cur = s.sessions.get(c.auth.sessionId);
      const ok =
        ps &&
        cur &&
        ps.userId === b.performedBy &&
        ps.deviceId === c.auth.deviceId &&
        ps.startedAt <= cur.startedAt &&
        s.now().getTime() - Date.parse(ps.startedAt) <= 72 * 3600_000 &&
        s.users.get(b.performedBy)?.isActive;
      if (!ok) throw new MockError('PERFORMER_NOT_ALLOWED');
    }
    if ((b.type === 'ADJUST' || (b.type !== 'OUTBOUND' && b.force)) && c.auth.role === 'OPERATOR')
      throw new MockError('FORBIDDEN', 'ADJUST / force 仅 MANAGER+');
    let deltas: Delta[];
    if (b.type === 'INBOUND' || b.type === 'OUTBOUND') {
      deltas = b.lines.map((l) => {
        const loc = findLocation(s, w, l);
        const { sku, packQty } = findSku(s, l);
        const q = l.qty * packQty;
        return { loc, sku, qty: b.type === 'INBOUND' ? q : -q };
      });
    } else if (b.type === 'TRANSFER') {
      deltas = b.lines.flatMap((l) => {
        const sku = need(s.skus.get(l.skuId), 'SKU');
        return [
          { loc: findLocation(s, w, { locationId: l.fromLocationId }), sku, qty: -l.qty },
          { loc: findLocation(s, w, { locationId: l.toLocationId }), sku, qty: l.qty },
        ];
      });
    } else {
      deltas = b.lines.map((l) => ({
        loc: findLocation(s, w, { locationId: l.locationId }),
        sku: need(s.skus.get(l.skuId), 'SKU'),
        qty: l.qtyDelta,
      }));
    }
    const lines = applyDeltas(s, w, deltas, {
      force: 'force' in b ? b.force : false,
      checkCapacity: b.type === 'INBOUND' || b.type === 'TRANSFER',
      rejectInactiveSku: b.type === 'INBOUND' || b.type === 'TRANSFER',
    });
    const txn = recordTxn(
      s,
      {
        warehouseId: w.id,
        type: b.type,
        idempotencyKey: key,
        requestHash: hash,
        reason: b.type === 'ADJUST' ? b.reason : null,
        refNo: b.refNo ?? null,
        note: b.note ?? null,
        reversesTxnId: null,
        performedBy: b.performedBy,
        submittedBy: c.auth.userId,
        deviceId: c.auth.deviceId,
        createdOffline: b.createdOffline,
        clientCreatedAt: b.clientCreatedAt,
        lines,
      },
      c.emit,
    );
    return raw(
      201,
      {
        kind: 'json',
        value: { txn: txnView(c.store, txn), balancesAfter: balancesAfter(lines), replayed: false },
      },
      { 'content-type': 'application/json' },
    );
  },
  reverseTransaction: (c) => {
    const s = c.store;
    const orig = need(
      s.txns.find((t) => t.id === c.params.id),
      '交易',
    );
    if (orig.type === 'REVERSAL') throw new MockError('REVERSAL_NOT_ALLOWED', '冲正单不可再冲正');
    if (orig.reversedByTxnId) throw new MockError('TXN_ALREADY_REVERSED');
    if (c.auth.role === 'OPERATOR') {
      const tooOld = s.now().getTime() - Date.parse(orig.createdAt) > 10 * 60_000;
      if (
        orig.performedBy !== c.auth.userId ||
        orig.deviceId !== c.auth.deviceId ||
        tooOld ||
        orig.type === 'COUNT_ADJUST'
      )
        throw new MockError('FORBIDDEN', '操作员只能冲正本人本设备 10 分钟内的单据（WS-A2-1）');
    }
    const w = wh(s, orig.warehouseId);
    const deltas = orig.lines.map((l) => ({
      loc: s.locations.get(l.locationId)!,
      sku: s.skus.get(l.skuId)!,
      qty: -l.qtyDelta,
    }));
    const lines = applyDeltas(s, w, deltas, {});
    const txn = recordTxn(
      s,
      {
        warehouseId: w.id,
        type: 'REVERSAL',
        idempotencyKey: c.idempotencyKey!,
        requestHash: '',
        reason: null,
        refNo: orig.refNo,
        note: c.body.note ?? null,
        reversesTxnId: orig.id,
        performedBy: c.auth.userId,
        submittedBy: c.auth.userId,
        deviceId: c.auth.deviceId,
        createdOffline: false,
        clientCreatedAt: c.body.clientCreatedAt ?? null,
        lines,
      },
      c.emit,
    );
    orig.reversedByTxnId = txn.id;
    return raw(
      201,
      {
        kind: 'json',
        value: { txn: txnView(c.store, txn), balancesAfter: balancesAfter(lines), replayed: false },
      },
      { 'content-type': 'application/json' },
    );
  },
  listTransactions: (c) => {
    const q = c.query;
    const items = c.store.txns
      .filter((t) => t.warehouseId === c.warehouseId)
      .filter((t) => !q.type || t.type === q.type)
      .filter((t) => !q.performedBy || t.performedBy === q.performedBy)
      .filter((t) => !q.refNo || t.refNo === q.refNo)
      .filter((t) => !q.from || t.createdAt >= q.from)
      .filter((t) => !q.to || t.createdAt < q.to)
      .slice()
      .reverse()
      .map((t) => txnView(c.store, t));
    return paginate(items, q.limit, q.cursor);
  },
  getTransaction: (c) =>
    txnView(
      c.store,
      need(
        c.store.txns.find((t) => t.id === c.params.id),
        '交易',
      ),
    ),
  listBalances: (c) => {
    const s = c.store;
    const q = c.query;
    const zoneIds = q.zone
      ? new Set(
          s.zones
            .filter((z) => z.warehouseId === c.warehouseId && z.code === q.zone)
            .map((z) => z.id),
        )
      : null;
    const items = [...s.balances.values()]
      .filter((b) => b.warehouseId === c.warehouseId && b.onHand > 0)
      .filter((b) => !q.skuId || b.skuId === q.skuId)
      .filter((b) => !q.locationId || b.locationId === q.locationId)
      .filter((b) => !zoneIds || zoneIds.has(s.locations.get(b.locationId)!.zoneId))
      .map((b) => {
        const l = s.locations.get(b.locationId)!;
        const k = s.skus.get(b.skuId)!;
        return { ...b, locationCode: l.code, skuCode: k.code, skuName: k.name };
      })
      .sort((a, b) =>
        a.locationCode < b.locationCode ? -1 : a.locationCode > b.locationCode ? 1 : 0,
      );
    return paginate(items, q.limit, q.cursor);
  },
  listMovements: (c) => {
    const q = c.query;
    const items = c.store.movements
      .filter((m) => m.warehouseId === c.warehouseId)
      .filter((m) => !q.skuId || m.skuId === q.skuId)
      .filter((m) => !q.locationId || m.locationId === q.locationId)
      .filter((m) => !q.from || m.createdAt >= q.from)
      .filter((m) => !q.to || m.createdAt < q.to)
      .slice()
      .reverse()
      .map((m) => ({ ...m, performedByName: userName(c.store, m.performedBy) }));
    return paginate(items, q.limit, q.cursor);
  },
  exportMovements: (c) => {
    const rows = ['id,created_at,txn_type,location,sku,qty_delta,balance_after'];
    for (const m of c.store.movements.filter((x) => x.warehouseId === c.warehouseId))
      rows.push(
        [m.id, m.createdAt, m.txnType, m.locationCode, m.skuCode, m.qtyDelta, m.balanceAfter]
          .map(csvCell)
          .join(','),
      );
    return raw(
      200,
      {
        kind: 'text',
        value: '\uFEFF' + rows.join('\r\n') + '\r\n',
        contentType: 'text/csv; charset=utf-8',
      },
      { 'content-disposition': 'attachment; filename="movements.csv"' },
    );
  },
  locate: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const q = c.query.q.toLowerCase();
    const skus = [...s.skus.values()].filter(
      (k) =>
        k.code.toLowerCase() === q ||
        k.name.toLowerCase().includes(q) ||
        k.barcodes.some((b) => b.barcode.toLowerCase() === q),
    );
    const ids = new Set(skus.map((k) => k.id));
    const items = [...s.balances.values()]
      .filter((b) => b.warehouseId === w.id && ids.has(b.skuId) && b.onHand > 0)
      .map((b) => ({
        locationId: b.locationId,
        code: s.locations.get(b.locationId)!.code,
        skuId: b.skuId,
        qty: b.onHand,
      }));
    return {
      layoutVersion: w.publishedLayoutVersion ?? 0,
      skus: skus.map((k) => ({ id: k.id, code: k.code, name: k.name })),
      items,
    };
  },
  lowStock: (c) => {
    const s = c.store;
    const items = [...s.skus.values()]
      .map((k) => {
        let onHand = 0;
        for (const b of s.balances.values())
          if (b.warehouseId === c.warehouseId && b.skuId === k.id) onHand += b.onHand;
        return {
          skuId: k.id,
          skuCode: k.code,
          skuName: k.name,
          onHand,
          safetyStock: k.safetyStock,
        };
      })
      .filter((x) => x.safetyStock > 0 && x.onHand < x.safetyStock);
    return { items };
  },

  // ---------- 孪生（03 §7） ----------
  getTwin: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    const lv = need(
      s.layoutVersions.find(
        (v) => v.warehouseId === w.id && v.version === w.publishedLayoutVersion,
      ),
      '已发布布局',
    );
    const etag = `"lv-${lv.version}"`;
    if (c.headers['if-none-match'] === etag) return raw(304, { kind: 'none' }, { etag });
    const locs = s.twinLocations(w.id);
    const value = {
      warehouseId: w.id,
      warehouseCode: w.code,
      layoutVersion: lv.version!,
      layout: lv.doc,
      locations: {
        id: locs.map((l) => l.id),
        code: locs.map((l) => l.code),
        rackKey: locs.map((l) => l.rackKey),
        rackBayIndex: locs.map((l) => l.rackBayIndex),
        level: locs.map((l) => l.level),
        pos: locs.map((l) => l.position),
      },
    };
    return raw(200, { kind: 'json', value }, { 'content-type': 'application/json', etag });
  },
  getOccupancy: (c) => {
    const s = c.store;
    const w = wh(s, c.warehouseId);
    if (c.query.layoutVersion !== w.publishedLayoutVersion)
      throw new MockError('LAYOUT_STALE', undefined, {
        context: { currentLayoutVersion: w.publishedLayoutVersion },
      });
    const locs = s.twinLocations(w.id);
    const qty: number[] = [];
    const skuCount: number[] = [];
    for (const l of locs) {
      let q = 0;
      let n = 0;
      for (const b of s.balances.values()) {
        if (b.locationId === l.id && b.onHand > 0) {
          q += b.onHand;
          n += 1;
        }
      }
      qty.push(q);
      skuCount.push(n);
    }
    const effectiveMax = locs.map((l) => l.maxQty ?? l.defaultMax);
    return {
      layoutVersion: w.publishedLayoutVersion!,
      asOf: s.iso(),
      qty,
      skuCount,
      fill: qty.map((q, i) =>
        effectiveMax[i] ? Math.min(1, q / effectiveMax[i]!) : q > 0 ? 1 : 0,
      ),
      isActive: locs.map((l) => (l.isActive ? 1 : 0) as 0 | 1),
      effectiveMax,
    };
  },

  // ---------- 盘点（简化） ----------
  createCount: (c) => {
    const s = c.store;
    const sc = c.body.scope;
    const zoneIds = new Set(
      s.zones
        .filter((z) => z.warehouseId === c.warehouseId && sc.zones.includes(z.code))
        .map((z) => z.id),
    );
    const locs = [...s.locations.values()].filter(
      (l) =>
        l.warehouseId === c.warehouseId &&
        l.isActive &&
        (zoneIds.has(l.zoneId) ||
          (l.rackId && sc.rackIds.includes(l.rackId)) ||
          sc.locationIds.includes(l.id)),
    );
    const snapshot = new Map<string, number>();
    for (const b of s.balances.values())
      if (locs.some((l) => l.id === b.locationId))
        snapshot.set(balanceKey(b.locationId, b.skuId), b.onHand);
    const task: MCount = {
      id: s.newId('count'),
      warehouseId: c.warehouseId!,
      code: `CT-${String(s.counts.length + 1).padStart(4, '0')}`,
      scope: sc,
      blind: c.body.blind,
      status: 'OPEN',
      createdBy: c.auth.userId,
      createdAt: s.iso(),
      closedTxnId: null,
      closedAt: null,
      locationIds: locs.map((l) => l.id),
      snapshot,
    };
    s.counts.push(task);
    return countView(s, task);
  },
  listCounts: (c) =>
    paginate(
      c.store.counts
        .filter(
          (t) =>
            t.warehouseId === c.warehouseId && (!c.query.status || t.status === c.query.status),
        )
        .map((t) => countView(c.store, t)),
      c.query.limit,
      c.query.cursor,
    ),
  getCount: (c) => countView(c.store, need(c.store.counts.find((t) => t.id === c.params.id))),
  listCountLines: (c) => {
    const t = need(c.store.counts.find((x) => x.id === c.params.id));
    const hide = t.blind && c.auth.role === 'OPERATOR';
    const items = c.store.countLines
      .filter(
        (l) =>
          l.taskId === t.id &&
          (!c.query.location || l.locationId === c.query.location) &&
          (c.query.needsReview === undefined || String(l.needsReview) === c.query.needsReview),
      )
      .map((l) => countLineView(l, hide));
    return paginate(items, c.query.limit, c.query.cursor);
  },
  startCount: (c) => transition(c.store, c.params.id, 'OPEN', 'COUNTING'),
  reviewCount: (c) => transition(c.store, c.params.id, 'COUNTING', 'REVIEW'),
  cancelCount: (c) => {
    const t = need(c.store.counts.find((x) => x.id === c.params.id));
    if (t.status === 'CLOSED' || t.status === 'CANCELLED')
      throw new MockError('CONFLICT', `状态 ${t.status} 不可取消`);
    t.status = 'CANCELLED';
    return countView(c.store, t);
  },
  submitCount: (c) => {
    const s = c.store;
    const t = need(s.counts.find((x) => x.id === c.params.id));
    if (t.status !== 'COUNTING') throw new MockError('CONFLICT', '任务不在盘点中');
    if (!t.locationIds.includes(c.body.locationId))
      throw new MockError('VALIDATION_FAILED', '仓位不在盘点范围');
    const loc = s.locations.get(c.body.locationId)!;
    s.countLines = s.countLines.filter((l) => !(l.taskId === t.id && l.locationId === loc.id));
    const skuIds = new Set([
      ...c.body.lines.map((l) => l.skuId),
      ...[...s.balances.values()]
        .filter((b) => b.locationId === loc.id && b.onHand > 0)
        .map((b) => b.skuId),
    ]);
    const lines = [...skuIds].map((skuId) => {
      const counted = c.body.lines.find((l) => l.skuId === skuId)?.countedQty ?? 0;
      const sys = s.balances.get(balanceKey(loc.id, skuId))?.onHand ?? 0;
      const snap = t.snapshot.get(balanceKey(loc.id, skuId)) ?? 0;
      return {
        id: s.newId('countline'),
        taskId: t.id,
        locationId: loc.id,
        locationCode: loc.code,
        skuId,
        skuCode: s.skus.get(skuId)?.code ?? '?',
        lotNo: '',
        snapshotQty: snap,
        systemQtyAtCount: sys,
        countedQty: counted,
        countedBy: c.auth.userId,
        countedAt: s.iso(),
        clientCountedAt: c.body.clientCountedAt,
        needsReview: snap !== sys,
      };
    });
    s.countLines.push(...lines);
    const hide = t.blind && c.auth.role === 'OPERATOR';
    return {
      taskId: t.id,
      locationId: loc.id,
      lines: lines.map((l) => countLineView(l, hide)),
      needsReview: lines.some((l) => l.needsReview),
    };
  },
  closeCount: (c) => {
    const s = c.store;
    const t = need(s.counts.find((x) => x.id === c.params.id));
    if (t.status !== 'REVIEW' && t.status !== 'COUNTING')
      throw new MockError('CONFLICT', `状态 ${t.status} 不可关闭`);
    const lines = s.countLines.filter((l) => l.taskId === t.id);
    if (lines.some((l) => l.needsReview))
      throw new MockError('COUNT_RECOUNT_REQUIRED', undefined, {
        context: {
          locationIds: [...new Set(lines.filter((l) => l.needsReview).map((l) => l.locationId))],
          lines: [],
        },
      });
    const w = wh(s, t.warehouseId);
    // delta 型调整：delta = 提交时固定的 variance（countedQty − systemQtyAtCount），与真实 API 一致（WS-A2-1）
    const deltas = lines
      .map((l) => ({
        line: l,
        loc: s.locations.get(l.locationId)!,
        sku: s.skus.get(l.skuId)!,
        qty: l.countedQty - (l.systemQtyAtCount ?? 0),
      }))
      .filter((d) => d.qty !== 0);
    const short = deltas
      .map((d) => ({ d, available: s.balances.get(balanceKey(d.loc.id, d.sku.id))?.onHand ?? 0 }))
      .filter((x) => x.available + x.d.qty < 0);
    if (short.length) {
      const bad = new Set(short.map((x) => x.d.loc.id));
      for (const l of lines) if (bad.has(l.locationId)) l.needsReview = true;
      throw new MockError('COUNT_RECOUNT_REQUIRED', '关闭时余额不足，相关仓位需要重盘', {
        context: {
          locationIds: [...bad],
          lines: short.map((x) => ({
            locationId: x.d.loc.id,
            skuId: x.d.sku.id,
            variance: x.d.qty,
            available: x.available,
          })),
        },
      });
    }
    let adjustTxnId: string | null = null;
    if (deltas.length) {
      const tl = applyDeltas(s, w, deltas, {});
      adjustTxnId = recordTxn(
        s,
        {
          warehouseId: w.id,
          type: 'COUNT_ADJUST',
          idempotencyKey: `count:${t.id}`,
          requestHash: '',
          reason: null,
          refNo: t.code,
          note: null,
          reversesTxnId: null,
          performedBy: c.auth.userId,
          submittedBy: c.auth.userId,
          deviceId: c.auth.deviceId,
          createdOffline: false,
          clientCreatedAt: null,
          lines: tl,
        },
        c.emit,
      ).id;
    }
    Object.assign(t, { status: 'CLOSED', closedAt: s.iso(), closedTxnId: adjustTxnId });
    return { task: countView(s, t), adjustTxnId };
  },

  // ---------- 标签 ----------
  listLabelTemplates: () => ({
    items: LABEL_TEMPLATES.map((t) => ({ ...t, kinds: [...t.kinds] })),
  }),
  renderLabels: (c) => {
    const tpl = LABEL_TEMPLATES.find((t) => t.key === c.body.template)!;
    if (!(tpl.kinds as readonly string[]).includes(c.body.kind))
      throw new MockError('VALIDATION_FAILED', `模板 ${tpl.key} 不支持 ${c.body.kind}`, {
        errors: [{ path: 'body.kind', message: '模板与标签类型不匹配' }],
      });
    if (c.body.format === 'ZPL' && tpl.sheet)
      throw new MockError('VALIDATION_FAILED', 'A4 多联模板不支持 ZPL', {
        errors: [{ path: 'body.format', message: 'A4 多联模板不支持 ZPL' }],
      });
    const count = c.body.ids?.length ?? 1;
    const done = (c.body.reprintRequestIds ?? []).length;
    if (c.body.reprintRequestIds)
      for (const r of c.store.reprints)
        if (c.body.reprintRequestIds.includes(r.id))
          Object.assign(r, { status: 'DONE', doneAt: c.store.iso() });
    const headers = { 'x-label-count': String(count), 'x-reprints-done': String(done) };
    if (c.body.format === 'ZPL')
      return raw(
        200,
        {
          kind: 'text',
          value: '^XA^FO20,20^A0N,40,40^FDMOCK^FS^XZ\n'.repeat(count),
          contentType: 'application/vnd.zebra.zpl; charset=utf-8',
        },
        { ...headers, 'content-disposition': 'inline; filename="labels.zpl"' },
      );
    return raw(
      200,
      { kind: 'text', value: MOCK_PDF, contentType: 'application/pdf' },
      { ...headers, 'content-disposition': 'inline; filename="labels.pdf"' },
    );
  },
  calibrationPdf: () => raw(200, { kind: 'text', value: MOCK_PDF, contentType: 'application/pdf' }),
  listReprints: (c) =>
    paginate(
      c.store.reprints.filter(
        (r) => r.warehouseId === c.warehouseId && (!c.query.status || r.status === c.query.status),
      ),
      c.query.limit,
      c.query.cursor,
    ),
  createReprint: (c) => {
    const s = c.store;
    const b = c.body;
    const code =
      b.kind === 'LOCATION'
        ? s.locations.get(b.entityId)?.code
        : b.kind === 'RACK'
          ? s.racks.find((r) => r.id === b.entityId)?.code
          : s.skus.get(b.entityId)?.code;
    const r = {
      id: s.newId('reprint'),
      warehouseId: b.warehouseId,
      kind: b.kind,
      entityId: b.entityId,
      code: need(code, '实体'),
      reason: b.reason,
      note: b.note ?? null,
      status: 'PENDING' as const,
      requestedBy: c.auth.userId,
      requestedAt: s.iso(),
      doneAt: null,
    };
    s.reprints.push(r);
    c.emit(b.warehouseId, { event: 'reprint.created', data: { count: 1 } });
    return r;
  },
  patchReprint: (c) => {
    const r = need(c.store.reprints.find((x) => x.id === c.params.id));
    Object.assign(r, {
      status: c.body.status,
      doneAt: c.body.status === 'DONE' ? c.store.iso() : null,
    });
    return r;
  },

  // ---------- 看板、审计、事件 ----------
  dashboard: (c) => {
    const s = c.store;
    const locs = [...s.locations.values()].filter((l) => l.warehouseId === c.warehouseId);
    const bal = [...s.balances.values()].filter(
      (b) => b.warehouseId === c.warehouseId && b.onHand > 0,
    );
    const today = s.iso().slice(0, 10);
    const todayTx = s.txns.filter(
      (t) => t.warehouseId === c.warehouseId && t.createdAt.startsWith(today),
    );
    const cnt = (ty: string) => todayTx.filter((t) => t.type === ty).length;
    const low = (handlers.lowStock as (x: unknown) => { items: unknown[] })(c).items.length;
    return {
      warehouseId: c.warehouseId!,
      asOf: s.iso(),
      locations: {
        total: locs.length,
        occupied: new Set(bal.map((b) => b.locationId)).size,
        inactive: locs.filter((l) => !l.isActive).length,
      },
      skusInStock: new Set(bal.map((b) => b.skuId)).size,
      totalOnHand: bal.reduce((n, b) => n + b.onHand, 0),
      today: {
        inbound: cnt('INBOUND'),
        outbound: cnt('OUTBOUND'),
        transfer: cnt('TRANSFER'),
        adjust: cnt('ADJUST') + cnt('COUNT_ADJUST'),
      },
      lowStockCount: low,
      pendingSync: {
        devices: [...s.devices.values()].filter((d) => d.pendingOutbox > 0).length,
        records: [...s.devices.values()].reduce((n, d) => n + d.pendingOutbox, 0),
      },
      reconcile: { lastRunAt: null, mismatches: null },
      backup: { lastLocalAt: null, lastRemoteAt: null, remoteConfigured: false },
      pendingReprints: s.reprints.filter(
        (r) => r.warehouseId === c.warehouseId && r.status === 'PENDING',
      ).length,
    };
  },
  auditLogs: (c) => {
    const q = c.query;
    const u = c.store.users.get(c.auth.userId)!;
    if (
      c.auth.role === 'MANAGER' &&
      (!q.warehouseId || !(u.allWarehouses || u.warehouseIds.includes(q.warehouseId)))
    )
      throw new MockError('NOT_FOUND');
    const items = c.store.audit
      .filter((a) => !q.warehouseId || a.warehouseId === q.warehouseId)
      .filter((a) => !q.userId || a.userId === q.userId)
      .filter((a) => !q.action || a.action === q.action)
      .slice()
      .reverse()
      .map((a) => ({ ...a, userName: userName(c.store, a.userId) }));
    return paginate(items, q.limit, q.cursor);
  },
  events: (c) =>
    raw(
      200,
      { kind: 'sse', warehouseId: c.warehouseId! },
      { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    ),
};

function transition(s: MockStore, id: string, from: MCount['status'], to: MCount['status']) {
  const t = need(s.counts.find((x) => x.id === id));
  if (t.status !== from) throw new MockError('CONFLICT', `状态 ${t.status} 不能转为 ${to}`);
  t.status = to;
  return countView(s, t);
}

function assertBarcodeFree(s: MockStore, barcode: string) {
  for (const k of s.skus.values())
    if (k.barcodes.some((b) => b.barcode === barcode))
      throw new MockError('BARCODE_CONFLICT', `条码已被 ${k.code} 使用`);
  for (const l of s.locations.values())
    if (l.payload === barcode) throw new MockError('BARCODE_CONFLICT', '与仓位载荷冲突');
}

function planCodes(w: MWarehouse, doc: Parameters<MockStore['applyProjection']>[1]): string[] {
  return expandLayout(doc, w.locationCodePattern).locations.map((l) => l.code);
}
