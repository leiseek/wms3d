import { create } from 'zustand';
import type { Me } from '@wms3d/contracts';
import { api, deviceId, refreshSession, setAccessToken } from './api';

const WH_KEY = 'wms3d.warehouseId';

interface SessionState {
  status: 'booting' | 'anonymous' | 'authenticated';
  me: Me | null;
  warehouseId: string | null;
  boot(): Promise<void>;
  login(username: string, password: string): Promise<Me>;
  logout(): Promise<void>;
  reloadMe(): Promise<Me | null>;
  expire(): void;
  setWarehouse(id: string): void;
}

function pickWarehouse(me: Me): string | null {
  const saved = localStorage.getItem(WH_KEY);
  if (saved && me.warehouses.some((w) => w.id === saved)) return saved;
  return me.warehouses[0]?.id ?? null;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'booting',
  me: null,
  warehouseId: null,
  async boot() {
    if (await refreshSession()) {
      try {
        await get().reloadMe();
        return;
      } catch {
        /* fallthrough */
      }
    }
    set({ status: 'anonymous', me: null });
  },
  async login(username, password) {
    const r = await api.r.authLogin({
      body: { username, password, deviceId: deviceId(), client: 'web', deviceName: 'PC 浏览器' },
    });
    setAccessToken(r.accessToken);
    set({ status: 'authenticated', me: r.user, warehouseId: pickWarehouse(r.user) });
    return r.user;
  },
  async logout() {
    try {
      await api.r.authLogout({ body: {} });
    } catch {
      /* 已过期也视为登出 */
    }
    setAccessToken(null);
    set({ status: 'anonymous', me: null });
  },
  async reloadMe() {
    const me = await api.r.me({});
    set({ status: 'authenticated', me, warehouseId: pickWarehouse(me) });
    return me;
  },
  expire() {
    setAccessToken(null);
    set({ status: 'anonymous', me: null });
  },
  setWarehouse(id) {
    localStorage.setItem(WH_KEY, id);
    set({ warehouseId: id });
  },
}));

/** 当前仓库 id（页面在 RequireWarehouse 内使用，保证非空）。 */
export function useWarehouseId(): string {
  const id = useSession((s) => s.warehouseId);
  if (!id) throw new Error('未选择仓库');
  return id;
}
export const useMe = () => useSession((s) => s.me);
