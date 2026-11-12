import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';

describe('api shell', () => {
  it('GET /api/v1/health returns ok', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('GET /api/v1/ready is 503 without a database', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it.skipIf(!process.env.DATABASE_URL)('GET /api/v1/ready is 200 with DATABASE_URL', async () => {
    const app = buildApp({ databaseUrl: process.env.DATABASE_URL });
    const res = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
