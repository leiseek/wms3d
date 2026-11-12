import { z } from 'zod';
import { DeviceId, Id, Role, Timestamp, WarehouseCode } from './common.ts';

export const WarehouseRef = z
  .object({ id: Id, code: WarehouseCode, name: z.string() })
  .meta({ id: 'WarehouseRef' });

export const Me = z
  .object({
    id: Id,
    username: z.string(),
    displayName: z.string(),
    role: Role,
    allWarehouses: z.boolean(),
    warehouses: z.array(WarehouseRef).describe('可访问的仓库（all_warehouses 时为全部）'),
    mustChangePassword: z.boolean(),
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof Me>;

/** 设备会话（02 §6.6）：登录开启，登出/过期关闭。换班代交按 sessionId 校验，不依赖设备时钟（R3）。 */
export const DeviceSession = z
  .object({
    id: Id,
    deviceId: DeviceId,
    userId: Id,
    startedAt: Timestamp,
    endedAt: Timestamp.nullable(),
  })
  .meta({ id: 'DeviceSession' });

export const LoginRequest = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
    deviceId: DeviceId,
    deviceName: z.string().max(64).optional(),
    deviceModel: z.string().max(64).optional(),
    appVersion: z.string().max(32).optional(),
    client: z
      .enum(['web', 'mobile'])
      .describe('web：refresh 走 HttpOnly cookie；mobile：refresh 在响应体'),
  })
  .meta({ id: 'LoginRequest' });

export const TokenResponse = z
  .object({
    accessToken: z.string(),
    expiresIn: z.number().int().describe('秒'),
    refreshToken: z.string().optional().describe('仅 client=mobile'),
    serverTime: Timestamp.describe('客户端据此计算时钟偏移（R3）'),
  })
  .meta({ id: 'TokenResponse' });

export const LoginResponse = TokenResponse.extend({ user: Me, session: DeviceSession }).meta({
  id: 'LoginResponse',
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z
  .object({
    refreshToken: z.string().optional().describe('mobile 必填；web 用 cookie'),
    deviceId: DeviceId,
  })
  .meta({ id: 'RefreshRequest' });

export const LogoutRequest = z
  .object({ refreshToken: z.string().optional() })
  .meta({ id: 'LogoutRequest' });

export const ChangePasswordRequest = z
  .object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(8).max(256) })
  .meta({ id: 'ChangePasswordRequest' });

/** JWT access token claims（03 §2）。 */
export const AccessClaims = z.object({
  sub: Id,
  role: Role,
  wh: z.union([z.literal('all'), z.array(Id)]),
  did: DeviceId,
  sid: Id.describe('device_sessions.id'),
  exp: z.number().int(),
  iat: z.number().int(),
});
export type AccessClaims = z.infer<typeof AccessClaims>;
