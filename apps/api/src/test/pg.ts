/** 测试库辅助：从迁移模板克隆独立库（scripts/test-db.sh），用完删除。PG 不可用时 pgAvailable=false，用例应 skip。 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const WS = process.env.WMS_WS ?? 'lead';
const HOST = process.env.WMS_PG_HOST ?? '127.0.0.1';
const PORT = process.env.WMS_PG_PORT ?? '55432';

function sh(args: string[]): string {
  return execFileSync('bash', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export const pgAvailable: boolean = (() => {
  if (process.env.WMS_SKIP_DB_TESTS === '1') return false;
  try {
    sh(['scripts/dev-db.sh', 'status']);
    return true;
  } catch {
    return false;
  }
})();

export interface TestDb {
  name: string;
  appUrl: string;
  ownerUrl: string;
  drop(): void;
}

export function cloneTestDb(): TestDb {
  const name = sh(['scripts/test-db.sh', 'clone', WS]).split('\n').pop()!;
  return {
    name,
    appUrl: `postgres://wms_app@${HOST}:${PORT}/${name}`,
    ownerUrl: `postgres://wms_owner@${HOST}:${PORT}/${name}`,
    drop: () => void sh(['scripts/test-db.sh', 'drop', name]),
  };
}
