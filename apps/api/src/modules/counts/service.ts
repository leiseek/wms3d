/**
 * 盘点（02 §8，D10 / B-N4 / B-N12）：提交即对账（variance 在提交时固定）、同 (task, location) 整体覆盖、
 * needs_review（server_now − client_counted_at > 5 分钟）、关闭 = 单事务（CAS → COUNT_ADJUST → 回写），
 * 余额不足 → 整体回滚 + COUNT_RECOUNT_REQUIRED。
 *
 * 锁顺序：count_tasks 行 → locations（id 升序）→ stock_balances（与 postTransaction 一致，ADR-0003 §4）。
 * 范围解析结果、快照与已提交仓位保存在 count_tasks.scope 的内部键（_locs/_snap/_submitted）里，对外只暴露 CountScope。
 */
import type pg from 'pg';
import type { z } from 'zod';
import {
  canonicalize,
  type CountCreate,
  type CountLine,
  type CountsQuery,
  type CountSubmission,
  type CountTask,
} from '@wms3d/contracts';
import type { AuthContext } from '../../lib/auth.ts';
import type { EventBus } from '../../lib/events.ts';
import { ApiError } from '../../lib/problem.ts';
import { applyTxn, publishStockChanged, type EngineOutcome } from '../inventory/engine.ts';
import { plan } from '../inventory/commands.ts';
import {
  decodeCursor,
  encodeCursor,
  iso,
  isRecord,
  PG,
  pgCode,
  sha256,
  withTx,
  writeAudit,
  type Queryable,
} from '../inventory/util.ts';

type Out<T extends z.ZodType> = z.output<T>;
type TaskView = Out<typeof CountTask>;
type LineView = Out<typeof CountLine>;

export const NEEDS_REVIEW_AFTER = '5 minutes';

interface StoredScope {
  zones: string[];
  rackIds: string[];
  locationIds: string[];
  _locs: string[];
  _snap: Record<string, number>;
  _submitted: Record<string, { submissionId: string; at: string }>;
}
interface TaskRow {
  id: string;
  warehouse_id: string;
  code: string;
  scope: StoredScope;
  blind: boolean;
  status: TaskView['status'];
  created_by: string;
  created_at: Date;
  closed_txn_id: string | null;
  closed_at: Date | null;
  review_lines?: number;
}

const snapKey = (loc: string, sku: string, lot = '') => `${loc}|${sku}|${lot}`;
const isMgr = (a: AuthContext) => a.role === 'ADMIN' || a.role === 'MANAGER';

const TASK_COLS = `t.id, t.warehouse_id, t.code, t.scope, t.blind, t.status, t.created_by, t.created_at, t.closed_txn_id, t.closed_at,
  (SELECT count(*)::int FROM count_lines cl WHERE cl.task_id = t.id AND cl.needs_review) AS review_lines`;

function taskView(r: TaskRow): TaskView {
  return {
    id: r.id,
    warehouseId: r.warehouse_id,
    code: r.code,
    scope: { zones: r.scope.zones, rackIds: r.scope.rackIds, locationIds: r.scope.locationIds },
    blind: r.blind,
    status: r.status,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    closedTxnId: r.closed_txn_id,
    closedAt: iso(r.closed_at),
    progress: {
      locationsTotal: r.scope._locs.length,
      locationsSubmitted: Object.keys(r.scope._submitted ?? {}).length,
      linesNeedingReview: r.review_lines ?? 0,
    },
  };
}

export async function getTask(q: Queryable, id: string): Promise<TaskView> {
  const r = await q.query<TaskRow>(`SELECT ${TASK_COLS} FROM count_tasks t WHERE t.id = $1`, [id]);
  if (!r.rows[0]) throw new ApiError('NOT_FOUND');
  return taskView(r.rows[0]);
}

/** 通用幂等（03 §4.2，idempotency_keys）：同用户同哈希 → 返回存储的响应；否则 409。 */
async function idempotent<T>(
  pool: pg.Pool,
  scope: string,
  key: string | null,
  userId: string,
  hash: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  if (!key) return withTx(pool, fn);
  const prior = async (q: Queryable): Promise<T | undefined> => {
    const r = await q.query<{ user_id: string; request_hash: string; response: T }>(
      `SELECT user_id, request_hash, response FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [scope, key],
    );
    const p = r.rows[0];
    if (!p) return undefined;
    if (p.user_id !== userId || p.request_hash !== hash)
      throw new ApiError('IDEMPOTENCY_KEY_REUSED');
    return p.response;
  };
  const found = await prior(pool);
  if (found !== undefined) return found;
  try {
    return await withTx(pool, async (c) => {
      const out = await fn(c);
      await c.query(
        `INSERT INTO idempotency_keys (scope, key, user_id, request_hash, response) VALUES ($1,$2,$3,$4,$5)`,
        [scope, key, userId, hash, JSON.stringify(out)],
      );
      return out;
    });
  } catch (e) {
    if (pgCode(e) === PG.UNIQUE) {
      const again = await prior(pool);
      if (again !== undefined) return again;
    }
    throw e;
  }
}

export async function createCount(
  pool: pg.Pool,
  auth: AuthContext,
  body: Out<typeof CountCreate>,
  idempotencyKey: string | null,
): Promise<TaskView> {
  const hash = sha256(canonicalize(body));
  return idempotent(
    pool,
    `createCount:${body.warehouseId}`,
    idempotencyKey,
    auth.userId,
    hash,
    async (c) => {
      const wh = body.warehouseId;
      const locs = await c.query<{ id: string }>(
        `SELECT l.id FROM locations l JOIN zones z ON z.id = l.zone_id
        WHERE l.warehouse_id = $1 AND l.is_active
          AND (z.code = ANY($2::text[]) OR l.rack_id = ANY($3::uuid[]) OR l.id = ANY($4::uuid[]))
        ORDER BY l.pick_seq, l.code`,
        [
          wh,
          body.scope.zones.map((z) => z.toUpperCase()),
          body.scope.rackIds,
          body.scope.locationIds,
        ],
      );
      if (!locs.rows.length) throw new ApiError('VALIDATION_FAILED', '盘点范围内没有启用的仓位');
      const ids = locs.rows.map((r) => r.id);
      const snap = await c.query<{
        location_id: string;
        sku_id: string;
        lot_no: string;
        on_hand: number;
      }>(
        `SELECT location_id, sku_id, lot_no, on_hand FROM stock_balances WHERE location_id = ANY($1::uuid[]) AND on_hand > 0`,
        [ids],
      );
      const scope: StoredScope = {
        zones: body.scope.zones,
        rackIds: body.scope.rackIds,
        locationIds: body.scope.locationIds,
        _locs: ids,
        _snap: Object.fromEntries(
          snap.rows.map((r) => [snapKey(r.location_id, r.sku_id, r.lot_no), r.on_hand]),
        ),
        _submitted: {},
      };
      const day = await c.query<{ d: string; n: number }>(
        `SELECT to_char(now() AT TIME ZONE w.timezone, 'YYYYMMDD') AS d,
              (SELECT count(*)::int FROM count_tasks t WHERE t.warehouse_id = w.id) AS n
         FROM warehouses w WHERE w.id = $1`,
        [wh],
      );
      const { d, n } = day.rows[0]!;
      // code 唯一（warehouse_id, code）；序号取仓库内任务数 + 1，冲突时用保存点重试
      for (let i = 1; i <= 20; i++) {
        const codeStr = `CT-${d}-${String(n + i).padStart(4, '0')}`;
        await c.query('SAVEPOINT cc');
        try {
          const r = await c.query<TaskRow>(
            `INSERT INTO count_tasks AS t (warehouse_id, code, scope, blind, status, note, created_by)
           VALUES ($1,$2,$3,$4,'OPEN',$5,$6) RETURNING ${TASK_COLS}`,
            [wh, codeStr, JSON.stringify(scope), body.blind, body.note ?? null, auth.userId],
          );
          await c.query('RELEASE SAVEPOINT cc');
          await writeAudit(c, {
            userId: auth.userId,
            warehouseId: wh,
            action: 'count.create',
            entity: 'count_task',
            entityId: r.rows[0]!.id,
            after: { code: codeStr, locations: ids.length, blind: body.blind },
            deviceId: auth.deviceId,
          });
          return taskView(r.rows[0]!);
        } catch (e) {
          await c.query('ROLLBACK TO SAVEPOINT cc');
          if (pgCode(e) !== PG.UNIQUE) throw e;
        }
      }
      throw new ApiError('CONFLICT', '无法分配盘点单号');
    },
  );
}

const isTsIdCursor = (v: unknown): v is { t: string; i: string } =>
  isRecord(v) && typeof v.t === 'string' && typeof v.i === 'string';

export async function listCounts(
  q: Queryable,
  wh: string,
  query: Out<typeof CountsQuery>,
): Promise<{ items: TaskView[]; nextCursor: string | null }> {
  const vals: unknown[] = [wh];
  let where = 't.warehouse_id = $1';
  if (query.status) {
    vals.push(query.status);
    where += ` AND t.status = $${vals.length}`;
  }
  const c = decodeCursor(query.cursor, isTsIdCursor);
  if (c) {
    vals.push(c.t, c.i);
    where += ` AND (t.created_at, t.id) < ($${vals.length - 1}::timestamptz, $${vals.length}::uuid)`;
  }
  const r = await q.query<TaskRow & { cts: string }>(
    `SELECT ${TASK_COLS}, to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cts
       FROM count_tasks t WHERE ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ${query.limit + 1}`,
    vals,
  );
  const more = r.rows.length > query.limit;
  const rows = r.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(taskView),
    nextCursor: more && last ? encodeCursor({ t: last.cts, i: last.id }) : null,
  };
}

/** 状态迁移（start/review/cancel）：同目标状态重复调用幂等返回；其他状态 409。 */
export async function transition(
  pool: pg.Pool,
  auth: AuthContext,
  id: string,
  from: TaskView['status'][],
  to: TaskView['status'],
): Promise<TaskView> {
  return withTx(pool, async (c) => {
    const r = await c.query<{ status: string; warehouse_id: string }>(
      `SELECT status, warehouse_id FROM count_tasks WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const t = r.rows[0];
    if (!t) throw new ApiError('NOT_FOUND');
    if (t.status !== to) {
      if (!from.includes(t.status as TaskView['status']))
        throw new ApiError('CONFLICT', `任务状态为 ${t.status}，不能变为 ${to}`, {
          context: { status: t.status },
        });
      await c.query(`UPDATE count_tasks SET status = $2 WHERE id = $1`, [id, to]);
      await writeAudit(c, {
        userId: auth.userId,
        warehouseId: t.warehouse_id,
        action: `count.${to.toLowerCase()}`,
        entity: 'count_task',
        entityId: id,
        before: { status: t.status },
        after: { status: to },
        deviceId: auth.deviceId,
      });
    }
    return getTask(c, id);
  });
}

interface LineRow {
  id: string;
  task_id: string;
  location_id: string;
  location_code: string;
  sku_id: string;
  sku_code: string;
  lot_no: string;
  snapshot_qty: number | null;
  system_qty_at_count: number;
  counted_qty: number;
  variance: number;
  counted_by: string;
  counted_at: Date;
  client_counted_at: Date | null;
  needs_review: boolean;
}
const LINE_SQL = `SELECT cl.id, cl.task_id, cl.location_id, l.code AS location_code, cl.sku_id, s.code AS sku_code, cl.lot_no,
  cl.snapshot_qty, cl.system_qty_at_count, cl.counted_qty, cl.variance, cl.counted_by, cl.counted_at, cl.client_counted_at, cl.needs_review
  FROM count_lines cl JOIN locations l ON l.id = cl.location_id JOIN skus s ON s.id = cl.sku_id`;

function lineView(r: LineRow, hide: boolean): LineView {
  return {
    id: r.id,
    taskId: r.task_id,
    locationId: r.location_id,
    locationCode: r.location_code,
    skuId: r.sku_id,
    skuCode: r.sku_code,
    lotNo: r.lot_no,
    snapshotQty: hide ? null : r.snapshot_qty,
    systemQtyAtCount: hide ? null : r.system_qty_at_count,
    countedQty: r.counted_qty,
    variance: hide ? null : r.variance,
    countedBy: r.counted_by,
    countedAt: iso(r.counted_at),
    clientCountedAt: iso(r.client_counted_at),
    needsReview: r.needs_review,
  };
}

/** 盲盘对 OPERATOR 隐藏系统数 / 快照 / 差异（countExecute 策略）。 */
const hides = (auth: AuthContext, blind: boolean) => blind && !isMgr(auth);

export async function listLines(
  q: Queryable,
  auth: AuthContext,
  taskId: string,
  query: {
    limit: number;
    cursor?: string | undefined;
    location?: string | undefined;
    needsReview?: 'true' | 'false' | undefined;
  },
): Promise<{ items: LineView[]; nextCursor: string | null }> {
  const t = await q.query<{ blind: boolean }>(`SELECT blind FROM count_tasks WHERE id = $1`, [
    taskId,
  ]);
  if (!t.rows[0]) throw new ApiError('NOT_FOUND');
  const vals: unknown[] = [taskId];
  let where = 'cl.task_id = $1';
  if (query.location) {
    vals.push(query.location);
    where += ` AND cl.location_id = $${vals.length}`;
  }
  if (query.needsReview) {
    vals.push(query.needsReview === 'true');
    where += ` AND cl.needs_review = $${vals.length}`;
  }
  const isC = (v: unknown): v is { l: string; s: string; i: string } =>
    isRecord(v) && typeof v.l === 'string' && typeof v.s === 'string' && typeof v.i === 'string';
  const c = decodeCursor(query.cursor, isC);
  if (c) {
    vals.push(c.l, c.s, c.i);
    where += ` AND (l.code, s.code, cl.id) > ($${vals.length - 2}, $${vals.length - 1}, $${vals.length}::uuid)`;
  }
  const r = await q.query<LineRow>(
    `${LINE_SQL} WHERE ${where} ORDER BY l.code, s.code, cl.id LIMIT ${query.limit + 1}`,
    vals,
  );
  const more = r.rows.length > query.limit;
  const rows = r.rows.slice(0, query.limit);
  const last = rows[rows.length - 1];
  const hide = hides(auth, t.rows[0].blind);
  return {
    items: rows.map((x) => lineView(x, hide)),
    nextCursor:
      more && last ? encodeCursor({ l: last.location_code, s: last.sku_code, i: last.id }) : null,
  };
}

/** 按仓位整体提交（02 §8 step 2）：锁仓位 → 读当时全部余额 → 整体覆盖该仓位的 count_lines。 */
export async function submitCount(
  pool: pg.Pool,
  auth: AuthContext,
  taskId: string,
  body: Out<typeof CountSubmission>,
): Promise<{ taskId: string; locationId: string; lines: LineView[]; needsReview: boolean }> {
  const skuSet = new Set(body.lines.map((l) => l.skuId.toLowerCase()));
  if (skuSet.size !== body.lines.length)
    throw new ApiError('VALIDATION_FAILED', '同一 SKU 在一次提交中出现多次');
  return withTx(pool, async (c) => {
    const t = await c.query<TaskRow>(
      `SELECT id, warehouse_id, status, scope, blind FROM count_tasks WHERE id = $1 FOR UPDATE`,
      [taskId],
    );
    const task = t.rows[0];
    if (!task) throw new ApiError('NOT_FOUND');
    if (task.status !== 'COUNTING' && task.status !== 'REVIEW')
      throw new ApiError('CONFLICT', `任务状态为 ${task.status}，不能提交`, {
        context: { status: task.status },
      });
    const locId = body.locationId.toLowerCase();
    if (!task.scope._locs.includes(locId))
      throw new ApiError('VALIDATION_FAILED', '仓位不在盘点范围');
    const l = await c.query<{ id: string; code: string; is_active: boolean }>(
      `SELECT id, code, is_active FROM locations WHERE id = $1 AND warehouse_id = $2 FOR UPDATE`,
      [locId, task.warehouse_id],
    );
    if (!l.rows[0]) throw new ApiError('NOT_FOUND', '仓位不存在');
    if (!l.rows[0].is_active)
      throw new ApiError('LOCATION_INACTIVE', `仓位 ${l.rows[0].code} 已停用`, {
        context: { locationId: locId, locationCode: l.rows[0].code },
      });
    if (skuSet.size) {
      const k = await c.query<{ n: number }>(
        `SELECT count(*)::int n FROM skus WHERE id = ANY($1::uuid[])`,
        [[...skuSet]],
      );
      if (k.rows[0]!.n !== skuSet.size) throw new ApiError('NOT_FOUND', 'SKU 不存在');
    }
    const bal = await c.query<{ sku_id: string; lot_no: string; on_hand: number }>(
      `SELECT sku_id, lot_no, on_hand FROM stock_balances WHERE location_id = $1`,
      [locId],
    );
    const lotKey = (sku: string, lot: string) => `${sku.toLowerCase()} ${lot}`;
    const sys = new Map(bal.rows.map((b) => [lotKey(b.sku_id, b.lot_no), b.on_hand]));
    const counted = new Map(body.lines.map((x) => [lotKey(x.skuId, x.lotNo ?? ''), x.countedQty]));
    const keys = new Set([
      ...counted.keys(),
      ...bal.rows.filter((b) => b.on_hand > 0).map((b) => lotKey(b.sku_id, b.lot_no)),
    ]);
    const rv = await c.query<{ late: boolean }>(
      `SELECT abs(extract(epoch from (now() - $1::timestamptz))) > extract(epoch from interval '${NEEDS_REVIEW_AFTER}') AS late`,
      [body.clientCountedAt],
    );
    const needsReview = rv.rows[0]!.late;
    await c.query(`DELETE FROM count_lines WHERE task_id = $1 AND location_id = $2`, [
      taskId,
      locId,
    ]);
    const arr = [...keys].sort().map((k) => {
      const i = k.indexOf(' ');
      return { sku: k.slice(0, i), lot: k.slice(i + 1) };
    });
    if (arr.length)
      await c.query(
        `INSERT INTO count_lines (task_id, location_id, sku_id, lot_no, snapshot_qty, system_qty_at_count, counted_qty,
                                  counted_by, client_counted_at, submission_id, needs_review)
         SELECT $1, $2, x.s, x.lot, x.snap, x.sys, x.cnt, $3, $4, $5, $6
           FROM unnest($7::uuid[], $8::text[], $9::int[], $10::int[], $11::int[]) AS x(s, lot, snap, sys, cnt)`,
        [
          taskId,
          locId,
          auth.userId,
          body.clientCountedAt,
          body.submissionId,
          needsReview,
          arr.map((a) => a.sku),
          arr.map((a) => a.lot),
          arr.map((a) => task.scope._snap[snapKey(locId, a.sku, a.lot)] ?? null),
          arr.map((a) => sys.get(lotKey(a.sku, a.lot)) ?? 0),
          arr.map((a) => counted.get(lotKey(a.sku, a.lot)) ?? 0),
        ],
      );
    await c.query(
      `UPDATE count_tasks SET scope = jsonb_set(scope, ARRAY['_submitted', $2::text], $3::jsonb, true) WHERE id = $1`,
      [
        taskId,
        locId,
        JSON.stringify({ submissionId: body.submissionId, at: new Date().toISOString() }),
      ],
    );
    const lines = await c.query<LineRow>(
      `${LINE_SQL} WHERE cl.task_id = $1 AND cl.location_id = $2 ORDER BY s.code`,
      [taskId, locId],
    );
    const hide = hides(auth, task.blind);
    return {
      taskId,
      locationId: locId,
      lines: lines.rows.map((x) => lineView(x, hide)),
      needsReview,
    };
  });
}

/** 关闭（02 §8 step 4，B-N4）：同一事务内 CAS → delta 型 COUNT_ADJUST（幂等键 count-close:{id}）→ 回写。 */
export async function closeCount(
  pool: pg.Pool,
  bus: EventBus | null,
  auth: AuthContext,
  taskId: string,
  confirmPendingOutbox: boolean,
  meta: { ip?: string | null; traceId?: string | null } = {},
): Promise<{ task: TaskView; adjustTxnId: string | null }> {
  const t0 = await pool.query<{
    warehouse_id: string;
    status: string;
    closed_txn_id: string | null;
  }>(`SELECT warehouse_id, status, closed_txn_id FROM count_tasks WHERE id = $1`, [taskId]);
  const pre = t0.rows[0];
  if (!pre) throw new ApiError('NOT_FOUND');
  if (pre.status === 'CLOSED')
    return { task: await getTask(pool, taskId), adjustTxnId: pre.closed_txn_id };
  const pend = await pool.query<{ devices: number; records: number }>(
    `SELECT count(*)::int AS devices, COALESCE(sum(pending_outbox), 0)::int AS records
       FROM devices WHERE pending_outbox > 0 AND pending_warehouse_id = $1 AND disabled_at IS NULL`,
    [pre.warehouse_id],
  );
  if (pend.rows[0]!.devices > 0 && !confirmPendingOutbox)
    throw new ApiError('COUNT_OUTBOX_PENDING', `仍有 ${pend.rows[0]!.records} 条待同步`, {
      context: pend.rows[0]!,
    });

  let outcome: EngineOutcome | null = null;
  try {
    const res = await withTx(pool, async (c) => {
      outcome = null; // 死锁重试时丢弃上一次尝试的结果
      const t = await c.query<{
        status: string;
        warehouse_id: string;
        closed_txn_id: string | null;
        code: string;
      }>(
        `SELECT status, warehouse_id, closed_txn_id, code FROM count_tasks WHERE id = $1 FOR UPDATE`,
        [taskId],
      );
      const task = t.rows[0]!;
      if (task.status === 'CLOSED') return { adjustTxnId: task.closed_txn_id };
      if (task.status !== 'REVIEW')
        throw new ApiError('CONFLICT', `任务状态为 ${task.status}，只有 REVIEW 可关闭`, {
          context: { status: task.status },
        });
      const review = await c.query<{ location_id: string }>(
        `SELECT DISTINCT location_id FROM count_lines WHERE task_id = $1 AND needs_review ORDER BY location_id`,
        [taskId],
      );
      if (review.rows.length)
        throw new ApiError('COUNT_RECOUNT_REQUIRED', '有仓位需要重盘', {
          context: { locationIds: review.rows.map((r) => r.location_id), lines: [] },
        });
      // ① CAS（行已锁，WHERE 保留状态条件）
      const cas = await c.query(
        `UPDATE count_tasks SET status = 'CLOSED', closed_at = now() WHERE id = $1 AND status = 'REVIEW'`,
        [taskId],
      );
      if (cas.rowCount !== 1) throw new ApiError('CONFLICT');
      // ② delta 型 COUNT_ADJUST：每行 delta = 提交时固定的 variance
      const v = await c.query<{
        location_id: string;
        sku_id: string;
        lot_no: string;
        variance: number;
      }>(
        `SELECT location_id, sku_id, lot_no, variance FROM count_lines WHERE task_id = $1 AND variance <> 0`,
        [taskId],
      );
      let adjustTxnId: string | null = null;
      if (v.rows.length) {
        outcome = await applyTxn(c, {
          warehouseId: task.warehouse_id,
          type: 'COUNT_ADJUST',
          idempotencyKey: `count-close:${taskId}`,
          requestHash: sha256(canonicalize({ countClose: taskId })),
          refNo: task.code,
          performedBy: auth.userId,
          submittedBy: auth.userId,
          deviceId: auth.deviceId,
          createdOffline: false,
          clientCreatedAt: null,
          plan: plan({
            type: 'COUNT_ADJUST',
            lines: v.rows.map((x) => ({
              locationId: x.location_id,
              skuId: x.sku_id,
              lotNo: x.lot_no,
              qtyDelta: x.variance,
            })),
          }),
          enforceCapacity: false,
          audit: {
            action: 'inventory.count_adjust',
            ip: meta.ip,
            traceId: meta.traceId,
            extra: { taskId },
          },
        });
        adjustTxnId = outcome.result.txn.id;
        // ③ 回写
        await c.query(`UPDATE count_tasks SET closed_txn_id = $2 WHERE id = $1`, [
          taskId,
          adjustTxnId,
        ]);
      }
      await writeAudit(c, {
        userId: auth.userId,
        warehouseId: task.warehouse_id,
        action: 'count.close',
        entity: 'count_task',
        entityId: taskId,
        before: { status: 'REVIEW' },
        after: { status: 'CLOSED', adjustTxnId, lines: v.rows.length, confirmPendingOutbox },
        deviceId: auth.deviceId,
        ip: meta.ip ?? null,
        traceId: meta.traceId ?? null,
      });
      return { adjustTxnId };
    });
    if (outcome && bus) publishStockChanged(bus, pre.warehouse_id, outcome);
    return { task: await getTask(pool, taskId), adjustTxnId: res.adjustTxnId };
  } catch (e) {
    if (
      e instanceof ApiError &&
      (e.code === 'INSUFFICIENT_STOCK' || e.code === 'LOCATION_INACTIVE')
    ) {
      // 整个关闭已回滚；在新事务里标记问题行 needs_review，任务仍为 REVIEW
      if (e.code === 'LOCATION_INACTIVE') {
        const locId = String(
          (e.extra?.context as { locationId?: string } | undefined)?.locationId ?? '',
        );
        const marked = await withTx(pool, async (c) => {
          const r = await c.query<{ location_id: string; sku_id: string }>(
            `UPDATE count_lines SET needs_review = true
              WHERE task_id = $1 AND ($2::uuid IS NULL OR location_id = $2)
             RETURNING location_id, sku_id`,
            [taskId, locId || null],
          );
          return r.rows;
        });
        throw new ApiError('COUNT_RECOUNT_REQUIRED', '关闭时遇到已停用仓位，相关行需要重盘', {
          context: {
            locationIds: [
              ...new Set(marked.map((l) => l.location_id).concat(locId ? [locId] : [])),
            ],
            reason: 'LOCATION_INACTIVE',
            lines: marked.map((l) => ({ locationId: l.location_id, skuId: l.sku_id })),
          },
        });
      }
      const lines = await withTx(pool, async (c) => {
        const r = await c.query<{
          location_id: string;
          sku_id: string;
          variance: number;
          available: number;
        }>(
          `UPDATE count_lines cl SET needs_review = true
             FROM (SELECT cl2.id, COALESCE(b.on_hand, 0) AS available
                     FROM count_lines cl2
                     LEFT JOIN stock_balances b ON b.location_id = cl2.location_id AND b.sku_id = cl2.sku_id AND b.lot_no = cl2.lot_no
                    WHERE cl2.task_id = $1 AND cl2.variance < 0 AND COALESCE(b.on_hand, 0) < -cl2.variance) x
            WHERE cl.id = x.id
           RETURNING cl.location_id, cl.sku_id, cl.variance, x.available`,
          [taskId],
        );
        return r.rows;
      });
      const ctx = (e.extra?.context ?? {}) as Record<string, unknown>;
      const all = lines.length
        ? lines
        : [
            {
              location_id: ctx.locationId,
              sku_id: ctx.skuId,
              variance: -Number(ctx.requested),
              available: ctx.available,
            },
          ];
      throw new ApiError('COUNT_RECOUNT_REQUIRED', '关闭时余额不足，相关仓位需要重盘', {
        context: {
          locationIds: [...new Set(all.map((l) => l.location_id))],
          lines: all.map((l) => ({
            locationId: l.location_id,
            skuId: l.sku_id,
            variance: l.variance,
            available: l.available,
          })),
        },
      });
    }
    throw e;
  }
}
