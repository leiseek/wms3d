import type { DbHandle } from '../db/client.ts';
import {
  allowAllDevices,
  rejectAllVerifier,
  type DeviceGuard,
  type ScopeResolvers,
  type TokenVerifier,
} from './auth.ts';
import { EventBus } from './events.ts';
import { keyringFromEnv, type JwtKeyring } from './tokens.ts';

/**
 * 跨模块共享服务。模块在注册时可替换其中的可插拔实现（例：auth 模块设置 verifyToken，
 * locations/inventory/counts/labels 模块注册各自的 scope resolver）。
 */
export interface AppServices {
  db: DbHandle | null;
  bus: EventBus;
  verifyToken: TokenVerifier;
  scopeResolvers: ScopeResolvers;
  deviceGuard: DeviceGuard;
  /** 设备禁用状态缓存失效（patchDevice 调用；默认 no-op） */
  invalidateDevice: (deviceId?: string) => void;
  /** JWT 密钥环（WS-A1 签发/校验 access token） */
  jwt: JwtKeyring;
  config: AppConfig;
}

export interface AppConfig {
  databaseUrl: string | undefined;
  /** HS256 密钥（A1 使用）；开发缺省由 A1 决定生成策略 */
  jwtSecret: string | undefined;
  corsOrigins: string[];
  nodeEnv: string;
  /** 额外环境（JWT_KID、JWT_PREVIOUS_KEYS、APP_* 版本信息等），缺省 process.env */
  env?: NodeJS.ProcessEnv;
}

export function createServices(config: AppConfig, db: DbHandle | null): AppServices {
  return {
    db,
    bus: new EventBus(),
    verifyToken: rejectAllVerifier,
    scopeResolvers: {},
    deviceGuard: allowAllDevices,
    invalidateDevice: () => undefined,
    jwt: keyringFromEnv(
      { ...(config.env ?? {}), JWT_SECRET: config.jwtSecret ?? config.env?.JWT_SECRET },
      config.nodeEnv,
    ),
    config,
  };
}
