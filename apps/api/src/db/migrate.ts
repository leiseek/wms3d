/**
 * 迁移（08 §5：API 启动时或手动执行）。以 wms_owner 连接；持 pg_advisory_lock(LOCK_NS.MIGRATION, 0) 防并发迁移。
 * 用法：node --experimental-strip-types src/db/migrate.ts [<url>]（缺省读 MIGRATION_DATABASE_URL）
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { LOCK_NS } from './locks.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export async function runMigrations(url: string): Promise<void> {
  const lockClient = new pg.Client({ connectionString: url });
  await lockClient.connect();
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await lockClient.query('SELECT pg_advisory_lock($1, $2)', [LOCK_NS.MIGRATION, 0]);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await lockClient
      .query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NS.MIGRATION, 0])
      .catch(() => undefined);
    await lockClient.end();
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.argv[2] ?? process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('缺少数据库 URL（参数或 MIGRATION_DATABASE_URL）');
    process.exit(2);
  }
  runMigrations(url).then(
    () => console.log('迁移完成'),
    (e: unknown) => {
      console.error('迁移失败：', e);
      process.exit(1);
    },
  );
}
