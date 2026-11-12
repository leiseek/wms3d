import { v7 as uuidv7 } from 'uuid';

/** 库存写接口的幂等键：UUIDv7（03 §4.1）。离线单据在入队时生成并持久化，重试复用同一个键。 */
export function newIdempotencyKey(): string {
  return uuidv7();
}
