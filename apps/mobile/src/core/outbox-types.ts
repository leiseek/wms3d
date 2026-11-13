import type { TxnCommandInput } from '@wms3d/contracts';

/** 04 §5 / ADR-0007 v2 */
export type OutboxStatus =
  'PENDING' | 'SENDING' | 'DONE' | 'WAITING_STOCK' | 'BLOCKED_AUTH' | 'REJECTED' | 'CANCELLED';

export type OutboxTxnType = 'INBOUND' | 'OUTBOUND' | 'TRANSFER';

export interface OutboxError {
  code: string;
  message: string;
  status: number;
  traceId?: string | undefined;
}

export interface OutboxEntry {
  /** = Idempotency-Key（UUIDv7，入队时生成，重试复用） */
  id: string;
  warehouseId: string;
  /** performedBy（实际操作员） */
  operatorUserId: string;
  type: OutboxTxnType;
  /** 请求体（不含 deviceId：设备 ID 由令牌决定） */
  payload: TxnCommandInput;
  status: OutboxStatus;
  attempts: number;
  /** 下次可发送时间（epoch ms） */
  nextAttemptAt: number;
  lastError: OutboxError | null;
  /** epoch ms */
  createdAt: number;
  createdOffline: boolean;
  sentAt: number | null;
  /** 服务端交易 id（DONE 后；撤销/冲正用） */
  txnId: string | null;
  /** 首次进入 WAITING_STOCK 的时间 */
  waitingSince: number | null;
  /** 同仓位 + SKU 的前序单被拒：可能受影响 */
  mayBeAffected: boolean;
  /** 在线单收到 INSUFFICIENT_STOCK：允许“稍后自动重试” */
  canAutoRetry: boolean;
  /** 显示用摘要，如“上架 A01-01-A01 · SKU-001 ×12” */
  label: string;
}

export const ACTIVE_STATUSES: readonly OutboxStatus[] = [
  'PENDING',
  'SENDING',
  'WAITING_STOCK',
  'BLOCKED_AUTH',
];

export interface OutboxStore {
  init(): Promise<void>;
  put(e: OutboxEntry): Promise<void>;
  get(id: string): Promise<OutboxEntry | undefined>;
  /** 按 createdAt、id 升序 */
  list(statuses?: readonly OutboxStatus[]): Promise<OutboxEntry[]>;
  remove(id: string): Promise<void>;
  /** 删除早于 before 的 DONE/CANCELLED，返回删除条数 */
  purgeFinished(before: number): Promise<number>;
  clear(): Promise<void>;
  /**
   * 条件更新（CR1 #3）：仅当当前 status 属于 allowed 时写入 patch。
   * 成功返回更新后的条目，否则 undefined。
   */
  claim(
    id: string,
    allowed: readonly OutboxStatus[],
    patch: Partial<OutboxEntry>,
  ): Promise<OutboxEntry | undefined>;
}

/** 行引用（用于“可能受影响”判断）：仓位 + SKU（id 或条码原文） */
export function lineKeys(p: TxnCommandInput): string[] {
  const keys: string[] = [];
  if (p.type === 'TRANSFER') {
    for (const l of p.lines)
      keys.push(`${l.fromLocationId}|${l.skuId}`, `${l.toLocationId}|${l.skuId}`);
  } else if (p.type === 'INBOUND' || p.type === 'OUTBOUND') {
    for (const l of p.lines)
      keys.push(`${l.locationId ?? l.locationCode}|${l.skuId ?? l.skuBarcode}`);
  }
  return keys;
}

export function locationRefs(p: TxnCommandInput): string[] {
  if (p.type === 'TRANSFER') return p.lines.flatMap((l) => [l.fromLocationId, l.toLocationId]);
  if (p.type === 'INBOUND' || p.type === 'OUTBOUND')
    return p.lines.map((l) => (l.locationId ?? l.locationCode)!);
  return [];
}

export function sortEntries(a: OutboxEntry, b: OutboxEntry): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export class MemoryOutboxStore implements OutboxStore {
  private m = new Map<string, OutboxEntry>();
  async init(): Promise<void> {}
  async put(e: OutboxEntry): Promise<void> {
    this.m.set(e.id, structuredClone(e));
  }
  async get(id: string): Promise<OutboxEntry | undefined> {
    const e = this.m.get(id);
    return e ? structuredClone(e) : undefined;
  }
  async list(statuses?: readonly OutboxStatus[]): Promise<OutboxEntry[]> {
    return [...this.m.values()]
      .filter((e) => !statuses || statuses.includes(e.status))
      .sort(sortEntries)
      .map((e) => structuredClone(e));
  }
  async remove(id: string): Promise<void> {
    this.m.delete(id);
  }
  async purgeFinished(before: number): Promise<number> {
    let n = 0;
    for (const e of [...this.m.values()])
      if ((e.status === 'DONE' || e.status === 'CANCELLED') && (e.sentAt ?? e.createdAt) < before) {
        this.m.delete(e.id);
        n++;
      }
    return n;
  }
  async clear(): Promise<void> {
    this.m.clear();
  }
  async claim(
    id: string,
    allowed: readonly OutboxStatus[],
    patch: Partial<OutboxEntry>,
  ): Promise<OutboxEntry | undefined> {
    const e = this.m.get(id);
    if (!e || !allowed.includes(e.status)) return undefined;
    const next = { ...e, ...patch };
    this.m.set(id, structuredClone(next));
    return structuredClone(next);
  }
}
