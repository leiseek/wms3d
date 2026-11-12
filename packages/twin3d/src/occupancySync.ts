import type { Occupancy, WmsEvent } from '@wms3d/contracts';

/**
 * 实时更新编排（06 §6，D16/D17/M17/M-N3）。twin3d 不发请求：拉取函数由调用方注入（api-client）。
 * - stock.changed / locations.changed：layoutVersion ≠ 本地 → reloadTwin；否则防抖 500ms 全量拉 occupancy，
 *   最小间隔 PC 1s / 移动端 2s，仅页面可见时（不可见期间积压，可见后补一次）。
 * - layout.published 或拉取返回 LAYOUT_STALE（409）→ reloadTwin。
 * - SSE（重）连接 → 立即全量拉一次；无 SSE 时每 60s 轮询（ETag 由调用方处理，304 返回 null）。
 */
export interface OccupancySyncOptions {
  getLayoutVersion(): number | null;
  /** 拉 occupancy；304 返回 null；LAYOUT_STALE 抛出 { code: 'LAYOUT_STALE' } */
  fetchOccupancy(layoutVersion: number): Promise<Occupancy | null>;
  onOccupancy(o: Occupancy): void;
  /** 需要重载 TwinModel（布局已更新） */
  reloadTwin(reason: 'layout.published' | 'version-mismatch' | 'LAYOUT_STALE'): void;
  platform?: 'pc' | 'mobile';
  debounceMs?: number;
  minIntervalMs?: number;
  pollMs?: number;
  isVisible?: () => boolean;
  now?: () => number;
  onError?: (e: unknown) => void;
}

export interface OccupancySync {
  handleEvent(e: WmsEvent): void;
  /** SSE 已（重）连接：立即全量拉一次并停止轮询 */
  onConnected(): void;
  /** SSE 断开：开始 60s 轮询 */
  onDisconnected(): void;
  /** 页面可见性变化时调用（可见后补拉积压） */
  onVisibilityChange(): void;
  /** 立即拉（不经防抖，仍遵守最小间隔） */
  refresh(): void;
  dispose(): void;
}

export function createOccupancySync(o: OccupancySyncOptions): OccupancySync {
  const debounceMs = o.debounceMs ?? 500;
  const minInterval = o.minIntervalMs ?? (o.platform === 'mobile' ? 2000 : 1000);
  const pollMs = o.pollMs ?? 60_000;
  const now = o.now ?? (() => Date.now());
  const visible = o.isVisible ?? (() => typeof document === 'undefined' || !document.hidden);
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let gate: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let lastFetch = -Infinity;
  let inFlight = false;
  let pending = false;
  let disposed = false;

  const run = async (): Promise<void> => {
    if (disposed) return;
    if (!visible()) {
      pending = true;
      return;
    }
    const wait = lastFetch + minInterval - now();
    if (wait > 0) {
      if (!gate)
        gate = setTimeout(() => {
          gate = null;
          void run();
        }, wait);
      return;
    }
    if (inFlight) {
      pending = true;
      return;
    }
    const v = o.getLayoutVersion();
    if (v == null) return;
    inFlight = true;
    pending = false;
    lastFetch = now();
    try {
      const occ = await o.fetchOccupancy(v);
      if (!disposed && occ) {
        if (occ.layoutVersion !== o.getLayoutVersion()) o.reloadTwin('version-mismatch');
        else o.onOccupancy(occ);
      }
    } catch (e) {
      if ((e as { code?: string })?.code === 'LAYOUT_STALE') o.reloadTwin('LAYOUT_STALE');
      else o.onError?.(e);
    } finally {
      inFlight = false;
      if (pending && !disposed) schedule();
    }
  };

  const schedule = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      void run();
    }, debounceMs);
  };

  return {
    handleEvent(e) {
      if (disposed) return;
      if (e.event === 'layout.published') {
        if (e.data.layoutVersion !== o.getLayoutVersion()) o.reloadTwin('layout.published');
        return;
      }
      if (e.event === 'stock.changed' || e.event === 'locations.changed') {
        if (e.data.layoutVersion !== o.getLayoutVersion()) o.reloadTwin('version-mismatch');
        else schedule();
      }
    },
    onConnected() {
      if (poll) clearInterval(poll);
      poll = null;
      void run();
    },
    onDisconnected() {
      if (!poll) poll = setInterval(() => void run(), pollMs);
    },
    onVisibilityChange() {
      if (visible() && pending) void run();
    },
    refresh() {
      void run();
    },
    dispose() {
      disposed = true;
      if (debounce) clearTimeout(debounce);
      if (gate) clearTimeout(gate);
      if (poll) clearInterval(poll);
    },
  };
}
