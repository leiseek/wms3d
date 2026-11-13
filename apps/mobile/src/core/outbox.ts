import { ApiError, newIdempotencyKey, type ApiClient } from '@wms3d/api-client';
import type { TxnCommandInput, TxnResult } from '@wms3d/contracts';
import {
  ACTIVE_STATUSES,
  lineKeys,
  type OutboxEntry,
  type OutboxError,
  type OutboxStore,
  type OutboxTxnType,
} from './outbox-types.ts';

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const WAITING_STOCK_RETRY_MS = 120_000;
export const WAITING_STOCK_MAX_MS = 24 * 3600_000;
export const DONE_RETENTION_MS = 7 * 24 * 3600_000;

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempts - 1));
}

/** 发送结果分类（03 §3.1 处理矩阵） */
export type Outcome =
  | { kind: 'done'; result: TxnResult }
  | { kind: 'retry' }
  | { kind: 'auth'; reason: 'UNAUTHENTICATED' | 'PASSWORD_CHANGE_REQUIRED' }
  | { kind: 'waitingStock' }
  | { kind: 'rejected'; canAutoRetry: boolean; report: boolean };

export function classify(err: unknown, createdOffline: boolean): Outcome {
  if (!(err instanceof ApiError)) return { kind: 'retry' };
  if (err.code === 'NETWORK' || err.status >= 500 || err.status === 429 || err.status === 0)
    return { kind: 'retry' };
  if (err.code === 'UNAUTHENTICATED' || err.status === 401)
    return { kind: 'auth', reason: 'UNAUTHENTICATED' };
  if (err.code === 'PASSWORD_CHANGE_REQUIRED')
    return { kind: 'auth', reason: 'PASSWORD_CHANGE_REQUIRED' };
  if (err.code === 'INSUFFICIENT_STOCK')
    return createdOffline
      ? { kind: 'waitingStock' }
      : { kind: 'rejected', canAutoRetry: true, report: false };
  return { kind: 'rejected', canAutoRetry: false, report: err.code === 'IDEMPOTENCY_KEY_REUSED' };
}

function toError(e: unknown): OutboxError {
  if (e instanceof ApiError)
    return {
      code: e.code,
      message: e.message,
      status: e.status,
      traceId: e.problem?.traceId,
    };
  return { code: 'NETWORK', message: (e as Error)?.message ?? String(e), status: 0 };
}

export interface OutboxEvents {
  /** 任意条目变化（UI 刷新） */
  changed?: (e: OutboxEntry) => void;
  /** 服务端业务拒绝（打断式提示） */
  rejected?: (e: OutboxEntry) => void;
  /** 进入 / 离开 BLOCKED_AUTH */
  authBlocked?: (reason: string | null) => void;
  /** IDEMPOTENCY_KEY_REUSED 等客户端 bug 上报 */
  report?: (e: OutboxEntry) => void;
}

export interface EnqueueInput {
  type: OutboxTxnType;
  warehouseId: string;
  performedBy: string;
  /** 入队时的登录会话 session.id（换班代交，02 §6.6） */
  performerSessionId: string;
  lines: TxnCommandInput['lines'];
  createdOffline: boolean;
  label: string;
  refNo?: string;
  note?: string;
}

/**
 * 离线队列（ADR-0007 v2）：先写存储（灰勾）→ 串行发送（同设备顺序）→ 按 03 §3.1 处理响应。
 * 发送使用**当前登录用户**的令牌（换班代交：performedBy 保持入队时的操作员）。
 */
export class Outbox {
  private running = false;
  private blockedReason: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly store: OutboxStore;
  private readonly api: () => ApiClient;
  private readonly now: () => number;
  private readonly events: OutboxEvents;
  private readonly opts: {
    autoSchedule?: boolean;
    onBeforeSend?: (e: OutboxEntry) => Promise<void>;
  };

  constructor(
    store: OutboxStore,
    api: () => ApiClient,
    now: () => number = () => Date.now(),
    events: OutboxEvents = {},
    opts: { autoSchedule?: boolean; onBeforeSend?: (e: OutboxEntry) => Promise<void> } = {},
  ) {
    this.store = store;
    this.api = api;
    this.now = now;
    this.events = events;
    this.opts = opts;
  }

  get authBlocked(): string | null {
    return this.blockedReason;
  }

  async init(): Promise<void> {
    await this.store.init();
    // 崩溃恢复：SENDING → PENDING（同键重发是安全的）
    for (const e of await this.store.list(['SENDING']))
      await this.save({ ...e, status: 'PENDING', nextAttemptAt: this.now() });
    await this.store.purgeFinished(this.now() - DONE_RETENTION_MS);
  }

  async enqueue(i: EnqueueInput): Promise<OutboxEntry> {
    const id = newIdempotencyKey();
    const now = this.now();
    const payload = {
      type: i.type,
      warehouseId: i.warehouseId,
      performedBy: i.performedBy,
      performerSessionId: i.performerSessionId,
      clientCreatedAt: new Date(now).toISOString(),
      createdOffline: i.createdOffline,
      ...(i.refNo ? { refNo: i.refNo } : {}),
      ...(i.note ? { note: i.note } : {}),
      lines: i.lines,
    } as TxnCommandInput;
    const e: OutboxEntry = {
      id,
      warehouseId: i.warehouseId,
      operatorUserId: i.performedBy,
      type: i.type,
      payload,
      status: this.blockedReason ? 'BLOCKED_AUTH' : 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      createdOffline: i.createdOffline,
      sentAt: null,
      txnId: null,
      waitingSince: null,
      mayBeAffected: false,
      canAutoRetry: false,
      label: i.label,
    };
    await this.save(e);
    this.kick();
    return e;
  }

  async list(): Promise<OutboxEntry[]> {
    return this.store.list();
  }

  async pendingCount(): Promise<number> {
    return (await this.store.list(ACTIVE_STATUSES)).length;
  }

  /** 撤销：未发送 → 作废；已确认 → 冲正（10 分钟内，本人） */
  async undo(id: string): Promise<'cancelled' | 'reversed'> {
    // 等待正在发送的同一条
    for (let i = 0; i < 50; i++) {
      const cur = await this.store.get(id);
      if (cur?.status !== 'SENDING') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const e = await this.store.get(id);
    if (!e) throw new Error('单据不存在');
    if (e.status === 'PENDING' || e.status === 'WAITING_STOCK' || e.status === 'BLOCKED_AUTH') {
      const cancelled = await this.store.claim(id, ['PENDING', 'WAITING_STOCK', 'BLOCKED_AUTH'], {
        status: 'CANCELLED',
      });
      if (!cancelled) throw new Error(`当前状态 ${e.status} 不能撤销`);
      this.events.changed?.(cancelled);
      return 'cancelled';
    }
    if (e.status === 'DONE' && e.txnId) {
      await this.api().r.reverseTransaction({
        params: { id: e.txnId },
        body: { note: '移动端撤销上一笔', clientCreatedAt: new Date(this.now()).toISOString() },
        idempotencyKey: newIdempotencyKey(),
      });
      await this.save({ ...e, status: 'CANCELLED' });
      return 'reversed';
    }
    throw new Error(`当前状态 ${e.status} 不能撤销`);
  }

  /** 异常单：作废 */
  async discard(id: string): Promise<void> {
    const cancelled = await this.store.claim(
      id,
      ['PENDING', 'WAITING_STOCK', 'BLOCKED_AUTH', 'REJECTED'],
      { status: 'CANCELLED' },
    );
    if (cancelled) this.events.changed?.(cancelled);
  }

  /** 异常单：重试（新键，04 §5） */
  async retryWithNewKey(id: string): Promise<OutboxEntry | null> {
    const e = await this.store.get(id);
    if (!e || e.status !== 'REJECTED') return null;
    await this.save({ ...e, status: 'CANCELLED' });
    const ne: OutboxEntry = {
      ...e,
      id: newIdempotencyKey(),
      status: this.blockedReason ? 'BLOCKED_AUTH' : 'PENDING',
      attempts: 0,
      nextAttemptAt: this.now(),
      lastError: null,
      createdAt: this.now(),
      sentAt: null,
      txnId: null,
      waitingSince: null,
      mayBeAffected: false,
      canAutoRetry: false,
    };
    await this.save(ne);
    this.kick();
    return ne;
  }

  /** 在线单库存不足：“稍后自动重试” → WAITING_STOCK */
  async autoRetryLater(id: string): Promise<void> {
    const e = await this.store.get(id);
    if (!e || e.status !== 'REJECTED' || !e.canAutoRetry) return;
    const now = this.now();
    await this.save({
      ...e,
      status: 'WAITING_STOCK',
      waitingSince: now,
      nextAttemptAt: now + WAITING_STOCK_RETRY_MS,
      canAutoRetry: false,
    });
  }

  /** 任意用户重新登录 / 改密后调用：BLOCKED_AUTH → PENDING 并继续 */
  async resumeAuth(): Promise<void> {
    this.blockedReason = null;
    this.events.authBlocked?.(null);
    for (const e of await this.store.list(['BLOCKED_AUTH']))
      await this.save({ ...e, status: 'PENDING', nextAttemptAt: this.now() });
    this.kick();
  }

  /** 导出待传队列（JSON，应急） */
  async exportJson(): Promise<string> {
    const items = await this.store.list();
    return JSON.stringify({ exportedAt: new Date(this.now()).toISOString(), items }, null, 2);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** 触发发送循环（不等待） */
  kick(): void {
    if (this.stopped || this.opts.autoSchedule === false) return;
    void this.drain().then(() => this.schedule());
  }

  private async schedule(): Promise<void> {
    if (this.stopped || this.blockedReason) return;
    const due = (await this.store.list(['PENDING', 'WAITING_STOCK'])).map((e) => e.nextAttemptAt);
    if (!due.length) return;
    const wait = Math.max(50, Math.min(...due) - this.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, wait);
  }

  /** 发送所有已到期条目（串行）；返回本轮发送次数 */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let sent = 0;
    try {
      for (;;) {
        if (this.blockedReason || this.stopped) break;
        const now = this.now();
        // 同设备顺序：PENDING 队首未到期（网络退避中）则不越过它发送后续单；
        // WAITING_STOCK 单独按各自的 2 分钟节奏重试，不占队首。
        const head = (await this.store.list(['PENDING']))[0];
        const next =
          head && head.nextAttemptAt <= now
            ? head
            : (await this.store.list(['WAITING_STOCK'])).find((e) => e.nextAttemptAt <= now);
        if (!next) break;
        if (this.opts.onBeforeSend) await this.opts.onBeforeSend(next);
        const outcome = await this.sendOne(next);
        if (outcome !== 'skipped') sent++;
        if (outcome === 'retry') break;
      }
    } finally {
      this.running = false;
    }
    return sent;
  }

  private async sendOne(e0: OutboxEntry): Promise<Outcome['kind'] | 'skipped'> {
    const e = await this.store.claim(e0.id, ['PENDING', 'WAITING_STOCK'], {
      status: 'SENDING',
      attempts: e0.attempts + 1,
    });
    if (!e) return 'skipped';
    this.events.changed?.(e);
    let outcome: Outcome;
    let err: unknown = null;
    try {
      const result = (await this.api().r.postTransaction({
        body: e.payload,
        idempotencyKey: e.id,
      })) as TxnResult;
      outcome = { kind: 'done', result };
    } catch (x) {
      err = x;
      outcome = classify(x, e.createdOffline);
    }
    const now = this.now();
    switch (outcome.kind) {
      case 'done':
        await this.save({
          ...e,
          status: 'DONE',
          sentAt: now,
          txnId: outcome.result.txn.id,
          lastError: null,
        });
        return 'done';
      case 'retry':
        await this.save({
          ...e,
          status: 'PENDING',
          nextAttemptAt: now + backoffMs(e.attempts),
          lastError: toError(err),
        });
        return 'retry';
      case 'auth':
        this.blockedReason = outcome.reason;
        await this.save({ ...e, status: 'BLOCKED_AUTH', lastError: toError(err) });
        for (const p of await this.store.list(['PENDING']))
          await this.save({ ...p, status: 'BLOCKED_AUTH' });
        this.events.authBlocked?.(outcome.reason);
        return 'auth';
      case 'waitingStock': {
        const since = e.waitingSince ?? now;
        if (now - since >= WAITING_STOCK_MAX_MS) {
          await this.reject(e, toError(err), false);
          return 'rejected';
        }
        await this.save({
          ...e,
          status: 'WAITING_STOCK',
          waitingSince: since,
          nextAttemptAt: now + WAITING_STOCK_RETRY_MS,
          lastError: toError(err),
        });
        return 'waitingStock';
      }
      case 'rejected':
        await this.reject(e, toError(err), outcome.canAutoRetry);
        if (outcome.report) this.events.report?.(e);
        return 'rejected';
    }
  }

  private async reject(e: OutboxEntry, err: OutboxError, canAutoRetry: boolean): Promise<void> {
    const rejected: OutboxEntry = { ...e, status: 'REJECTED', lastError: err, canAutoRetry };
    await this.save(rejected);
    // 拒绝不阻塞队列；同仓位 + SKU 的后续单标“可能受影响”
    const keys = new Set(lineKeys(e.payload));
    for (const p of await this.store.list(['PENDING', 'WAITING_STOCK', 'BLOCKED_AUTH']))
      if (p.createdAt >= e.createdAt && lineKeys(p.payload).some((k) => keys.has(k)))
        await this.save({ ...p, mayBeAffected: true });
    this.events.rejected?.(rejected);
  }

  private async save(e: OutboxEntry): Promise<void> {
    await this.store.put(e);
    this.events.changed?.(e);
  }
}
