import { z } from 'zod';
import { DeviceId, Id, Role, Timestamp } from './common.ts';
import { WarehouseRef } from './auth.ts';

export const User = z
  .object({
    id: Id,
    username: z.string(),
    displayName: z.string(),
    role: Role,
    allWarehouses: z.boolean(),
    warehouses: z.array(WarehouseRef),
    isActive: z.boolean(),
    mustChangePassword: z.boolean(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof User>;

export const UserCreate = z
  .object({
    username: z.string().regex(/^[A-Za-z0-9_.-]{2,64}$/),
    displayName: z.string().min(1).max(64),
    role: Role,
    allWarehouses: z.boolean().default(false),
    warehouseIds: z.array(Id).default([]),
    temporaryPassword: z.string().min(8).max(256),
  })
  .meta({ id: 'UserCreate' });

export const UserPatch = z
  .object({
    displayName: z.string().min(1).max(64),
    role: Role,
    allWarehouses: z.boolean(),
    warehouseIds: z.array(Id),
    isActive: z.boolean(),
  })
  .partial()
  .meta({ id: 'UserPatch' });

export const ResetPasswordRequest = z
  .object({ temporaryPassword: z.string().min(8).max(256) })
  .meta({ id: 'ResetPasswordRequest' });

export const UsersQuery = z.object({
  q: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().max(200).optional(),
});

export const Device = z
  .object({
    id: DeviceId,
    name: z.string().nullable(),
    model: z.string().nullable(),
    lastUserId: Id.nullable(),
    lastSeenAt: Timestamp.nullable(),
    appVersion: z.string().nullable(),
    pendingOutbox: z.number().int().nonnegative(),
    disabledAt: Timestamp.nullable(),
  })
  .meta({ id: 'Device' });

export const DevicePatch = z
  .object({ name: z.string().max(64), disabled: z.boolean() })
  .partial()
  .meta({ id: 'DevicePatch' });

export const HeartbeatRequest = z
  .object({
    deviceId: DeviceId,
    appVersion: z.string().max(32),
    pendingOutbox: z.number().int().nonnegative(),
    warehouseId: Id.optional(),
  })
  .meta({ id: 'HeartbeatRequest' });
export const HeartbeatResponse = z
  .object({ serverTime: Timestamp, disabled: z.boolean() })
  .meta({ id: 'HeartbeatResponse' });

export const AppVersion = z
  .object({
    latest: z.string(),
    minSupported: z.string(),
    apkUrl: z.string().nullable(),
    releaseNotes: z.string().nullable(),
  })
  .meta({ id: 'AppVersion' });
