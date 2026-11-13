/**
 * 后端编排：mock（契约驱动，packages/api-client/scripts/mock-server.ts）或 real（apps/api + 真实 PG17）。
 * real 默认从本 WS 模板克隆一次性库 t_ws_f_<rand>（scripts/test-db.sh clone ws-f）→ 写演示数据 → 起 API；
 * 结束时停进程并删库。设置 E2E_DB=wms_ws_f 可改用本 WS 开发库（不删、不重建）。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync } from 'node:fs';
import { APP_ROOT, ROOT, STATE_DIR, WS, ports, type Target } from './env.ts';

const PG_HOST = process.env.WMS_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.WMS_PG_PORT ?? '55432';
const pgUrl = (db: string, role: 'wms_app' | 'wms_owner') =>
  `postgres://${role}@${PG_HOST}:${PG_PORT}/${db}`;

export interface Backend {
  target: Target;
  baseUrl: string;
  db: string | null;
  pid: number;
  stop(): Promise<void>;
}

function sh(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** 干净环境：去掉外泄的 PORT_* / WMS_* / DATABASE_URL，避免连到别的 WS 的库或端口。 */
export function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PORT_|WMS_|DATABASE_URL|MIGRATION_DATABASE_URL|JWT_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, WMS_WS: WS, ...extra };
}

async function waitFor(url: string, proc: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (proc.exitCode !== null)
      throw new Error(`后端进程已退出（code ${proc.exitCode}），见 ${STATE_DIR}*.log`);
    try {
      const r = await fetch(url);
      if (r.ok) return;
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`等待 ${url} 超时：${last}`);
}

function launch(name: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  mkdirSync(STATE_DIR, { recursive: true });
  const log = openSync(`${STATE_DIR}${name}.log`, 'w');
  // detached → 独立进程组，stop 时整组结束（不留孤儿）
  return spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['ignore', log, log] });
}

async function kill(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || !proc.pid) return;
  const done = new Promise<void>((r) => proc.once('exit', () => r()));
  try {
    process.kill(-proc.pid, 'SIGTERM');
  } catch {
    return;
  }
  const t = setTimeout(() => {
    try {
      process.kill(-proc.pid!, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }, 5000);
  await done;
  clearTimeout(t);
}

export async function startMock(port = ports.mock): Promise<Backend> {
  const proc = launch(
    'mock',
    ['--experimental-strip-types', 'scripts/mock-server.ts'],
    `${APP_ROOT}packages/api-client`,
    cleanEnv({ PORT_API: String(port) }),
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(`${baseUrl}/api/v1/health`, proc, 30_000);
  return { target: 'mock', baseUrl, db: null, pid: proc.pid!, stop: () => kill(proc) };
}

export async function startReal(port = ports.real): Promise<Backend> {
  const fixedDb = process.env.E2E_DB;
  let db: string;
  if (fixedDb) {
    if (!/^wms_ws_f$|^t_ws_f_[a-z0-9_]+$/.test(fixedDb))
      throw new Error(`E2E_DB 只能是 ws-f 自己的库：${fixedDb}`);
    db = fixedDb;
  } else {
    db = sh('bash', ['scripts/test-db.sh', 'clone', WS]).split('\n').pop()!;
  }
  const dropDb = () => {
    if (!fixedDb) sh('bash', ['scripts/test-db.sh', 'drop', db]);
  };
  try {
    // 演示数据（主数据 + 已发布布局 v1；幂等）。以 wms_app 写入，与 db-reset-dev.sh 一致。
    sh(process.execPath, [
      '--experimental-strip-types',
      `${APP_ROOT}apps/api/src/db/seed-demo.ts`,
      pgUrl(db, 'wms_app'),
    ]);
    sh(
      process.execPath,
      [
        '--experimental-strip-types',
        `${APP_ROOT}apps/api/src/modules/inventory/seed-stock.ts`,
        pgUrl(db, 'wms_app'),
      ],
      cleanEnv({
        DATABASE_URL: pgUrl(db, 'wms_app'),
        MIGRATION_DATABASE_URL: pgUrl(db, 'wms_owner'),
      }),
    );
  } catch (e) {
    dropDb();
    throw e;
  }
  const proc = launch(
    'api',
    ['--experimental-strip-types', 'src/main.ts'],
    `${APP_ROOT}apps/api`,
    cleanEnv({
      PORT_API: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'test',
      DATABASE_URL: pgUrl(db, 'wms_app'),
      MIGRATION_DATABASE_URL: pgUrl(db, 'wms_owner'),
      JWT_SECRET: randomBytes(32).toString('hex'),
      WMS_JOBS: '0',
      PORT_ADMIN: String(ports.admin),
      PORT_MOBILE: String(ports.mobile),
    }),
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${baseUrl}/api/v1/ready`, proc, 60_000);
  } catch (e) {
    await kill(proc);
    dropDb();
    throw e;
  }
  return {
    target: 'real',
    baseUrl,
    db,
    pid: proc.pid!,
    stop: async () => {
      await kill(proc);
      dropDb();
    },
  };
}
