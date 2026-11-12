import { buildApp } from './app.ts';
import { runMigrations } from './db/migrate.ts';

const port = Number(process.env.PORT_API ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';

if (process.env.WMS_MIGRATE_ON_START === '1' && process.env.MIGRATION_DATABASE_URL) {
  await runMigrations(process.env.MIGRATION_DATABASE_URL);
}
const app = buildApp({ databaseUrl: process.env.DATABASE_URL, logger: true });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
