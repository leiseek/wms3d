import { EventEmitter } from 'node:events';
import type { WmsEvent } from '@wms3d/contracts';

/**
 * 进程内事件总线（02 §8）。写路径在事务提交后 publish；SSE 模块（WS-A2）按仓库订阅并推送。
 * 单进程部署（ADR-0001），无需外部消息中间件。
 */
export class EventBus {
  private readonly ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
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
}
