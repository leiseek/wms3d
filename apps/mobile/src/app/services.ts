import { create } from 'zustand';
import { ApiError, type ApiClient } from '@wms3d/api-client';
import { ScanHub, type ScanEvent } from '@wms3d/scanner';
import { MasterData } from '../core/masterdata.ts';
import { Outbox } from '../core/outbox.ts';
import type { OutboxEntry } from '../core/outbox-types.ts';
import { Session, type SessionState } from '../core/session.ts';
import { isNative, Scanner } from '../native/bridge.ts';
import {
  createOutboxStore,
  IdbMasterPersistence,
  requestPersistentStorage,
  secureStore,
} from '../platform/stores.ts';
import {
  deviceId,
  loadServerConfig,
  loadSettings,
  saveSettings,
  type AppSettings,
  type ServerConfig,
} from './config.ts';
import { attachScanSources } from './scan-input.ts';

export const APP_VERSION = '0.1.0';
const HEARTBEAT_MS = 60_000;
const INCREMENTAL_SYNC_MS = 5 * 60_000;
const DIGEST_MS = 24 * 3600_000;
const PROBE_MS = 5_000;

export interface RejectNotice {
  id: string;
  title: string;
  message: string;
  /** outbox 条目（服务端拒绝）；本地校验错误为 null */
  entryId: string | null;
  canAutoRetry: boolean;
}

export type Phase = 'boot' | 'config' | 'pin-failed' | 'login' | 'syncing' | 'ready';

export interface UiState {
  phase: Phase;
  pinError: string | null;
  session: SessionState | null;
  online: boolean;
  pending: number;
  rejectedCount: number;
  authBlocked: string | null;
  sync: { done: number; total: number | null; error: string | null } | null;
  mdReady: boolean;
  rejects: RejectNotice[];
  entries: OutboxEntry[];
  lastScans: ScanEvent[];
  settings: AppSettings;
  sppState: string;
  tab: 'work' | 'query' | 'twin' | 'more';
  /** 定位联动（查询 → 3D） */
  highlight: { locationIds: string[]; label: string } | null;
}

export const useUi = create<UiState>(() => ({
  phase: 'boot',
  pinError: null,
  session: null,
  online: true,
  pending: 0,
  rejectedCount: 0,
  authBlocked: null,
  sync: null,
  mdReady: false,
  rejects: [],
  entries: [],
  lastScans: [],
  settings: loadSettings(),
  sppState: 'idle',
  tab: 'work',
  highlight: null,
}));

const set = useUi.setState;

/** 应用级服务（单例）：会话、outbox、主数据、扫码汇聚、网络状态、心跳 */
export class Services {
  readonly hub = new ScanHub();
  readonly deviceId = deviceId();
  session!: Session;
  outbox!: Outbox;
  md: MasterData | null = null;
  server: ServerConfig | null;
  private fetchImpl: typeof fetch;
  private timers: ReturnType<typeof setInterval>[] = [];
  private scanHandler: ((e: ScanEvent) => void) | null = null;
  private lastDigestAt = 0;

  constructor(opts: { fetch?: typeof fetch; server?: ServerConfig | null } = {}) {
    const base = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    // 网络状态：以真实请求结果为准（navigator.onLine 在内网/弱网下不可靠）
    this.fetchImpl = async (input, init) => {
      try {
        const r = await base(input, init);
        if (!useUi.getState().online) this.setOnline(true);
        return r;
      } catch (e) {
        if ((e as Error).name !== 'AbortError') this.setOnline(false);
        throw e;
      }
    };
    this.server = opts.server !== undefined ? opts.server : loadServerConfig();
  }

  get api(): ApiClient {
    return this.session.api;
  }

  /** 浏览器调试默认同源（Vite 代理 /api）；APK 必须先配置服务器 */
  get needsServerConfig(): boolean {
    return isNative && !this.server;
  }

  async boot(): Promise<void> {
    await requestPersistentStorage();
    this.session = new Session({
      baseUrl: this.server?.api ?? '',
      deviceId: this.deviceId,
      appVersion: APP_VERSION,
      secure: secureStore,
      fetch: this.fetchImpl,
      deviceModel: navigator.userAgent.slice(0, 64),
      kv: {
        get: (k) => localStorage.getItem(k),
        set: (k, v) => localStorage.setItem(k, v),
        remove: (k) => localStorage.removeItem(k),
      },
      onChange: (s) => set({ session: s }),
    });
    const store = await createOutboxStore();
    this.outbox = new Outbox(store, () => this.session.api, Date.now, {
      changed: () => void this.refreshOutbox(),
      rejected: (e) => this.notifyRejected(e),
      authBlocked: (r) => set({ authBlocked: r }),
      report: (e) =>
        console.error('[wms3d] IDEMPOTENCY_KEY_REUSED（客户端 bug）', e.id, e.lastError),
    });
    await this.outbox.init();
    await this.refreshOutbox();
    attachScanSources(this.hub);
    this.hub.onScan((e) => this.route(e));
    void Scanner.addListener('sppState', (e) => set({ sppState: e.state }));
    void this.applyNativeSettings(useUi.getState().settings);

    if (this.needsServerConfig) return set({ phase: 'config' });
    if (this.server?.pin && isNative) {
      // SPKI 只在首次配置与每次启动时校验（v2.1 M-N19）
      const r = await Scanner.verifyServerPin({
        url: `${this.server.api}/api/v1/health`,
        pin: this.server.pin,
      });
      if (!r.ok) return set({ phase: 'pin-failed', pinError: r.reason ?? '证书指纹不符' });
    }
    let s: SessionState | null = null;
    try {
      s = await this.session.restore();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NETWORK') s = this.session.restoreOffline();
    }
    if (!s) return set({ phase: 'login' });
    await this.afterLogin(s);
  }

  async login(username: string, password: string): Promise<void> {
    const s = await this.session.login(username, password);
    await this.afterLogin(s);
  }

  /** 登出不要求 outbox 为空（换班代交）；待传单据由下一位登录用户的令牌继续发送 */
  async logout(): Promise<void> {
    await this.session.logout();
    this.stopTimers();
    set({ phase: 'login', session: null, tab: 'work' });
  }

  async switchWarehouse(id: string): Promise<void> {
    this.session.setWarehouse(id);
    await this.afterLogin(this.session.current!);
  }

  private async afterLogin(s: SessionState): Promise<void> {
    set({ session: s });
    const wh = s.user.warehouses.find((w) => w.id === s.warehouseId);
    this.md = new MasterData(
      new IdbMasterPersistence(),
      s.warehouseId,
      wh?.code ?? '',
      s.user.warehouses.map((w) => w.code),
    );
    await this.md.load();
    set({ mdReady: this.md.ready });
    if (this.outbox.authBlocked && this.session.hasValidLogin) await this.outbox.resumeAuth();
    else this.outbox.kick();
    this.startTimers();
    if (!this.md.ready) {
      set({ phase: 'syncing' });
      await this.syncMasterdata(true);
    } else {
      set({ phase: 'ready' });
      void this.syncMasterdata(false);
    }
  }

  /** 首次全量（进度条）/ 增量；首次同步完成前禁止离线作业 */
  async syncMasterdata(first: boolean): Promise<void> {
    if (!this.md) return;
    try {
      if (first) set({ sync: { done: 0, total: null, error: null } });
      if (Date.now() - this.lastDigestAt > DIGEST_MS && this.md.ready) {
        this.lastDigestAt = Date.now();
        await this.md.checkDigest(this.api);
      }
      await this.md.sync(
        this.api,
        (done, total) => first && set({ sync: { done, total, error: null } }),
      );
      set({ mdReady: this.md.ready, phase: 'ready', sync: null });
    } catch (e) {
      if (first) set({ sync: { done: 0, total: null, error: (e as Error).message } });
    }
  }

  // ---------- 扫码路由 ----------
  /** 当前页面注册扫码处理（后注册者生效；返回注销函数） */
  setScanHandler(h: ((e: ScanEvent) => void) | null): () => void {
    this.scanHandler = h;
    return () => {
      if (this.scanHandler === h) this.scanHandler = null;
    };
  }

  private route(e: ScanEvent): void {
    set((st) => ({ lastScans: [e, ...st.lastScans].slice(0, 50) }));
    // 打断式拒绝遮罩期间的扫码全部丢弃并播放错误音（v2.1 M-N11）
    if (useUi.getState().rejects.length > 0) {
      void this.feedback('error');
      return;
    }
    this.scanHandler?.(e);
  }

  feedback(type: 'ok' | 'warn' | 'error'): Promise<void> {
    return Scanner.feedback({ type }).catch(() => undefined);
  }

  // ---------- 拒绝 ----------
  pushReject(n: Omit<RejectNotice, 'id'>): void {
    void this.feedback('error');
    set((st) => ({ rejects: [...st.rejects, { ...n, id: crypto.randomUUID() }] }));
  }

  ackReject(id: string): void {
    set((st) => ({ rejects: st.rejects.filter((r) => r.id !== id) }));
  }

  private notifyRejected(e: OutboxEntry): void {
    this.pushReject({
      title: e.lastError?.code === 'INSUFFICIENT_STOCK' ? '库存不足' : '服务端拒绝',
      message: `${e.label}\n${e.lastError?.message ?? ''}（${e.lastError?.code ?? ''}）`,
      entryId: e.id,
      canAutoRetry: e.canAutoRetry,
    });
  }

  async refreshOutbox(): Promise<void> {
    const all = await this.outbox.list();
    set({
      entries: all.slice(-200),
      pending: all.filter((e) =>
        ['PENDING', 'SENDING', 'WAITING_STOCK', 'BLOCKED_AUTH'].includes(e.status),
      ).length,
      rejectedCount: all.filter((e) => e.status === 'REJECTED').length,
    });
  }

  // ---------- 网络 / 心跳 ----------
  private setOnline(on: boolean): void {
    set({ online: on });
    if (on) this.outbox?.kick();
  }

  private startTimers(): void {
    this.stopTimers();
    const beat = () => void this.heartbeat();
    beat();
    this.timers.push(setInterval(beat, HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.syncMasterdata(false), INCREMENTAL_SYNC_MS));
    // 离线探测：恢复后立即补传
    this.timers.push(
      setInterval(() => {
        if (!useUi.getState().online) void this.api.r.health({}).catch(() => undefined);
      }, PROBE_MS),
    );
  }

  private stopTimers(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async heartbeat(): Promise<void> {
    if (document.visibilityState === 'hidden' || !this.session.hasValidLogin) return;
    try {
      const r = await this.api.r.heartbeat({
        body: {
          deviceId: this.deviceId,
          appVersion: APP_VERSION,
          pendingOutbox: await this.outbox.pendingCount(),
          ...(this.session.current ? { warehouseId: this.session.current.warehouseId } : {}),
        },
      });
      if (r.disabled)
        this.pushReject({
          title: '设备已被禁用',
          message: '请联系管理员',
          entryId: null,
          canAutoRetry: false,
        });
    } catch {
      /* 心跳失败不提示 */
    }
  }

  // ---------- 设置 ----------
  updateSettings(p: Partial<AppSettings>): void {
    const s = { ...useUi.getState().settings, ...p };
    saveSettings(s);
    set({ settings: s });
    void this.applyNativeSettings(s);
  }

  private async applyNativeSettings(s: AppSettings): Promise<void> {
    await Scanner.setHidConfig({ treatSoftKeyboardAsScanner: s.treatSoftKeyboardAsScanner }).catch(
      () => undefined,
    );
    if (s.sppAutoConnect && s.sppAddress && isNative)
      await Scanner.connectSpp({
        address: s.sppAddress,
        terminator: s.sppTerminator,
        charset: s.sppCharset,
        allowReflectionFallback: s.allowReflectionFallback,
      }).catch(() => undefined);
  }
}

let services: Services | null = null;
export function getServices(): Services {
  if (!services) throw new Error('services not initialised');
  return services;
}
export function initServices(opts: ConstructorParameters<typeof Services>[0] = {}): Services {
  services = new Services(opts);
  return services;
}
