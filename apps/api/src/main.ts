import { buildApp } from './app.ts';

const port = Number(process.env.PORT_API ?? 4000);
const host = process.env.HOST ?? '127.0.0.1';
const app = buildApp({ databaseUrl: process.env.DATABASE_URL, logger: true });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
