/**
 * 库存引擎：唯一写入口 postTransaction 的事务内核（02 §6、ADR-0003）。
 *
 * 步骤（READ COMMITTED）：
 *  ① 幂等占位：INSERT inv_txns … ON CONFLICT (warehouse_id, idempotency_key) DO NOTHING RETURNING id；
 *     0 行 → 新语句 SELECT 已提交行，比对 request_hash + performed_by + device_id → 重放 / 409（不泄露首次内容）。
 *  ② 锁仓位（id 升序；含入库方向的仓位 FOR UPDATE，其余 FOR SHARE），带 warehouse_id 约束（跨仓 → 404）；
 *     锁内校验：停用、容量（按仓位全部 SKU 合计）、禁止混放。
 *  ③ 余额按 (location_id, sku_id, lot_no) 升序：扣减 = 条件 UPDATE（0 行 → 422 INSUFFICIENT_STOCK，整单回滚），
 *     增加 = INSERT … ON CONFLICT DO UPDATE；每键写 stock_movements(balance_after)。
 *  ④ 调整/冲正/强制/代交类同事务写审计。
 * 提交后由调用方发布 stock.changed（见 publishStockChanged）。
 */
import type pg from 'pg';
import type { TxnResult, TxnType } from '@wms3d/contracts';
import type { MovementPlan } from '@wms3d/domain';
import type { EventBus } from '../../lib/events.ts';
import { ApiError } from '../../lib/problem.ts';
import { loadTxns } from './views.ts';
import { afterLocationsLocked } from '../../lib/tx-hooks.ts';
import { PG, pgCode, pgConstraint, withTx, writeAudit, type Queryable } from './util.ts';

export interface EngineInput {
  warehouseId: string;
  type: TxnType;
  idempotencyKey: string;
  requestHash: string;
  reason?: string | null;
  refNo?: string | null;
  note?: string | null;
  reversesTxnId?: string | null;
  performedBy: string;
  submittedBy: string;
  performerSessionId?: string | null;
  deviceId: string | null;
  createdOffline: boolean;
  clientCreatedAt: string | null;
  plan: MovementPlan;
  /** 容量 / 禁止混放校验（INBOUND、TRANSFER）；调整、盘点、冲正是“对齐现实”，不校验 */
  enforceCapacity: boolean;
  /** MANAGER+ 越过容量（审计） */
  force?: boolean;
  /** 非空 → 同事务写审计 */
  audit?: { action: string; ip?: string | null; traceId?: string | null; extra?: unknown } | null;
  /** 用编码解析出的仓位：加锁后复核 code，不一致 → LAYOUT_STALE（CR1 #6） */
  expectedLocationCodes?: ReadonlyMap<string, string>;
}

export interface EngineOutcome {
  result: TxnResult;
  created: boolean;
  layoutVersion: number;
  locationIds: string[];
}

interface LockedLocation {
  id: string;
  code: string;
  is_active: boolean;
  eff_max: number | null;
}

const LOCK_SQL = (mode: 'UPDATE' | 'SHARE') =>
  `SELECT l.id, l.code, l.is_active, COALESCE(l.max_qty, (r.rack_type->>'defaultMaxQty')::int) AS eff_max
     FROM locations l LEFT JOIN racks r ON r.id = l.rack_id
    WHERE l.id = ANY($1::uuid[]) AND l.warehouse_id = $2
    ORDER BY l.id FOR ${mode} OF l`;

/** ② 按 id 升序加锁；入库方向 FOR UPDATE，其余 FOR SHARE。同模式一条语句，混合时逐行（仍按 id 升序）。 */
async function lockLocations(
  q: Queryable,
  warehouseId: string,
  ids: string[],
  inbound: ReadonlySet<string>,
): Promise<Map<string, LockedLocation>> {
  const rows: LockedLocation[] = [];
  const allUpdate = ids.every((id) => inbound.has(id));
  const allShare = ids.every((id) => !inbound.has(id));
  if (allUpdate || allShare) {
    const r = await q.query<LockedLocation>(LOCK_SQL(allUpdate ? 'UPDATE' : 'SHARE'), [
      ids,
      warehouseId,
    ]);
    rows.push(...r.rows);
  } else {
    for (const id of ids) {
      const r = await q.query<LockedLocation>(LOCK_SQL(inbound.has(id) ? 'UPDATE' : 'SHARE'), [
        [id],
        warehouseId,
      ]);
      rows.push(...r.rows);
    }
  }
  if (rows.length !== ids.length) throw new ApiError('NOT_FOUND', '仓位不存在或不属于该仓库');
  return new Map(rows.map((r) => [r.id, r]));
}

async function skuCodes(
  q: Queryable,
  ids: string[],
): Promise<Map<string, { code: string; isActive: boolean }>> {
  const r = await q.query<{ id: string; code: string; is_active: boolean }>(
    `SELECT id, code, is_active FROM skus WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(r.rows.map((x) => [x.id, { code: x.code, isActive: x.is_active }]));
}

/** 在调用方已开启的事务内执行。抛 ApiError 时调用方必须回滚。 */
export async function applyTxn(q: Queryable, input: EngineInput): Promise<EngineOutcome> {
  const { plan, warehouseId } = input;
  const wh = await q.query<{ allow_mixed_sku: boolean; published_layout_version: number | null }>(
    `SELECT allow_mixed_sku, published_layout_version FROM warehouses WHERE id = $1`,
    [warehouseId],
  );
  if (!wh.rows[0]) throw new ApiError('NOT_FOUND', '仓库不存在');
  const layoutVersion = wh.rows[0].published_layout_version ?? 0;
  const allowMixed = wh.rows[0].allow_mixed_sku;

  // ① 幂等占位
  const ins = await q.query<{ id: string }>(
    `INSERT INTO inv_txns (warehouse_id, type, idempotency_key, request_hash, reason, ref_no, note, reverses_txn_id,
                           performed_by, submitted_by, performer_session_id, device_id, created_offline, client_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (warehouse_id, idempotency_key) DO NOTHING RETURNING id`,
    [
      warehouseId,
      input.type,
      input.idempotencyKey,
      input.requestHash,
      input.reason ?? null,
      input.refNo ?? null,
      input.note ?? null,
      input.reversesTxnId ?? null,
      input.performedBy,
      input.submittedBy,
      input.performerSessionId ?? null,
      input.deviceId,
      input.createdOffline,
      input.clientCreatedAt,
    ],
  );
  if (!ins.rows[0]) {
    const prev = await q.query<{
      id: string;
      request_hash: string;
      performed_by: string;
      device_id: string | null;
    }>(
      `SELECT id, request_hash, performed_by, device_id FROM inv_txns WHERE warehouse_id = $1 AND idempotency_key = $2`,
      [warehouseId, input.idempotencyKey],
    );
    const p = prev.rows[0];
    if (!p) throw Object.assign(new Error('idempotency row vanished'), { code: PG.DEADLOCK });
    if (
      p.request_hash !== input.requestHash ||
      p.performed_by !== input.performedBy ||
      (p.device_id ?? null) !== (input.deviceId ?? null)
    )
      throw new ApiError('IDEMPOTENCY_KEY_REUSED');
    const [txn] = await loadTxns(q, [p.id]);
    return {
      result: { txn: txn!, balancesAfter: balancesOf(txn!), replayed: true },
      created: false,
      layoutVersion,
      locationIds: [],
    };
  }
  const txnId = ins.rows[0].id;

  // ② 锁仓位 + 锁内校验
  const inboundLocs = new Set(plan.deltas.filter((d) => d.delta > 0).map((d) => d.locationId));
  const locs = await lockLocations(q, warehouseId, plan.lockLocations, inboundLocs);
  await afterLocationsLocked('inventory-locked', plan.lockLocations);
  for (const id of plan.lockLocations) {
    const l = locs.get(id)!;
    if (!l.is_active)
      throw new ApiError('LOCATION_INACTIVE', `仓位 ${l.code} 已停用`, {
        context: { locationId: l.id, locationCode: l.code },
      });
    const expected = input.expectedLocationCodes?.get(id);
    if (expected && l.code !== expected)
      throw new ApiError('LAYOUT_STALE', `仓位编码已变更（扫到 ${expected}，当前 ${l.code}）`, {
        context: { locationId: l.id, expectedCode: expected, actualCode: l.code },
      });
  }
  const skuIds = [...new Set(plan.deltas.map((d) => d.skuId))];
  const codes = await skuCodes(q, skuIds);
  const missingSku = skuIds.find((s) => !codes.has(s));
  if (missingSku) throw new ApiError('NOT_FOUND', `SKU 不存在：${missingSku}`);
  if (input.type === 'INBOUND' || input.type === 'TRANSFER') {
    const inactive = skuIds.filter((s) => codes.get(s) && !codes.get(s)!.isActive);
    if (inactive.length) {
      const s = codes.get(inactive[0]!)!;
      throw new ApiError('SKU_INACTIVE', `SKU ${s.code} 已停用，不能入库或移库`, {
        context: { skuId: inactive[0], skuCode: s.code },
      });
    }
  }

  const checkCap = input.enforceCapacity && !input.force;
  const capLocs = [...inboundLocs].filter(
    (id) => (checkCap && locs.get(id)!.eff_max !== null) || (input.enforceCapacity && !allowMixed),
  );
  if (capLocs.length) {
    const cur = await q.query<{ location_id: string; sku_id: string; on_hand: number }>(
      `SELECT location_id, sku_id, on_hand FROM stock_balances WHERE location_id = ANY($1::uuid[]) AND on_hand > 0`,
      [capLocs],
    );
    for (const id of capLocs) {
      const l = locs.get(id)!;
      const after = new Map<string, number>();
      for (const b of cur.rows)
        if (b.location_id === id) after.set(b.sku_id, (after.get(b.sku_id) ?? 0) + b.on_hand);
      for (const d of plan.deltas)
        if (d.locationId === id) after.set(d.skuId, (after.get(d.skuId) ?? 0) + d.delta);
      const total = [...after.values()].reduce((n, v) => n + Math.max(0, v), 0);
      if (checkCap && l.eff_max !== null && total > l.eff_max)
        throw new ApiError(
          'LOCATION_CAPACITY_EXCEEDED',
          `仓位 ${l.code} 容量 ${l.eff_max}，提交后为 ${total}`,
          {
            context: {
              locationId: id,
              locationCode: l.code,
              effectiveMax: l.eff_max,
              after: total,
            },
          },
        );
      if (!allowMixed) {
        const skus = [...after.entries()].filter(([, v]) => v > 0).map(([k]) => k);
        if (skus.length > 1)
          throw new ApiError('MIXED_SKU_NOT_ALLOWED', `仓位 ${l.code} 不允许混放`, {
            context: { locationId: id, locationCode: l.code, skuIds: skus },
          });
      }
    }
  }

  // ③ 余额（plan.deltas 已按键升序）
  const after: number[] = [];
  for (const d of plan.deltas) {
    if (d.delta < 0) {
      const r = await q.query<{ on_hand: number }>(
        `UPDATE stock_balances SET on_hand = on_hand + $4, updated_at = now()
          WHERE location_id = $1 AND sku_id = $2 AND lot_no = $3 AND on_hand >= $5 RETURNING on_hand`,
        [d.locationId, d.skuId, d.lotNo, d.delta, -d.delta],
      );
      if (!r.rows[0]) {
        const a = await q.query<{ on_hand: number }>(
          `SELECT on_hand FROM stock_balances WHERE location_id = $1 AND sku_id = $2 AND lot_no = $3`,
          [d.locationId, d.skuId, d.lotNo],
        );
        const available = a.rows[0]?.on_hand ?? 0;
        const l = locs.get(d.locationId)!;
        const skuCode = codes.get(d.skuId)!.code;
        throw new ApiError('INSUFFICIENT_STOCK', `${l.code} 上 ${skuCode} 仅有 ${available}`, {
          context: {
            locationId: d.locationId,
            locationCode: l.code,
            skuId: d.skuId,
            skuCode,
            lotNo: d.lotNo,
            available,
            requested: -d.delta,
            createdOffline: input.createdOffline,
          },
        });
      }
      after.push(r.rows[0].on_hand);
    } else {
      const r = await q.query<{ on_hand: number }>(
        `INSERT INTO stock_balances (warehouse_id, location_id, sku_id, lot_no, on_hand) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (location_id, sku_id, lot_no)
         DO UPDATE SET on_hand = stock_balances.on_hand + EXCLUDED.on_hand, updated_at = now()
         RETURNING on_hand`,
        [warehouseId, d.locationId, d.skuId, d.lotNo, d.delta],
      );
      after.push(r.rows[0]!.on_hand);
    }
  }
  await q.query(
    `INSERT INTO stock_movements (txn_id, warehouse_id, location_id, sku_id, lot_no, qty_delta, balance_after)
     SELECT $1, $2, x.l, x.s, x.lot, x.d, x.a
       FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::int[], $7::int[]) WITH ORDINALITY AS x(l, s, lot, d, a, n)
      ORDER BY x.n`,
    [
      txnId,
      warehouseId,
      plan.deltas.map((d) => d.locationId),
      plan.deltas.map((d) => d.skuId),
      plan.deltas.map((d) => d.lotNo),
      plan.deltas.map((d) => d.delta),
      after,
    ],
  );

  // ④ 审计
  if (input.audit)
    await writeAudit(q, {
      userId: input.submittedBy,
      warehouseId,
      action: input.audit.action,
      entity: 'inv_txn',
      entityId: txnId,
      after: {
        type: input.type,
        reason: input.reason ?? null,
        refNo: input.refNo ?? null,
        force: !!input.force,
        reversesTxnId: input.reversesTxnId ?? null,
        performedBy: input.performedBy,
        submittedBy: input.submittedBy,
        performerSessionId: input.performerSessionId ?? null,
        lines: plan.deltas.length,
        ...(input.audit.extra === undefined ? {} : { extra: input.audit.extra }),
      },
      ip: input.audit.ip ?? null,
      deviceId: input.deviceId,
      traceId: input.audit.traceId ?? null,
    });

  const [txn] = await loadTxns(q, [txnId]);
  return {
    result: { txn: txn!, balancesAfter: balancesOf(txn!), replayed: false },
    created: true,
    layoutVersion,
    locationIds: plan.lockLocations,
  };
}

export function balancesOf(txn: TxnResult['txn']): TxnResult['balancesAfter'] {
  return txn.lines.map((l) => ({
    locationId: l.locationId,
    skuId: l.skuId,
    lotNo: l.lotNo,
    onHand: l.balanceAfter,
  }));
}

/** 提交后发布（03 §6）。重放不发布。 */
export function publishStockChanged(bus: EventBus, warehouseId: string, o: EngineOutcome): void {
  if (!o.created) return;
  bus.publish(warehouseId, {
    event: 'stock.changed',
    data: { layoutVersion: o.layoutVersion, locationIds: o.locationIds, txnId: o.result.txn.id },
  });
}

/** 自带事务的入口：BEGIN → applyTxn → COMMIT → 发布事件；死锁重试 1 次；重复冲正 → 409。 */
export async function postTxn(
  pool: pg.Pool,
  bus: EventBus | null,
  input: EngineInput,
): Promise<EngineOutcome> {
  let out: EngineOutcome;
  try {
    out = await withTx(pool, (c) => applyTxn(c, input));
  } catch (e) {
    if (pgCode(e) === PG.UNIQUE && pgConstraint(e) === 'inv_txns_reverses_txn_id_unique')
      throw new ApiError('TXN_ALREADY_REVERSED');
    throw e;
  }
  if (bus) publishStockChanged(bus, input.warehouseId, out);
  return out;
}
