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
import { createCount, transition } from '../counts/service.ts';

export interface SeedStockResult {
  created: number;
  replayed: number;
  historyCreated: number;
  countTaskCode: string | null;
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
    const histIds: { id: string; at: Date }[] = [];
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
      if (out.created) {
        created++;
        const initAt = new Date(Date.now() - 20 * 24 * 3600 * 1000);
        initAt.setUTCHours(8, (created * 7) % 60, 0, 0);
        histIds.push({ id: out.result.txn.id, at: initAt });
      } else replayed++;
    }
    // 若干日进出库台账（确定性幂等键）。业务日靠随后用 owner 回写 created_at。
    const stocked = demo.demoBalances.filter((b) => b.onHand >= 6);
    let historyCreated = 0;
    const days = 14;
    for (let d = days; d >= 1; d--) {
      const at = new Date(Date.now() - d * 24 * 3600 * 1000);
      at.setUTCHours(10, (d * 13) % 60, 0, 0);
      const outLines = stocked.slice(d * 3, d * 3 + 3).map((b) => ({
        locationId: b.locationId,
        skuId: b.skuId,
        qty: 1,
      }));
      const inLines = stocked.slice(d * 3 + 40, d * 3 + 43).map((b) => ({
        locationId: b.locationId,
        skuId: b.skuId,
        qty: 2,
      }));
      for (const [kind, lines, suffix] of [
        ['OUTBOUND', outLines, 'out'],
        ['INBOUND', inLines, 'in'],
      ] as const) {
        if (!lines.length) continue;
        const raw = {
          type: kind,
          warehouseId: demo.demoWarehouse.id,
          performedBy: admin.id,
          clientCreatedAt: at.toISOString(),
          refNo: `SEED-HIST-${suffix}-${d}`,
          note: '演示历史流水',
          lines,
        };
        const cmd = TxnCommand.parse(raw);
        const out = await postTransaction(pool, null, auth, cmd, raw, `seed-hist:${suffix}:${d}`);
        if (out.created) {
          historyCreated++;
          histIds.push({ id: out.result.txn.id, at });
        }
      }
    }
    // 今日再写几笔，让看板「今日出入库」非零
    for (const [kind, lines, suffix] of [
      [
        'INBOUND',
        stocked.slice(0, 2).map((b) => ({ locationId: b.locationId, skuId: b.skuId, qty: 1 })),
        'today-in',
      ],
      [
        'OUTBOUND',
        stocked.slice(2, 4).map((b) => ({ locationId: b.locationId, skuId: b.skuId, qty: 1 })),
        'today-out',
      ],
    ] as const) {
      if (!lines.length) continue;
      const raw = {
        type: kind,
        warehouseId: demo.demoWarehouse.id,
        performedBy: admin.id,
        clientCreatedAt: new Date().toISOString(),
        refNo: `SEED-TODAY-${suffix}`,
        note: '演示今日流水',
        lines,
      };
      const cmd = TxnCommand.parse(raw);
      const out = await postTransaction(pool, null, auth, cmd, raw, `seed-hist:${suffix}`);
      if (out.created) historyCreated++;
    }

    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    if (ownerUrl && histIds.length) {
      const owner = new pg.Pool({ connectionString: ownerUrl, max: 2 });
      const c = await owner.connect();
      try {
        await c.query('BEGIN');
        // 台账为 append-only，种子回写业务日需由表属主临时关闭用户触发器。
        await c.query('ALTER TABLE inv_txns DISABLE TRIGGER USER');
        await c.query('ALTER TABLE stock_movements DISABLE TRIGGER USER');
        for (const h of histIds) {
          await c.query(
            `UPDATE inv_txns SET created_at = $2, client_created_at = $2 WHERE id = $1`,
            [h.id, h.at.toISOString()],
          );
          await c.query(`UPDATE stock_movements SET created_at = $2 WHERE txn_id = $1`, [
            h.id,
            h.at.toISOString(),
          ]);
        }
        await c.query('ALTER TABLE inv_txns ENABLE TRIGGER USER');
        await c.query('ALTER TABLE stock_movements ENABLE TRIGGER USER');
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        c.release();
        await owner.end();
      }
    }

    let countTaskCode: string | null = null;
    try {
      const task = await createCount(
        pool,
        auth,
        {
          warehouseId: demo.demoWarehouse.id,
          scope: { zones: ['A'], rackIds: [], locationIds: [] },
          blind: true,
          note: '演示进行中的盘点',
        },
        'seed-count:WH1:A',
      );
      const started = await transition(pool, auth, task.id, ['OPEN'], 'COUNTING');
      countTaskCode = started.code;
    } catch (e) {
      console.warn('演示盘点任务未创建：', (e as Error).message);
    }

    const rec = await reconcile(pool, { full: true });
    return { created, replayed, historyCreated, countTaskCode, reconcile: rec };
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
    `seed-stock: created=${r.created} replayed=${r.replayed} history=${r.historyCreated} count=${r.countTaskCode ?? '-'} reconcileKeys=${r.reconcile.checkedKeys} mismatches=${r.reconcile.mismatches.length}`,
  );
  if (r.reconcile.mismatches.length) process.exit(1);
}
