/**
 * 演示库存（ws-a2 brief §10，09 §4 D42）：通过 postTransaction（同一校验/引擎/台账路径）以 INBOUND 写入
 * `demo.demoBalances`，幂等键 `seed:<locationCode>:<skuCode>`，重复运行只会重放；完成后跑一次全量对账。
 * 用法：node --experimental-strip-types src/modules/inventory/seed-stock.ts [<DATABASE_URL>]
 * 根脚本入口（db-reset-dev / pnpm seed:demo --with-stock）见 docs/contract-requests/ws-a2-1.md。
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { TxnCommand } from '@wms3d/contracts';
import { demo } from '@wms3d/domain';
import type { AuthContext } from '../../lib/auth.ts';
import { reconcile, type ReconcileReport } from '../../jobs/reconcile.ts';
import { postTransaction } from './commands.ts';

export interface SeedStockResult {
  created: number;
  replayed: number;
  reconcile: ReconcileReport;
}

export async function seedStock(url: string): Promise<SeedStockResult> {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  try {
    const admin = demo.demoUsers.find((u) => u.role === 'ADMIN')!;
    const auth: AuthContext = {
      userId: admin.id,
      role: 'ADMIN',
      warehouseIds: 'all',
      deviceId: 'seed-stock',
      sessionId: '00000000-0000-0000-0000-000000000000',
      mustChangePassword: false,
    };
    const skuCode = new Map(demo.demoSkus.map((s) => [s.id, s.code]));
    let created = 0;
    let replayed = 0;
    for (const b of demo.demoBalances) {
      const raw = {
        type: 'INBOUND',
        warehouseId: demo.demoWarehouse.id,
        performedBy: admin.id,
        clientCreatedAt: new Date().toISOString(),
        refNo: 'SEED',
        note: '演示初始库存',
        lines: [{ locationId: b.locationId, skuId: b.skuId, qty: b.onHand }],
      };
      const cmd = TxnCommand.parse(raw);
      const out = await postTransaction(
        pool,
        null,
        auth,
        cmd,
        raw,
        `seed:${b.locationCode}:${skuCode.get(b.skuId)}`,
      );
      if (out.created) created++;
      else replayed++;
    }
    const rec = await reconcile(pool, { full: true });
    return { created, replayed, reconcile: rec };
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('需要 DATABASE_URL');
    process.exit(2);
  }
  const r = await seedStock(url);
  console.log(
    `seed-stock: created=${r.created} replayed=${r.replayed} reconcileKeys=${r.reconcile.checkedKeys} mismatches=${r.reconcile.mismatches.length}`,
  );
  if (r.reconcile.mismatches.length) process.exit(1);
}
