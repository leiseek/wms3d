import type { Role } from '@wms3d/contracts';

/**
 * 请求认证上下文（03 §1.1）。由 TokenVerifier 从 Bearer access token 解出；WS-A1 实现 verifier（jose，HS256）。
 * 仓库授权以 DB 为准（权限变更即时生效，B-N5），verifier 负责加载 warehouseIds。
 */
export interface AuthContext {
  userId: string;
  role: Role;
  /** 'all' = all_warehouses=true */
  warehouseIds: readonly string[] | 'all';
  /** JWT did */
  deviceId: string;
  /** JWT sid（device_sessions.id） */
  sessionId: string;
  mustChangePassword: boolean;
}

export type TokenVerifier = (token: string) => Promise<AuthContext | null>;

/** 默认 verifier：一律拒绝（A1 未接入前只有 public 路由可用）。 */
export const rejectAllVerifier: TokenVerifier = async () => null;

export function canAccessWarehouse(auth: AuthContext, warehouseId: string): boolean {
  return auth.warehouseIds === 'all' || auth.warehouseIds.includes(warehouseId);
}

/** 资源 → 仓库 id 解析（scope.from='resource'）；返回 null = 资源不存在（→ 404）。 */
export type ScopeResolver = (resourceId: string) => Promise<string | null>;
export type ScopeResolvers = Partial<
  Record<'location' | 'txn' | 'count' | 'reprint', ScopeResolver>
>;

/** checksDevice 路由的设备校验（03 §2，DEVICE_DISABLED）。A1 实现；默认放行。 */
export type DeviceGuard = (deviceId: string) => Promise<'ok' | 'disabled'>;
export const allowAllDevices: DeviceGuard = async () => 'ok';
