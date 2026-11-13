import { EventEmitter } from 'node:events';
import type { WmsEvent } from '@wms3d/contracts';

/**
 * 进程内事件总线（02 §8）。写路径在事务提交后 publish；SSE 模块（WS-A2）按仓库订阅并推送。
 * 单进程部署（ADR-0001），无需外部消息中间件。
 */
/** 会话失效（登出、停用账号、撤权、禁设备）；SSE 订阅后主动关流（CR1 #1）。 */
export interface AuthInvalidation {
  sessionIds?: string[];
  userId?: string;
  exceptSessionId?: string;
  deviceId?: string;
  /** 该用户被撤销的仓库（SSE 只关这些仓的连接） */
  revokeWarehouses?: { userId: string; warehouseIds: string[] };
}

export class EventBus {
  private readonly ee = new EventEmitter();
  private readonly auth = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
    this.auth.setMaxListeners(0);
  }
  publish(warehouseId: string, event: WmsEvent): void {
    this.ee.emit(warehouseId, event);
    this.ee.emit('*', warehouseId, event);
  }
  subscribe(warehouseId: string, fn: (e: WmsEvent) => void): () => void {
    this.ee.on(warehouseId, fn);
    return () => this.ee.off(warehouseId, fn);
  }
  subscribeAll(fn: (warehouseId: string, e: WmsEvent) => void): () => void {
    this.ee.on('*', fn);
    return () => this.ee.off('*', fn);
  }
  invalidateAuth(e: AuthInvalidation): void {
    this.auth.emit('x', e);
  }
  subscribeAuth(fn: (e: AuthInvalidation) => void): () => void {
    this.auth.on('x', fn);
    return () => this.auth.off('x', fn);
  }
}

export function authHitsConnection(
  e: AuthInvalidation,
  c: { sessionId: string; userId: string; deviceId: string | null; warehouseId: string },
): boolean {
  if (e.sessionIds?.includes(c.sessionId)) return true;
  if (e.userId && e.userId === c.userId && e.exceptSessionId !== c.sessionId) return true;
  if (e.deviceId && e.deviceId === c.deviceId) return true;
  if (e.revokeWarehouses && e.revokeWarehouses.userId === c.userId)
    return e.revokeWarehouses.warehouseIds.includes(c.warehouseId);
  return false;
}
