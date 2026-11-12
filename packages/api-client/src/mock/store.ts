import type { LayoutDoc, Role } from '@wms3d/contracts';
import { demo, demoId, expandLayout, toPayload } from '@wms3d/domain';

/**
 * Mock 内存数据（由 @wms3d/domain 的演示数据集确定性生成，与 `db:seed:demo` 同源同 id）。
 * 仅供前端并行开发与契约测试；业务规则做“足够像”的简化，权威语义以 docs/02、03 与真实 API 为准。
 */
export interface MUser {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  allWarehouses: boolean;
  warehouseIds: string[];
  password: string;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface MWarehouse {
  id: string;
  code: string;
  name: string;
  timezone: string;
  widthM: number;
  depthM: number;
  heightM: number;
  locationCodePattern: string;
  barcodePrefixEnabled: boolean;
  allowMixedSku: boolean;
  publishedLayoutVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface MZone {
  id: string;
  warehouseId: string;
  layoutVersion: number;
  code: string;
  name: string | null;
  kind: 'STORAGE' | 'RECEIVING' | 'SHIPPING' | 'QC';
  polygon: [number, number][];
  color: string | null;
}
export interface MRack {
  id: string;
  warehouseId: string;
  zoneId: string;
  layoutKey: string;
  code: string;
  aisle: number;
  side: 'L' | 'R';
  rackNo: number;
  bayStart: number;
  rackType: LayoutDoc['rackTypes'][number];
  x: number;
  z: number;
  rotationDeg: 0 | 90 | 180 | 270;
  isActive: boolean;
  layoutVersion: number;
}
export interface MLocation {
  id: string;
  warehouseId: string;
  zoneId: string;
  rackId: string | null;
  rackKey: string | null;
  code: string;
  payload: string;
  kind: MZone['kind'];
  bay: number | null;
  level: number | null;
  position: number | null;
  rackBayIndex: number | null;
  pickSeq: number;
  maxQty: number | null;
  defaultMax: number | null;
  isActive: boolean;
  updatedAt: string;
}
export interface MBarcode {
  id: string;
  barcode: string;
  packQty: number;
  isPrimary: boolean;
  updatedAt: string;
}
export interface MSku {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  uom: string;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  weightG: number | null;
  safetyStock: number;
  isActive: boolean;
  imageUrl: string | null;
  barcodes: MBarcode[];
  createdAt: string;
  updatedAt: string;
}
export interface MLayoutVersion {
  id: number;
  warehouseId: string;
  version: number | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  rowVersion: number;
  basedOnVersion: number | null;
  doc: LayoutDoc;
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
}
export interface MTxnLine {
  locationId: string;
  locationCode: string;
  skuId: string;
  skuCode: string;
  lotNo: string;
  qtyDelta: number;
  balanceAfter: number;
}
export interface MTxn {
  id: string;
  warehouseId: string;
  type: 'INBOUND' | 'OUTBOUND' | 'TRANSFER' | 'ADJUST' | 'COUNT_ADJUST' | 'REVERSAL';
  idempotencyKey: string;
  requestHash: string;
  reason: 'DAMAGE' | 'LOST' | 'FOUND' | 'EXPIRED' | 'DATA_FIX' | 'OTHER' | null;
  refNo: string | null;
  note: string | null;
  reversesTxnId: string | null;
  reversedByTxnId: string | null;
  performedBy: string;
  submittedBy: string;
  deviceId: string | null;
  createdOffline: boolean;
  clientCreatedAt: string | null;
  createdAt: string;
  lines: MTxnLine[];
}
export interface MMovement {
  id: number;
  txnId: string;
  txnType: MTxn['type'];
  warehouseId: string;
  locationId: string;
  locationCode: string;
  skuId: string;
  skuCode: string;
  lotNo: string;
  qtyDelta: number;
  balanceAfter: number;
  performedBy: string;
  createdAt: string;
}
export interface MDevice {
  id: string;
  name: string | null;
  model: string | null;
  lastUserId: string | null;
  lastSeenAt: string | null;
  appVersion: string | null;
  pendingOutbox: number;
  disabledAt: string | null;
}
export interface MSession {
  id: string;
  deviceId: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
}
export interface MCountLine {
  id: string;
  taskId: string;
  locationId: string;
  locationCode: string;
  skuId: string;
  skuCode: string;
  lotNo: string;
  snapshotQty: number | null;
  systemQtyAtCount: number | null;
  countedQty: number;
  countedBy: string;
  countedAt: string;
  clientCountedAt: string | null;
  needsReview: boolean;
}
export interface MCount {
  id: string;
  warehouseId: string;
  code: string;
  scope: { zones: string[]; rackIds: string[]; locationIds: string[] };
  blind: boolean;
  status: 'OPEN' | 'COUNTING' | 'REVIEW' | 'CLOSED' | 'CANCELLED';
  createdBy: string;
  createdAt: string;
  closedTxnId: string | null;
  closedAt: string | null;
  locationIds: string[];
  snapshot: Map<string, number>;
}
export interface MReprint {
  id: string;
  warehouseId: string;
  kind: 'LOCATION' | 'RACK' | 'SKU';
  entityId: string;
  code: string;
  reason: 'DAMAGED' | 'MISSING' | 'LAYOUT_RECODE' | 'LAYOUT_NEW' | 'OTHER';
  note: string | null;
  status: 'PENDING' | 'DONE' | 'CANCELLED';
  requestedBy: string;
  requestedAt: string;
  doneAt: string | null;
}
export interface MAudit {
  id: number;
  at: string;
  userId: string | null;
  warehouseId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILED';
  before: unknown;
  after: unknown;
  ip: string | null;
  deviceId: string | null;
  traceId: string | null;
}

export const balanceKey = (locationId: string, skuId: string, lotNo = '') =>
  `${locationId}|${skuId}|${lotNo}`;

export interface MockStoreOptions {
  /** 固定“现在”，便于测试；缺省用真实时钟 */
  now?: () => Date;
  /** 是否带初始库存（缺省 true） */
  withStock?: boolean;
}

export class MockStore {
  readonly now: () => Date;
  users = new Map<string, MUser>();
  warehouses = new Map<string, MWarehouse>();
  zones: MZone[] = [];
  racks: MRack[] = [];
  locations = new Map<string, MLocation>();
  rackTypes = new Map<string, LayoutDoc['rackTypes'][number] & { id: string }>();
  layoutVersions: MLayoutVersion[] = [];
  skus = new Map<string, MSku>();
  balances = new Map<
    string,
    {
      warehouseId: string;
      locationId: string;
      skuId: string;
      lotNo: string;
      onHand: number;
      updatedAt: string;
    }
  >();
  txns: MTxn[] = [];
  movements: MMovement[] = [];
  devices = new Map<string, MDevice>();
  sessions = new Map<string, MSession>();
  counts: MCount[] = [];
  countLines: MCountLine[] = [];
  reprints: MReprint[] = [];
  audit: MAudit[] = [];
  tombstones: { entity: 'sku' | 'barcode' | 'location'; id: string; deletedAt: string }[] = [];
  private seq = 0;

  constructor(opts: MockStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.seed(opts.withStock ?? true);
  }

  iso(): string {
    return this.now().toISOString();
  }
  /** 确定性新 id（mock 内唯一；格式为 UUID） */
  newId(kind: string): string {
    this.seq += 1;
    return demoId(`mock:${kind}:${this.seq}`);
  }

  private seed(withStock: boolean): void {
    const t0 = '2026-11-01T00:00:00.000Z';
    for (const w of [demo.demoWarehouse, demo.demoWarehouse2]) {
      this.warehouses.set(w.id, {
        ...w,
        publishedLayoutVersion: null,
        createdAt: t0,
        updatedAt: t0,
      });
    }
    const whByCode = new Map([...this.warehouses.values()].map((w) => [w.code, w.id]));
    for (const u of demo.demoUsers) {
      this.users.set(u.id, {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        allWarehouses: u.allWarehouses,
        warehouseIds: u.warehouseCodes.map((c) => whByCode.get(c)!),
        password: demo.DEMO_PASSWORD,
        isActive: true,
        mustChangePassword: false,
        createdAt: t0,
        updatedAt: t0,
      });
    }
    for (const rt of demo.demoLayout.rackTypes)
      this.rackTypes.set(demoId(`racktype:${rt.key}`), { ...rt, id: demoId(`racktype:${rt.key}`) });
    const admin = demo.demoUsers[0]!.id;
    this.layoutVersions.push({
      id: 1,
      warehouseId: demo.demoWarehouse.id,
      version: 1,
      status: 'PUBLISHED',
      rowVersion: 0,
      basedOnVersion: null,
      doc: demo.demoLayout,
      createdBy: admin,
      createdAt: t0,
      publishedAt: t0,
      publishedBy: admin,
    });
    this.applyProjection(demo.demoWarehouse.id, demo.demoLayout, 1, t0);
    for (const s of demo.demoSkus) {
      this.skus.set(s.id, {
        id: s.id,
        code: s.code,
        name: s.name,
        spec: s.spec,
        uom: s.uom,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        weightG: null,
        safetyStock: s.safetyStock,
        isActive: true,
        imageUrl: null,
        barcodes: s.barcodes.map((b) => ({ ...b, updatedAt: t0 })),
        createdAt: t0,
        updatedAt: t0,
      });
    }
    if (withStock) {
      const wh = demo.demoWarehouse.id;
      const txnId = demoId('txn:seed');
      const lines: MTxnLine[] = [];
      for (const b of demo.demoBalances) {
        const sku = this.skus.get(b.skuId)!;
        this.balances.set(balanceKey(b.locationId, b.skuId), {
          warehouseId: wh,
          locationId: b.locationId,
          skuId: b.skuId,
          lotNo: '',
          onHand: b.onHand,
          updatedAt: t0,
        });
        lines.push({
          locationId: b.locationId,
          locationCode: b.locationCode,
          skuId: b.skuId,
          skuCode: sku.code,
          lotNo: '',
          qtyDelta: b.onHand,
          balanceAfter: b.onHand,
        });
      }
      this.txns.push({
        id: txnId,
        warehouseId: wh,
        type: 'INBOUND',
        idempotencyKey: 'seed-inbound-0001',
        requestHash: '0'.repeat(64),
        reason: null,
        refNo: 'SEED',
        note: '演示初始库存',
        reversesTxnId: null,
        reversedByTxnId: null,
        performedBy: admin,
        submittedBy: admin,
        deviceId: null,
        createdOffline: false,
        clientCreatedAt: t0,
        createdAt: t0,
        lines,
      });
      lines.forEach((l, i) =>
        this.movements.push({
          id: i + 1,
          txnId,
          txnType: 'INBOUND',
          warehouseId: wh,
          ...l,
          performedBy: admin,
          createdAt: t0,
        }),
      );
    }
  }

  /** 发布投影（简化版 02 §9：按 code 匹配保留 id；未出现的停用）。返回差异。 */
  applyProjection(warehouseId: string, doc: LayoutDoc, version: number, at: string) {
    const wh = this.warehouses.get(warehouseId)!;
    const exp = expandLayout(doc, wh.locationCodePattern);
    this.zones = this.zones.filter((z) => z.warehouseId !== warehouseId);
    const zoneIds = new Map<string, string>();
    for (const z of doc.zones) {
      const id = demoId(`zone:${wh.code}:${z.code}`);
      zoneIds.set(z.code, id);
      this.zones.push({
        id,
        warehouseId,
        layoutVersion: version,
        code: z.code,
        name: z.name ?? null,
        kind: z.kind,
        polygon: z.polygon as [number, number][],
        color: z.color ?? null,
      });
    }
    const docRacks = new Map(doc.racks.map((r) => [r.key, r]));
    this.racks = this.racks.filter((r) => r.warehouseId !== warehouseId);
    for (const r of exp.racks) {
      const d = docRacks.get(r.key)!;
      this.racks.push({
        id: demoId(`rack:${wh.code}:${r.key}`),
        warehouseId,
        zoneId: zoneIds.get(r.zone)!,
        layoutKey: r.key,
        code: r.code,
        aisle: r.aisle,
        side: r.side,
        rackNo: r.rackNo,
        bayStart: r.bayStart,
        rackType: r.type,
        x: d.x,
        z: d.z,
        rotationDeg: d.rotationDeg,
        isActive: true,
        layoutVersion: version,
      });
    }
    const existing = new Map(
      [...this.locations.values()]
        .filter((l) => l.warehouseId === warehouseId)
        .map((l) => [l.code, l]),
    );
    const seen = new Set<string>();
    const added: { code: string }[] = [];
    let kept = 0;
    for (const l of exp.locations) {
      seen.add(l.code);
      const prev = existing.get(l.code);
      const id = prev?.id ?? demoId(`location:${wh.code}:${l.code}`);
      if (prev?.isActive) kept += 1;
      else added.push({ code: l.code });
      const defaultMax = l.rackKey
        ? (exp.racks.find((r) => r.key === l.rackKey)?.type.defaultMaxQty ?? null)
        : null;
      this.locations.set(id, {
        id,
        warehouseId,
        zoneId: zoneIds.get(l.zone)!,
        rackId: l.rackKey ? demoId(`rack:${wh.code}:${l.rackKey}`) : null,
        rackKey: l.rackKey,
        code: l.code,
        payload: toPayload(wh.code, l.code, wh.barcodePrefixEnabled),
        kind: l.kind,
        bay: l.bay,
        level: l.level,
        position: l.position,
        rackBayIndex: l.rackBayIndex,
        pickSeq: prev?.pickSeq ?? l.pickSeq,
        maxQty: prev?.maxQty ?? null,
        defaultMax,
        isActive: true,
        updatedAt: at,
      });
    }
    const deactivated: { locationId: string; code: string; onHand: number }[] = [];
    for (const [code, l] of existing) {
      if (!seen.has(code) && l.isActive) {
        l.isActive = false;
        l.updatedAt = at;
        deactivated.push({ locationId: l.id, code, onHand: this.onHandAt(l.id) });
      }
    }
    wh.publishedLayoutVersion = version;
    wh.updatedAt = at;
    return { added, kept, recoded: [] as never[], deactivated, reused: [] as never[] };
  }

  onHandAt(locationId: string): number {
    let s = 0;
    for (const b of this.balances.values()) if (b.locationId === locationId) s += b.onHand;
    return s;
  }

  /** 发布投影顺序 = TwinModel 下标顺序（按 expandLayout 输出） */
  twinLocations(warehouseId: string): MLocation[] {
    const wh = this.warehouses.get(warehouseId)!;
    const lv = this.layoutVersions.find(
      (v) => v.warehouseId === warehouseId && v.version === wh.publishedLayoutVersion,
    );
    if (!lv) return [];
    const exp = expandLayout(lv.doc, wh.locationCodePattern);
    const byCode = new Map(
      [...this.locations.values()]
        .filter((l) => l.warehouseId === warehouseId)
        .map((l) => [l.code, l]),
    );
    return exp.locations.map((l) => byCode.get(l.code)!).filter(Boolean);
  }

  addAudit(
    entry: Omit<MAudit, 'id' | 'at' | 'ip' | 'traceId' | 'before' | 'after'> & {
      before?: unknown;
      after?: unknown;
    },
  ): void {
    this.audit.push({
      id: this.audit.length + 1,
      at: this.iso(),
      ip: '127.0.0.1',
      traceId: null,
      before: null,
      after: null,
      ...entry,
    });
  }
}
