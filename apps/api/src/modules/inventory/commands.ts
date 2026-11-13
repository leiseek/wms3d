/**
 * postTransaction / reverseTransaction 的服务层：命令解析（编码/条码 → id）、请求哈希、
 * 角色策略（adjust / reverse）、换班代交校验（02 §6.6），然后交给引擎。
 */
import type pg from 'pg';
import { IdempotencyKey, requestHash, type TxnCommand, type TxnResult } from '@wms3d/contracts';
import {
  planMovements,
  PlanError,
  splitPayload,
  type MovementPlan,
  type ResolvedCommand,
} from '@wms3d/domain';
import type { AuthContext } from '../../lib/auth.ts';
import type { EventBus } from '../../lib/events.ts';
import { ApiError } from '../../lib/problem.ts';
import { postTxn, type EngineInput, type EngineOutcome } from './engine.ts';
import { loadTxns } from './views.ts';
import { sha256, type Queryable } from './util.ts';
import { canonicalize } from '@wms3d/contracts';

const isManager = (a: AuthContext) => a.role === 'ADMIN' || a.role === 'MANAGER';

export function checkIdempotencyKey(key: string | null): string {
  const r = IdempotencyKey.safeParse(key);
  if (!r.success) throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key 格式不正确');
  return r.data;
}

export function plan(cmd: ResolvedCommand): MovementPlan {
  try {
    return planMovements(cmd);
  } catch (e) {
    if (e instanceof PlanError) throw new ApiError('VALIDATION_FAILED', e.message);
    throw e;
  }
}

/** 02 §3.2：locationCode 接受载荷（WH1.A03-17-C02）与裸编码；前缀 ≠ 本仓 → WRONG_WAREHOUSE。 */
async function resolveLocationCodes(
  q: Queryable,
  wh: { id: string; code: string },
  raw: Array<{ path: string; value: string }>,
): Promise<Map<string, string>> {
  const bare = new Map<string, string>(); // raw value → bare code
  const others = await q.query<{ code: string }>(`SELECT code FROM warehouses WHERE id <> $1`, [
    wh.id,
  ]);
  const otherCodes = new Set(others.rows.map((r) => r.code));
  for (const { path, value } of raw) {
    const up = value.trim().toUpperCase();
    const sp = splitPayload(up);
    if (sp) {
      if (sp.warehouseCode === wh.code) bare.set(value, sp.code);
      else if (otherCodes.has(sp.warehouseCode))
        throw new ApiError('WRONG_WAREHOUSE', `${value} 属于仓库 ${sp.warehouseCode}`, {
          errors: [{ path, message: 'WRONG_WAREHOUSE' }],
          context: { otherWarehouseCode: sp.warehouseCode, value },
        });
      else
        throw new ApiError('UNKNOWN_BARCODE', `未知仓位码 ${value}`, {
          errors: [{ path, message: 'UNKNOWN_BARCODE' }],
          context: { value },
        });
    } else bare.set(value, up);
  }
  const r = await q.query<{ id: string; code: string }>(
    `SELECT id, code FROM locations WHERE warehouse_id = $1 AND code = ANY($2::text[])`,
    [wh.id, [...new Set(bare.values())]],
  );
  const byCode = new Map(r.rows.map((x) => [x.code, x.id]));
  const out = new Map<string, string>();
  for (const { path, value } of raw) {
    const id = byCode.get(bare.get(value)!);
    if (!id)
      throw new ApiError('UNKNOWN_BARCODE', `未知仓位码 ${value}`, {
        errors: [{ path, message: 'UNKNOWN_BARCODE' }],
        context: { value },
      });
    out.set(value, id);
  }
  return out;
}

async function resolveSkuBarcodes(
  q: Queryable,
  raw: Array<{ path: string; value: string }>,
): Promise<Map<string, { skuId: string; packQty: number }>> {
  const r = await q.query<{ barcode: string; sku_id: string; pack_qty: number }>(
    `SELECT barcode, sku_id, pack_qty FROM sku_barcodes WHERE barcode = ANY($1::text[])`,
    [[...new Set(raw.map((x) => x.value))]],
  );
  const m = new Map(r.rows.map((x) => [x.barcode, { skuId: x.sku_id, packQty: x.pack_qty }]));
  for (const { path, value } of raw)
    if (!m.has(value))
      throw new ApiError('UNKNOWN_BARCODE', `未知 SKU 条码 ${value}`, {
        errors: [{ path, message: 'UNKNOWN_BARCODE' }],
        context: { value },
      });
  return m;
}

/** 命令 → 已解析命令（id 化；箱码 qty × packQty）。 */
export async function resolveCommand(
  q: Queryable,
  wh: { id: string; code: string },
  cmd: TxnCommand,
): Promise<{ resolved: ResolvedCommand; locationCodes: Map<string, string> }> {
  if (cmd.type === 'TRANSFER')
    return { resolved: { type: 'TRANSFER', lines: cmd.lines }, locationCodes: new Map() };
  if (cmd.type === 'ADJUST')
    return { resolved: { type: 'ADJUST', lines: cmd.lines }, locationCodes: new Map() };
  const codes = cmd.lines.flatMap((l, i) =>
    l.locationCode ? [{ path: `lines[${i}].locationCode`, value: l.locationCode }] : [],
  );
  const bars = cmd.lines.flatMap((l, i) =>
    l.skuBarcode ? [{ path: `lines[${i}].skuBarcode`, value: l.skuBarcode }] : [],
  );
  const locMap = codes.length
    ? await resolveLocationCodes(q, wh, codes)
    : new Map<string, string>();
  const barMap = bars.length ? await resolveSkuBarcodes(q, bars) : new Map();
  const lines = cmd.lines.map((l) => {
    const b = l.skuBarcode ? barMap.get(l.skuBarcode)! : null;
    const qty = l.qty * (b?.packQty ?? 1);
    if (qty > 2_000_000_000) throw new ApiError('VALIDATION_FAILED', '数量过大');
    return {
      locationId: l.locationId ?? locMap.get(l.locationCode!)!,
      skuId: b ? b.skuId : l.skuId!,
      qty,
    };
  });
  const locationCodes = new Map<string, string>();
  for (const { value } of codes) {
    const id = locMap.get(value)!;
    const up = value.trim().toUpperCase();
    const sp = splitPayload(up);
    locationCodes.set(id, sp ? sp.code : up);
  }
  return { resolved: { type: cmd.type, lines }, locationCodes };
}

/**
 * 换班代交（02 §6.6，v2.2）：performerSessionId 属于 performedBy、device_id = 令牌 did、72h 内、
 * started_at ≤ 当前令牌会话 started_at、performedBy 账号启用。全部用 DB 时钟判断。
 */
export async function checkPerformer(
  q: Queryable,
  auth: AuthContext,
  performedBy: string,
  performerSessionId: string | undefined,
): Promise<string | null> {
  if (performedBy === auth.userId) return null;
  const deny = () => new ApiError('PERFORMER_NOT_ALLOWED', '代交单据的操作人会话校验未通过');
  if (!performerSessionId) throw deny();
  const r = await q.query<{ ok: boolean }>(
    `SELECT (ps.user_id = $2 AND ps.device_id = $3 AND ps.started_at >= now() - interval '72 hours'
             AND cs.id IS NOT NULL AND cs.device_id = $3 AND ps.started_at <= cs.started_at AND u.is_active) AS ok
       FROM device_sessions ps
       JOIN users u ON u.id = ps.user_id
       LEFT JOIN device_sessions cs ON cs.id = $4
      WHERE ps.id = $1`,
    [performerSessionId, performedBy, auth.deviceId, auth.sessionId],
  );
  if (!r.rows[0]?.ok) throw deny();
  return performerSessionId;
}

export interface RequestMeta {
  ip?: string | null;
  traceId?: string | null;
}

/** POST /inventory/transactions */
export async function postTransaction(
  pool: pg.Pool,
  bus: EventBus | null,
  auth: AuthContext,
  cmd: TxnCommand,
  rawBody: Record<string, unknown>,
  idempotencyKey: string,
  meta: RequestMeta = {},
): Promise<EngineOutcome> {
  // 策略 adjust：ADJUST 与 force=true 仅 MANAGER+
  if (cmd.type === 'ADJUST' && !isManager(auth))
    throw new ApiError('FORBIDDEN', 'ADJUST 仅限主管及以上');
  const force = (cmd.type === 'INBOUND' || cmd.type === 'TRANSFER') && cmd.force;
  if (force && !isManager(auth)) throw new ApiError('FORBIDDEN', 'force 仅限主管及以上');
  const hash = await requestHash(rawBody);
  const wh = await pool.query<{ id: string; code: string }>(
    `SELECT id, code FROM warehouses WHERE id = $1`,
    [cmd.warehouseId],
  );
  if (!wh.rows[0]) throw new ApiError('NOT_FOUND');
  const performerSessionId = await checkPerformer(
    pool,
    auth,
    cmd.performedBy,
    cmd.performerSessionId,
  );
  const { resolved, locationCodes } = await resolveCommand(pool, wh.rows[0], cmd);
  const p = plan(resolved);
  const handoff = performerSessionId !== null;
  const auditAction =
    cmd.type === 'ADJUST'
      ? 'inventory.adjust'
      : force
        ? 'inventory.force'
        : handoff
          ? 'inventory.handoff'
          : null;
  const input: EngineInput = {
    warehouseId: cmd.warehouseId,
    type: cmd.type,
    idempotencyKey,
    requestHash: hash,
    reason: cmd.type === 'ADJUST' ? cmd.reason : null,
    refNo: cmd.refNo ?? null,
    note: cmd.note ?? null,
    performedBy: cmd.performedBy,
    submittedBy: auth.userId,
    performerSessionId,
    deviceId: auth.deviceId,
    createdOffline: cmd.createdOffline,
    clientCreatedAt: cmd.clientCreatedAt,
    plan: p,
    enforceCapacity: cmd.type === 'INBOUND' || cmd.type === 'TRANSFER',
    force,
    audit: auditAction ? { action: auditAction, ip: meta.ip, traceId: meta.traceId } : null,
    expectedLocationCodes: locationCodes,
  };
  return postTxn(pool, bus, input);
}

/** POST /inventory/transactions/:id/reverse（02 §6.4，B-N15） */
export async function reverseTransaction(
  pool: pg.Pool,
  bus: EventBus | null,
  auth: AuthContext,
  origId: string,
  body: { note?: string | undefined; clientCreatedAt?: string | undefined },
  idempotencyKey: string,
  meta: RequestMeta = {},
): Promise<EngineOutcome> {
  const o = await pool.query<{
    id: string;
    warehouse_id: string;
    type: string;
    performed_by: string;
    device_id: string | null;
    ref_no: string | null;
    age_s: number;
    rev_key: string | null;
  }>(
    `SELECT t.id, t.warehouse_id, t.type, t.performed_by, t.device_id, t.ref_no,
            EXTRACT(EPOCH FROM now() - t.created_at)::float8 AS age_s,
            (SELECT r.idempotency_key FROM inv_txns r WHERE r.reverses_txn_id = t.id) AS rev_key
       FROM inv_txns t WHERE t.id = $1`,
    [origId],
  );
  const orig = o.rows[0];
  if (!orig) throw new ApiError('NOT_FOUND');
  if (orig.type === 'REVERSAL') throw new ApiError('REVERSAL_NOT_ALLOWED', '冲正单不可再冲正');
  // 同键重放（rev_key === key）直接交给引擎比对哈希，不再套 10 分钟等时效规则
  if (orig.rev_key !== idempotencyKey && !isManager(auth)) {
    if (orig.type === 'COUNT_ADJUST') throw new ApiError('FORBIDDEN', '盘点调整单仅限主管冲正');
    if (orig.performed_by !== auth.userId || orig.device_id !== auth.deviceId || orig.age_s > 600)
      throw new ApiError('FORBIDDEN', '作业员只能冲正本人在本设备 10 分钟内的单据');
  }
  if (orig.rev_key !== null && orig.rev_key !== idempotencyKey)
    throw new ApiError('TXN_ALREADY_REVERSED');
  const [txn] = await loadTxns(pool, [origId]);
  const p = plan({
    type: 'REVERSAL',
    lines: txn!.lines.map((l) => ({
      locationId: l.locationId,
      skuId: l.skuId,
      lotNo: l.lotNo,
      qtyDelta: -l.qtyDelta,
    })),
  });
  const hash = sha256(canonicalize({ reverses: origId, note: body.note ?? null }));
  return postTxn(pool, bus, {
    warehouseId: orig.warehouse_id,
    type: 'REVERSAL',
    idempotencyKey,
    requestHash: hash,
    refNo: orig.ref_no,
    note: body.note ?? null,
    reversesTxnId: origId,
    performedBy: auth.userId,
    submittedBy: auth.userId,
    deviceId: auth.deviceId,
    createdOffline: false,
    clientCreatedAt: body.clientCreatedAt ?? null,
    plan: p,
    enforceCapacity: false,
    audit: {
      action: 'inventory.reverse',
      ip: meta.ip,
      traceId: meta.traceId,
      extra: { origType: orig.type },
    },
  });
}

export type { TxnResult };
