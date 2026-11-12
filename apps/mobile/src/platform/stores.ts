import Dexie, { type Table } from 'dexie';
import type { MasterPersistence, MasterSnapshot } from '../core/masterdata.ts';
import {
  sortEntries,
  type OutboxEntry,
  type OutboxStatus,
  type OutboxStore,
} from '../core/outbox-types.ts';
import { SqliteOutboxStore, type SqlConn } from '../core/outbox-sqlite.ts';
import type { SecureStore } from '../core/session.ts';
import { isNative, Scanner } from '../native/bridge.ts';

/** 主数据缓存 + 浏览器 outbox（IndexedDB / Dexie 4，可重建；04 §4） */
class WmsDb extends Dexie {
  declare outbox: Table<OutboxEntry, string>;
  declare master: Table<MasterSnapshot, string>;
  constructor() {
    super('wms3d');
    this.version(1).stores({ outbox: 'id, status, createdAt', master: 'warehouseId' });
  }
}
let db: WmsDb | null = null;
const getDb = () => (db ??= new WmsDb());

export class IdbMasterPersistence implements MasterPersistence {
  async load(id: string) {
    return (await getDb().master.get(id)) ?? null;
  }
  async save(s: MasterSnapshot) {
    await getDb().master.put(s);
  }
  async clear() {
    await getDb().master.clear();
  }
}

/** 浏览器调试用 outbox（原生用 SQLite，不受“清除缓存”影响） */
export class IdbOutboxStore implements OutboxStore {
  async init() {
    await getDb().open();
  }
  async put(e: OutboxEntry) {
    await getDb().outbox.put(e);
  }
  async get(id: string) {
    return getDb().outbox.get(id);
  }
  async list(statuses?: readonly OutboxStatus[]) {
    const all = statuses
      ? await getDb()
          .outbox.where('status')
          .anyOf([...statuses])
          .toArray()
      : await getDb().outbox.toArray();
    return all.sort(sortEntries);
  }
  async remove(id: string) {
    await getDb().outbox.delete(id);
  }
  async purgeFinished(before: number) {
    const old = (
      await getDb().outbox.where('status').anyOf(['DONE', 'CANCELLED']).toArray()
    ).filter((e) => (e.sentAt ?? e.createdAt) < before);
    await getDb().outbox.bulkDelete(old.map((e) => e.id));
    return old.length;
  }
  async clear() {
    await getDb().outbox.clear();
  }
}

/** 原生：@capacitor-community/sqlite（App 私有目录）。待真机验证：插件在各 ROM 上的打开/升级行为。 */
async function openSqlite(): Promise<SqlConn> {
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  const name = 'wms3d_outbox';
  const exists = (await sqlite.isConnection(name, false)).result;
  const conn = exists
    ? await sqlite.retrieveConnection(name, false)
    : await sqlite.createConnection(name, false, 'no-encryption', 1, false);
  await conn.open();
  return {
    execute: async (sql) => {
      await conn.execute(sql, false);
    },
    run: async (sql, values) => {
      await conn.run(sql, values as never[], false);
    },
    query: async <T>(sql: string, values: unknown[]) =>
      ((await conn.query(sql, values as never[])).values ?? []) as T[],
  };
}

export async function createOutboxStore(): Promise<OutboxStore> {
  if (isNative) return new SqliteOutboxStore(await openSqlite());
  return new IdbOutboxStore();
}

/** refreshToken：原生插件 AES-GCM + Android Keystore；浏览器 localStorage（仅调试） */
export const secureStore: SecureStore = {
  get: async (key) => (await Scanner.secureGet({ key })).value,
  set: async (key, value) => Scanner.secureSet({ key, value }),
  remove: async (key) => Scanner.secureRemove({ key }),
};

export async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
}
