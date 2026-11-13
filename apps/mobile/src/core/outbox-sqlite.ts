import type { OutboxEntry, OutboxStatus, OutboxStore } from './outbox-types.ts';

/**
 * SQLite outbox（04 §4/§5，`@capacitor-community/sqlite`）。只依赖最小 SQL 接口，
 * 便于在 JVM 外（Vitest + node:sqlite）测试同一套 SQL；App 内由 sqlite-conn.ts 适配插件连接。
 */
export interface SqlConn {
  execute(sql: string): Promise<void>;
  run(sql: string, values: unknown[]): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, values: unknown[]): Promise<T[]>;
}

export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY NOT NULL,
  warehouseId TEXT NOT NULL,
  operatorUserId TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  createdAt INTEGER NOT NULL,
  createdOffline INTEGER NOT NULL DEFAULT 0,
  sentAt INTEGER,
  txnId TEXT,
  waitingSince INTEGER,
  mayBeAffected INTEGER NOT NULL DEFAULT 0,
  canAutoRetry INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS outbox_status_created ON outbox(status, createdAt);
`;

const COLS = [
  'id',
  'warehouseId',
  'operatorUserId',
  'type',
  'payload',
  'status',
  'attempts',
  'nextAttemptAt',
  'lastError',
  'createdAt',
  'createdOffline',
  'sentAt',
  'txnId',
  'waitingSince',
  'mayBeAffected',
  'canAutoRetry',
  'label',
] as const;

type Row = Record<(typeof COLS)[number], unknown>;

function toRow(e: OutboxEntry): unknown[] {
  return [
    e.id,
    e.warehouseId,
    e.operatorUserId,
    e.type,
    JSON.stringify(e.payload),
    e.status,
    e.attempts,
    e.nextAttemptAt,
    e.lastError ? JSON.stringify(e.lastError) : null,
    e.createdAt,
    e.createdOffline ? 1 : 0,
    e.sentAt,
    e.txnId,
    e.waitingSince,
    e.mayBeAffected ? 1 : 0,
    e.canAutoRetry ? 1 : 0,
    e.label,
  ];
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function fromRow(r: Row): OutboxEntry {
  return {
    id: String(r.id),
    warehouseId: String(r.warehouseId),
    operatorUserId: String(r.operatorUserId),
    type: r.type as OutboxEntry['type'],
    payload: JSON.parse(String(r.payload)),
    status: r.status as OutboxStatus,
    attempts: Number(r.attempts),
    nextAttemptAt: Number(r.nextAttemptAt),
    lastError: r.lastError ? JSON.parse(String(r.lastError)) : null,
    createdAt: Number(r.createdAt),
    createdOffline: Number(r.createdOffline) === 1,
    sentAt: num(r.sentAt),
    txnId: r.txnId === null || r.txnId === undefined ? null : String(r.txnId),
    waitingSince: num(r.waitingSince),
    mayBeAffected: Number(r.mayBeAffected) === 1,
    canAutoRetry: Number(r.canAutoRetry) === 1,
    label: String(r.label ?? ''),
  };
}

export class SqliteOutboxStore implements OutboxStore {
  private readonly db: SqlConn;

  constructor(db: SqlConn) {
    this.db = db;
  }
  async init(): Promise<void> {
    await this.db.execute(OUTBOX_SCHEMA);
  }
  async put(e: OutboxEntry): Promise<void> {
    const ph = COLS.map(() => '?').join(',');
    await this.db.run(`INSERT OR REPLACE INTO outbox (${COLS.join(',')}) VALUES (${ph})`, toRow(e));
  }
  async get(id: string): Promise<OutboxEntry | undefined> {
    const rows = await this.db.query<Row>('SELECT * FROM outbox WHERE id = ?', [id]);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async list(statuses?: readonly OutboxStatus[]): Promise<OutboxEntry[]> {
    const where = statuses?.length ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    const rows = await this.db.query<Row>(
      `SELECT * FROM outbox ${where} ORDER BY createdAt ASC, id ASC`,
      statuses ? [...statuses] : [],
    );
    return rows.map(fromRow);
  }
  async remove(id: string): Promise<void> {
    await this.db.run('DELETE FROM outbox WHERE id = ?', [id]);
  }
  async purgeFinished(before: number): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM outbox WHERE status IN ('DONE','CANCELLED') AND COALESCE(sentAt, createdAt) < ?",
      [before],
    );
    await this.db.run(
      "DELETE FROM outbox WHERE status IN ('DONE','CANCELLED') AND COALESCE(sentAt, createdAt) < ?",
      [before],
    );
    return Number(rows[0]?.n ?? 0);
  }
  async clear(): Promise<void> {
    await this.db.run('DELETE FROM outbox', []);
  }
  async claim(
    id: string,
    allowed: readonly OutboxStatus[],
    patch: Partial<OutboxEntry>,
  ): Promise<OutboxEntry | undefined> {
    const cur = await this.get(id);
    if (!cur || !allowed.includes(cur.status)) return undefined;
    const next: OutboxEntry = { ...cur, ...patch };
    const ph = COLS.map((c) => `${c} = ?`).join(',');
    const inList = allowed.map(() => '?').join(',');
    // 再带一次 status 条件，避免与并行写之间的 TOCTOU
    const r = await this.db.query<{ n: number }>(
      `UPDATE outbox SET ${ph} WHERE id = ? AND status IN (${inList}) RETURNING 1 AS n`,
      [...toRow(next), id, ...allowed],
    );
    if (!r.length) return undefined;
    return next;
  }
}
