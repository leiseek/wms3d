import { ApiError, createApiClient, type ApiClient } from '@wms3d/api-client';
import type { LoginResponse, Me } from '@wms3d/contracts';

/** 安全存储：原生 = 插件 AES-GCM + Android Keystore；web 调试 = localStorage（仅开发） */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemorySecureStore implements SecureStore {
  m = new Map<string, string>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
  }
  async remove(k: string) {
    this.m.delete(k);
  }
}

const RT_KEY = 'wms3d.refreshToken';
const SESSION_KEY = 'wms3d.session';

export interface SessionState {
  user: Me;
  sessionId: string;
  warehouseId: string;
}

export interface SessionOptions {
  baseUrl: string;
  deviceId: string;
  appVersion: string;
  secure: SecureStore;
  fetch?: typeof fetch;
  deviceName?: string;
  deviceModel?: string;
  /** 会话状态变化（登录、登出、刷新失败） */
  onChange?: (s: SessionState | null) => void;
  /** 非敏感会话信息持久化（user/sessionId/warehouseId），缺省不持久化 */
  kv?: { get(k: string): string | null; set(k: string, v: string): void; remove(k: string): void };
}

/**
 * 登录会话（04 §1、02 §6.6）：client='mobile'，refreshToken 只放安全存储，access token 只在内存；
 * 保存 session.id 供离线单的 performerSessionId 使用。刷新 single-flight 由 api-client 保证。
 */
export class Session {
  private accessToken: string | null = null;
  private state: SessionState | null = null;
  readonly api: ApiClient;
  /** 服务器时间 − 本地时间（ms） */
  clockSkewMs = 0;

  private readonly o: SessionOptions;

  constructor(o: SessionOptions) {
    this.o = o;
    // 服务器地址变更需先清空本地数据并重建 Session（04 §1），因此 baseUrl 在构造时固定
    this.api = createApiClient({
      baseUrl: o.baseUrl,
      getAccessToken: () => this.accessToken,
      refresh: () => this.refresh(),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      credentials: 'omit',
    });
  }

  get current(): SessionState | null {
    return this.state;
  }
  get hasValidLogin(): boolean {
    return this.state !== null && this.accessToken !== null;
  }
  /** 测试 / 诊断 */
  get token(): string | null {
    return this.accessToken;
  }

  async login(username: string, password: string): Promise<SessionState> {
    const r = (await this.api.r.authLogin({
      body: {
        username,
        password,
        deviceId: this.o.deviceId,
        client: 'mobile',
        appVersion: this.o.appVersion,
        ...(this.o.deviceName ? { deviceName: this.o.deviceName } : {}),
        ...(this.o.deviceModel ? { deviceModel: this.o.deviceModel } : {}),
      },
    })) as LoginResponse;
    this.accessToken = r.accessToken;
    this.clockSkewMs = Date.parse(r.serverTime) - Date.now();
    if (r.refreshToken) await this.o.secure.set(RT_KEY, r.refreshToken);
    const prevWh = this.state?.warehouseId;
    const wh =
      r.user.warehouses.find((w) => w.id === prevWh)?.id ??
      r.user.warehouses.find((w) => w.id === this.loadKv()?.warehouseId)?.id ??
      r.user.warehouses[0]?.id ??
      '';
    this.set({ user: r.user, sessionId: r.session.id, warehouseId: wh });
    return this.state!;
  }

  /** 启动时恢复：有 refreshToken → 刷新 → /me */
  async restore(): Promise<SessionState | null> {
    const kv = this.loadKv();
    if (!kv) return null;
    this.state = kv;
    if (!(await this.refresh())) {
      this.state = null;
      return null;
    }
    try {
      const me = (await this.api.r.me({})) as Me;
      this.set({ ...kv, user: me });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NETWORK') return this.state; // 离线：沿用缓存
      throw e;
    }
    return this.state;
  }

  /** 离线启动：没有网络时沿用上次会话信息（作业只写 outbox） */
  restoreOffline(): SessionState | null {
    const kv = this.loadKv();
    if (kv) this.state = kv;
    return this.state;
  }

  async refresh(): Promise<boolean> {
    const rt = await this.o.secure.get(RT_KEY);
    if (!rt) {
      this.accessToken = null;
      return false;
    }
    try {
      const r = await this.api.r.authRefresh({
        body: { refreshToken: rt, deviceId: this.o.deviceId },
      });
      this.accessToken = r.accessToken;
      if (r.refreshToken) await this.o.secure.set(RT_KEY, r.refreshToken);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'NETWORK') throw e;
      this.accessToken = null;
      await this.o.secure.remove(RT_KEY);
      this.o.onChange?.(this.state);
      return false;
    }
  }

  setWarehouse(id: string): void {
    if (!this.state) return;
    if (!this.state.user.warehouses.some((w) => w.id === id)) throw new Error('无权访问该仓库');
    this.set({ ...this.state, warehouseId: id });
  }

  /** 登出不要求 outbox 为空（换班代交） */
  async logout(): Promise<void> {
    try {
      if (this.accessToken)
        await this.api.r.authLogout({
          body: { refreshToken: (await this.o.secure.get(RT_KEY)) ?? undefined },
        });
    } catch {
      /* 离线登出：本地清除即可，服务端会话按过期关闭 */
    }
    this.accessToken = null;
    await this.o.secure.remove(RT_KEY);
    this.state = null;
    this.o.kv?.remove(SESSION_KEY);
    this.o.onChange?.(null);
  }

  /** 测试钩子：丢弃内存中的 access token（模拟过期） */
  dropAccessToken(): void {
    this.accessToken = null;
  }

  private set(s: SessionState): void {
    this.state = s;
    this.o.kv?.set(SESSION_KEY, JSON.stringify(s));
    this.o.onChange?.(s);
  }

  private loadKv(): SessionState | null {
    const raw = this.o.kv?.get(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionState;
    } catch {
      return null;
    }
  }
}
