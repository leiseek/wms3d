import { ApiError, type ApiClient } from '@wms3d/api-client';
import type { ScanResolution } from '@wms3d/contracts';
import { classifyScan } from '@wms3d/domain';

export interface MdSku {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  uom: string;
  isActive: boolean;
  updatedAt: string;
}
export interface MdBarcode {
  id: string;
  skuId: string;
  barcode: string;
  packQty: number;
  updatedAt: string;
}
export interface MdLocation {
  id: string;
  code: string;
  payload: string;
  kind: string;
  isActive: boolean;
  rackCode: string | null;
  updatedAt: string;
}

export interface MasterSnapshot {
  warehouseId: string;
  warehouseCode: string;
  knownWarehouseCodes: string[];
  cursor: string | null;
  /** 首次全量完成时间（ISO）；null = 未完成 → 禁止离线作业 */
  fullSyncedAt: string | null;
  lastSyncAt: string | null;
  skus: MdSku[];
  barcodes: MdBarcode[];
  locations: MdLocation[];
}

/** 主数据快照持久化（原生/浏览器均为 IndexedDB，可重建） */
export interface MasterPersistence {
  load(warehouseId: string): Promise<MasterSnapshot | null>;
  save(s: MasterSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryMasterPersistence implements MasterPersistence {
  m = new Map<string, MasterSnapshot>();
  async load(id: string) {
    const s = this.m.get(id);
    return s ? structuredClone(s) : null;
  }
  async save(s: MasterSnapshot) {
    this.m.set(s.warehouseId, structuredClone(s));
  }
  async clear() {
    this.m.clear();
  }
}

/** 扫码解析结果（本地与服务端统一成这一形状，供作业状态机使用） */
export type Resolved =
  | { kind: 'LOCATION'; raw: string; loc: { id: string; code: string; isActive: boolean } }
  | { kind: 'RACK'; raw: string; rackCode: string }
  | {
      kind: 'SKU';
      raw: string;
      sku: { id: string; code: string; name: string };
      packQty: number;
      barcode: string;
    }
  | { kind: 'WRONG_WAREHOUSE'; raw: string; other: string | null }
  | { kind: 'UNKNOWN'; raw: string; offline: boolean };

export function fromServer(r: ScanResolution, raw: string): Resolved {
  switch (r.kind) {
    case 'LOCATION':
      return {
        kind: 'LOCATION',
        raw,
        loc: { id: r.location!.id, code: r.location!.code, isActive: r.location!.isActive },
      };
    case 'RACK':
      return { kind: 'RACK', raw, rackCode: r.rack?.code ?? raw };
    case 'SKU':
      return {
        kind: 'SKU',
        raw,
        sku: { id: r.sku!.id, code: r.sku!.code, name: r.sku!.name },
        packQty: r.packQty ?? 1,
        barcode: raw.trim(),
      };
    case 'WRONG_WAREHOUSE':
      return { kind: 'WRONG_WAREHOUSE', raw, other: r.otherWarehouseCode ?? null };
    default:
      return { kind: 'UNKNOWN', raw, offline: false };
  }
}

/**
 * 主数据缓存（04 §5、03 §5）：首次分页全量（进度）、之后增量（游标）+ 每日 digest 比对；
 * 本地 scan 解析与服务端同一套分类顺序（@wms3d/domain classifyScan）。
 */
export class MasterData {
  private skus = new Map<string, MdSku>();
  private barcodes = new Map<string, MdBarcode>();
  private byBarcode = new Map<string, MdBarcode>();
  private locations = new Map<string, MdLocation>();
  private byPayload = new Map<string, MdLocation>();
  private byCode = new Map<string, MdLocation>();
  private racks = new Set<string>();
  snap: MasterSnapshot;

  private readonly persist: MasterPersistence;

  constructor(
    persist: MasterPersistence,
    warehouseId: string,
    warehouseCode: string,
    knownWarehouseCodes: string[],
  ) {
    this.persist = persist;
    this.snap = {
      warehouseId,
      warehouseCode,
      knownWarehouseCodes,
      cursor: null,
      fullSyncedAt: null,
      lastSyncAt: null,
      skus: [],
      barcodes: [],
      locations: [],
    };
  }

  get ready(): boolean {
    return this.snap.fullSyncedAt !== null;
  }
  get counts() {
    return { skus: this.skus.size, barcodes: this.barcodes.size, locations: this.locations.size };
  }

  async load(): Promise<boolean> {
    const s = await this.persist.load(this.snap.warehouseId);
    if (!s) return false;
    this.snap = {
      ...s,
      warehouseCode: this.snap.warehouseCode,
      knownWarehouseCodes: this.snap.knownWarehouseCodes,
    };
    this.reindex();
    return true;
  }

  /** 同步：cursor 为空 = 首次全量。onProgress(done,total) */
  async sync(
    api: ApiClient,
    onProgress?: (done: number, total: number | null) => void,
  ): Promise<void> {
    let cursor = this.snap.cursor;
    const full = cursor === null;
    let total: number | null = null;
    let done = 0;
    for (;;) {
      const page = await api.r.syncMasterdata({
        query: { warehouseId: this.snap.warehouseId, ...(cursor ? { cursor } : {}), limit: 200 },
      });
      if (page.total !== undefined) total = page.total;
      for (const s of page.skus) this.skus.set(s.id, s);
      for (const b of page.barcodes) this.barcodes.set(b.id, b);
      for (const l of page.locations) this.locations.set(l.id, l);
      for (const t of page.tombstones) {
        if (t.entity === 'sku') this.skus.delete(t.id);
        if (t.entity === 'barcode') this.barcodes.delete(t.id);
        if (t.entity === 'location') this.locations.delete(t.id);
      }
      done += page.skus.length + page.barcodes.length + page.locations.length;
      onProgress?.(done, total);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    const now = new Date().toISOString();
    this.snap = {
      ...this.snap,
      cursor,
      lastSyncAt: now,
      fullSyncedAt: this.snap.fullSyncedAt ?? (full ? now : null),
      skus: [...this.skus.values()],
      barcodes: [...this.barcodes.values()],
      locations: [...this.locations.values()],
    };
    this.reindex();
    await this.persist.save(this.snap);
  }

  /** 每日 digest：计数不一致 → 下次全量重建。返回是否一致 */
  async checkDigest(api: ApiClient): Promise<boolean> {
    const d = await api.r.syncDigest({ query: { warehouseId: this.snap.warehouseId } });
    const c = this.counts;
    const ok = d.skus === c.skus && d.barcodes === c.barcodes && d.locations === c.locations;
    if (!ok) {
      this.snap = { ...this.snap, cursor: null };
      this.skus.clear();
      this.barcodes.clear();
      this.locations.clear();
    }
    return ok;
  }

  location(id: string): MdLocation | undefined {
    return this.locations.get(id);
  }
  locationByCode(code: string): MdLocation | undefined {
    return this.byCode.get(code);
  }
  sku(id: string): MdSku | undefined {
    return this.skus.get(id);
  }
  allLocations(): MdLocation[] {
    return [...this.locations.values()];
  }

  /** 本地分类（离线可用）。未知条码返回 kind=UNKNOWN */
  resolveLocal(raw: string): Resolved {
    const wc = this.snap.warehouseCode;
    const r = classifyScan(raw, {
      warehouseCode: wc,
      knownWarehouseCodes: new Set(this.snap.knownWarehouseCodes),
      lookupRegistry: (v) => {
        const l = this.byPayload.get(v);
        if (l) return { kind: 'LOCATION', warehouseCode: wc, entityId: l.id };
        if (v.startsWith(`${wc}.`) && this.racks.has(v.slice(wc.length + 1)))
          return { kind: 'RACK', warehouseCode: wc, entityId: v.slice(wc.length + 1) };
        const b = this.byBarcode.get(v);
        if (b) return { kind: 'SKU', warehouseCode: null, entityId: b.skuId };
        return null;
      },
      lookupLocationCode: (code) => this.byCode.get(code)?.id ?? null,
      lookupRackCode: (code) => (this.racks.has(code) ? code : null),
    });
    switch (r.kind) {
      case 'LOCATION': {
        const l = this.locations.get(r.entityId!)!;
        return { kind: 'LOCATION', raw, loc: { id: l.id, code: l.code, isActive: l.isActive } };
      }
      case 'RACK':
        return { kind: 'RACK', raw, rackCode: r.entityId! };
      case 'SKU': {
        const s = this.skus.get(r.entityId!);
        const b = this.byBarcode.get(r.text) ?? this.byBarcode.get(r.text.toUpperCase());
        if (!s || !b) return { kind: 'UNKNOWN', raw, offline: false };
        return {
          kind: 'SKU',
          raw,
          sku: { id: s.id, code: s.code, name: s.name },
          packQty: b.packQty,
          barcode: b.barcode,
        };
      }
      case 'WRONG_WAREHOUSE':
        return { kind: 'WRONG_WAREHOUSE', raw, other: r.otherWarehouseCode ?? null };
      default:
        return { kind: 'UNKNOWN', raw, offline: false };
    }
  }

  /**
   * 解析：先本地；本地未知且在线 → 服务端 scanResolve（新条码尚未同步到本机）。
   * 网络错误 → UNKNOWN + offline=true（离线暂存原文由流程决定）。
   */
  async resolve(api: ApiClient | null, raw: string): Promise<Resolved> {
    const local = this.resolveLocal(raw);
    if (local.kind !== 'UNKNOWN') return local;
    if (!api) return { kind: 'UNKNOWN', raw, offline: true };
    try {
      const r = await api.r.scanResolve({
        query: { warehouseId: this.snap.warehouseId, code: raw },
      });
      return fromServer(r, raw);
    } catch (e) {
      if (e instanceof ApiError && e.code !== 'NETWORK' && e.status > 0 && e.status < 500) throw e;
      return { kind: 'UNKNOWN', raw, offline: true };
    }
  }

  private reindex(): void {
    if (this.skus.size === 0 && this.snap.skus.length)
      for (const s of this.snap.skus) this.skus.set(s.id, s);
    if (this.barcodes.size === 0 && this.snap.barcodes.length)
      for (const b of this.snap.barcodes) this.barcodes.set(b.id, b);
    if (this.locations.size === 0 && this.snap.locations.length)
      for (const l of this.snap.locations) this.locations.set(l.id, l);
    this.byBarcode.clear();
    for (const b of this.barcodes.values()) this.byBarcode.set(b.barcode, b);
    this.byPayload.clear();
    this.byCode.clear();
    this.racks.clear();
    for (const l of this.locations.values()) {
      this.byPayload.set(l.payload, l);
      this.byCode.set(l.code, l);
      if (l.rackCode) this.racks.add(l.rackCode);
    }
  }
}
