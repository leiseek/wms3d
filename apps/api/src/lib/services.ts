import type { DbHandle } from '../db/client.ts';
import {
  allowAllDevices,
  rejectAllVerifier,
  type DeviceGuard,
  type ScopeResolvers,
  type TokenVerifier,
} from './auth.ts';
import { EventBus } from './events.ts';

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
  config: AppConfig;
}

export interface AppConfig {
  databaseUrl: string | undefined;
  /** HS256 密钥（A1 使用）；开发缺省由 A1 决定生成策略 */
  jwtSecret: string | undefined;
  corsOrigins: string[];
  nodeEnv: string;
}

export function createServices(config: AppConfig, db: DbHandle | null): AppServices {
  return {
    db,
    bus: new EventBus(),
    verifyToken: rejectAllVerifier,
    scopeResolvers: {},
    deviceGuard: allowAllDevices,
    config,
  };
}
