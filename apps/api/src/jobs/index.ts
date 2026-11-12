/**
 * 进程内夜间任务（node-cron，08 §夜间任务）。多实例下以 pg_try_advisory_lock(LOCK_NS.JOB, JOB_ID.*) 防重复
 * （会话级锁，持有于专用连接，任务结束即释放）。
 * 启动：API 进程 listen 后（onListen）；WMS_JOBS=0 关闭；测试中 inject 不触发 listen，因此默认不跑。
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { schedule, type ScheduledTask } from 'node-cron';
import { JOB_ID, LOCK_NS } from '../db/locks.ts';
import { reconcile, type ReconcileReport } from './reconcile.ts';
import { purgeIdempotencyKeys, purgeRefreshTokens, purgeZeroBalances } from './purge.ts';

export { reconcile, purgeIdempotencyKeys, purgeRefreshTokens, purgeZeroBalances };
export type { ReconcileReport };

type JobId = (typeof JOB_ID)[keyof typeof JOB_ID];

/** 在专用连接上 try-lock 后执行；拿不到锁返回 { skipped: true }。 */
export async function runExclusive<T>(
  pool: pg.Pool,
  job: JobId,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const c = await pool.connect();
  try {
    const got = await c.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1, $2) AS ok`, [
      LOCK_NS.JOB,
      job,
    ]);
    if (!got.rows[0]?.ok) return { skipped: true };
    try {
      // 全量对账/批量清理可能超过角色默认 transaction_timeout（30s），按会话放宽并在结束时复原
      await c.query(`SET statement_timeout = '15min'; SET transaction_timeout = '15min'`);
      return { skipped: false, result: await fn(c) };
    } finally {
      await c.query(`RESET statement_timeout; RESET transaction_timeout`).catch(() => undefined);
      await c.query(`SELECT pg_advisory_unlock($1, $2)`, [LOCK_NS.JOB, job]).catch(() => undefined);
    }
  } finally {
    c.release();
  }
}

export interface JobDef {
  id: JobId;
  name: string;
  cron: string;
  run: (c: pg.PoolClient) => Promise<unknown>;
}

export const JOBS: readonly JobDef[] = [
  {
    id: JOB_ID.RECONCILE_INCREMENTAL,
    name: 'reconcile.incremental',
    cron: '30 2 * * 1-6',
    run: (c) => reconcile(c, { full: false }),
  },
  {
    id: JOB_ID.RECONCILE_FULL,
    name: 'reconcile.full',
    cron: '30 2 * * 0',
    run: (c) => reconcile(c, { full: true }),
  },
  {
    id: JOB_ID.PURGE_REFRESH_TOKENS,
    name: 'purge.refreshTokens',
    cron: '10 3 * * *',
    run: (c) => purgeRefreshTokens(c),
  },
  {
    id: JOB_ID.PURGE_ZERO_BALANCES,
    name: 'purge.zeroBalances',
    cron: '20 3 * * *',
    run: (c) => purgeZeroBalances(c),
  },
  {
    id: JOB_ID.PURGE_DONE_IDEMPOTENCY,
    name: 'purge.idempotencyKeys',
    cron: '30 3 * * *',
    run: (c) => purgeIdempotencyKeys(c),
  },
];

/** 任务时区：首个仓库的 timezone（按仓库时区定时，08）；可用 WMS_JOBS_TZ 覆盖。 */
async function jobsTimezone(pool: pg.Pool): Promise<string> {
  if (process.env.WMS_JOBS_TZ) return process.env.WMS_JOBS_TZ;
  const r = await pool.query<{ tz: string }>(
    `SELECT timezone AS tz FROM warehouses ORDER BY created_at LIMIT 1`,
  );
  return r.rows[0]?.tz ?? 'Asia/Shanghai';
}

export function installJobs(app: FastifyInstance, pool: pg.Pool): void {
  if (process.env.WMS_JOBS === '0') return;
  const tasks: ScheduledTask[] = [];
  app.addHook('onListen', async () => {
    const timezone = await jobsTimezone(pool).catch(() => 'Asia/Shanghai');
    for (const j of JOBS)
      tasks.push(
        schedule(
          j.cron,
          async () => {
            try {
              const out = await runExclusive(pool, j.id, j.run);
              app.log.info({ job: j.name, ...out }, 'job finished');
            } catch (err) {
              app.log.error({ job: j.name, err }, 'job failed');
            }
          },
          { timezone, noOverlap: true, name: j.name },
        ),
      );
  });
  app.addHook('onClose', async () => {
    for (const t of tasks) await t.stop();
  });
}
