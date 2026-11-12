import type { LayoutDoc, LayoutVersion } from '@wms3d/contracts';

/** 文档差异摘要（三方提示用）：以 key/code 为身份。 */
export interface DocDelta {
  racks: { added: string[]; removed: string[]; changed: string[] };
  zones: { added: string[]; removed: string[]; changed: string[] };
  floorAreas: { added: string[]; removed: string[]; changed: string[] };
  rackTypes: { added: string[]; removed: string[]; changed: string[] };
  warehouseChanged: boolean;
}

function delta<T>(a: readonly T[], b: readonly T[], id: (x: T) => string) {
  const ma = new Map(a.map((x) => [id(x), JSON.stringify(x)]));
  const mb = new Map(b.map((x) => [id(x), JSON.stringify(x)]));
  return {
    added: [...mb.keys()].filter((k) => !ma.has(k)),
    removed: [...ma.keys()].filter((k) => !mb.has(k)),
    changed: [...mb.keys()].filter((k) => ma.has(k) && ma.get(k) !== mb.get(k)),
  };
}

export function docDelta(base: LayoutDoc, other: LayoutDoc): DocDelta {
  return {
    racks: delta(base.racks, other.racks, (r) => r.key),
    zones: delta(base.zones, other.zones, (z) => z.code),
    floorAreas: delta(base.floorAreas, other.floorAreas, (f) => f.locationCode),
    rackTypes: delta(base.rackTypes, other.rackTypes, (t) => t.key),
    warehouseChanged: JSON.stringify(base.warehouse) !== JSON.stringify(other.warehouse),
  };
}

export const deltaSize = (d: DocDelta) =>
  (['racks', 'zones', 'floorAreas', 'rackTypes'] as const).reduce(
    (n, k) => n + d[k].added.length + d[k].removed.length + d[k].changed.length,
    d.warehouseChanged ? 1 : 0,
  );

/** 双方都改动过的对象（同 key）= 真冲突。 */
export function conflictingKeys(mine: DocDelta, theirs: DocDelta): string[] {
  const out: string[] = [];
  for (const k of ['racks', 'zones', 'floorAreas', 'rackTypes'] as const) {
    const m = new Set([...mine[k].added, ...mine[k].removed, ...mine[k].changed]);
    for (const x of [...theirs[k].added, ...theirs[k].removed, ...theirs[k].changed])
      if (m.has(x)) out.push(`${k}:${x}`);
  }
  return out;
}

export interface Conflict {
  /** 上次成功保存/载入的版本（三方中的 base） */
  base: LayoutDoc;
  mine: LayoutDoc;
  server: LayoutVersion;
  mineDelta: DocDelta;
  serverDelta: DocDelta;
  overlapping: string[];
}

export type SaveState =
  | { status: 'idle' }
  | { status: 'dirty' }
  | { status: 'saving' }
  | { status: 'saved'; at: number }
  | { status: 'conflict'; conflict: Conflict }
  | { status: 'error'; message: string };

export interface DraftSyncDeps {
  save(doc: LayoutDoc, rowVersion: number): Promise<LayoutVersion>;
  fetchDraft(): Promise<LayoutVersion>;
  isPreconditionFailed(e: unknown): boolean;
  onState(s: SaveState): void;
  idleMs?: number;
}

/**
 * 草稿自动保存（05 §2.2）：**空闲 2s 且有变化才保存**（PUT If-Match rowVersion）；412 → 拉服务器草稿做三方对比，
 * 由用户选择 保留我的 / 采用服务器 / 导出我的副本后重载。框架无关，便于单测。
 */
export class DraftSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private savedJson: string;
  private inflight: Promise<void> | null = null;
  private latest: LayoutDoc;
  private paused = false;
  base: LayoutDoc;
  rowVersion: number;

  private readonly deps: DraftSyncDeps;

  constructor(initial: LayoutVersion, deps: DraftSyncDeps) {
    this.deps = deps;
    this.base = initial.doc;
    this.latest = initial.doc;
    this.rowVersion = initial.rowVersion;
    this.savedJson = JSON.stringify(initial.doc);
  }

  get dirty() {
    return JSON.stringify(this.latest) !== this.savedJson;
  }

  /** 文档变化时调用：重置空闲计时器。 */
  touch(doc: LayoutDoc) {
    this.latest = doc;
    if (this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    if (!this.dirty) {
      this.deps.onState({ status: 'idle' });
      return;
    }
    this.deps.onState({ status: 'dirty' });
    this.timer = setTimeout(() => void this.flush(), this.deps.idleMs ?? 2000);
  }

  /** 立即保存（发布前、离开页面前）。冲突时保持暂停直到 resolve*。返回是否已与服务器一致。 */
  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inflight) await this.inflight;
    if (this.paused) return false;
    if (!this.dirty) return true;
    const doc = this.latest;
    const json = JSON.stringify(doc);
    let ok = false;
    this.inflight = (async () => {
      this.deps.onState({ status: 'saving' });
      try {
        const v = await this.deps.save(doc, this.rowVersion);
        this.rowVersion = v.rowVersion;
        this.savedJson = json;
        this.base = doc;
        ok = true;
        this.deps.onState(this.dirty ? { status: 'dirty' } : { status: 'saved', at: Date.now() });
      } catch (e) {
        if (this.deps.isPreconditionFailed(e)) {
          this.paused = true;
          try {
            const server = await this.deps.fetchDraft();
            const mineDelta = docDelta(this.base, doc);
            const serverDelta = docDelta(this.base, server.doc);
            this.deps.onState({
              status: 'conflict',
              conflict: {
                base: this.base,
                mine: doc,
                server,
                mineDelta,
                serverDelta,
                overlapping: conflictingKeys(mineDelta, serverDelta),
              },
            });
          } catch (e2) {
            this.deps.onState({ status: 'error', message: (e2 as Error).message });
          }
        } else this.deps.onState({ status: 'error', message: (e as Error).message });
      }
    })();
    await this.inflight;
    this.inflight = null;
    if (ok && this.dirty) return this.flush();
    return ok;
  }

  /** 保留我的：以服务器 rowVersion 覆盖保存。 */
  async keepMine(server: LayoutVersion) {
    this.rowVersion = server.rowVersion;
    this.base = server.doc;
    this.savedJson = JSON.stringify(server.doc);
    this.paused = false;
    return this.flush();
  }

  /** 采用服务器（或"导出我的副本后重载"）：返回应载入编辑器的文档。 */
  adoptServer(server: LayoutVersion): LayoutDoc {
    this.rowVersion = server.rowVersion;
    this.base = server.doc;
    this.latest = server.doc;
    this.savedJson = JSON.stringify(server.doc);
    this.paused = false;
    this.deps.onState({ status: 'saved', at: Date.now() });
    return server.doc;
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
