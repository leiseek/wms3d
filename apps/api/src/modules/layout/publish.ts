import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { LayoutDoc, LayoutIssue } from '@wms3d/contracts';
import { withLongTransaction } from '../../db/client.ts';
import { LOCK_NS, xactLockSql } from '../../db/locks.ts';
import { writeAudit, type AuditEntry } from '../../lib/audit.ts';
import { num, type Queryable } from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { lockBarcodes, rebuildWarehouseRegistry } from '../../lib/registry.ts';
import { afterLocationsLocked } from '../../lib/tx-hooks.ts';
import { planPublish, validateDoc, type ExistingLoc, type PublishPlan } from './plan.ts';

/** 测试钩子（09 §2 #17：发布事务运行 60s 不被 transaction_timeout 终止）。生产代码不设置。 */
export const layoutTestHooks: { beforeCommit: ((c: pg.PoolClient) => Promise<void>) | null } = {
  beforeCommit: null,
};

export const PUBLISH_TX_TIMEOUT = '120s';

export async function loadExisting(q: Queryable, warehouseId: string): Promise<ExistingLoc[]> {
  const r = await q.query<{
    id: string;
    code: string;
    rack_id: string | null;
    rack_key: string | null;
    rack_bay_index: number | null;
    level: number | null;
    position: number | null;
    is_active: boolean;
    in_registry: boolean;
    on_hand: number;
  }>(
    `SELECT l.id, l.code, l.rack_id, r.layout_key AS rack_key, l.rack_bay_index, l.level, l.position, l.is_active,
            EXISTS (SELECT 1 FROM barcode_registry g WHERE g.entity_id = l.id AND g.kind = 'LOCATION') AS in_registry,
            COALESCE((SELECT sum(b.on_hand) FROM stock_balances b WHERE b.location_id = l.id), 0)::int AS on_hand
       FROM locations l LEFT JOIN racks r ON r.id = l.rack_id
      WHERE l.warehouse_id = $1`,
    [warehouseId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    code: x.code,
    rackId: x.rack_id,
    rackKey: x.rack_key,
    rackBayIndex: x.rack_bay_index,
    level: x.level,
    position: x.position,
    isActive: x.is_active,
    inRegistry: x.in_registry,
    onHand: x.on_hand,
  }));
}

/** validate 端点与发布共用：校验 + 两轮匹配预览。 */
export async function previewPublish(
  q: Queryable,
  warehouseId: string,
  doc: LayoutDoc,
  pattern: string,
): Promise<{ issues: LayoutIssue[]; plan: PublishPlan | null }> {
  const { issues, expanded } = validateDoc(doc, pattern);
  if (!expanded) return { issues, plan: null };
  return { issues, plan: planPublish(expanded, await loadExisting(q, warehouseId)) };
}

export interface PublishInput {
  warehouseId: string;
  rowVersion: number;
  confirmRecode: boolean;
  audit: Omit<AuditEntry, 'action' | 'entity'>;
  userId: string;
}
export interface PublishOutput {
  layoutVersion: number;
  diff: PublishPlan['diff'];
  reprintRequestIds: string[];
  /** 本次是重复点击的幂等返回（未做任何写入） */
  replayed: boolean;
}

const tombstone = `'X-' || upper(substr(replace(id::text, '-', ''), 1, 12))`;

/**
 * 布局发布（02 §9）：长事务（120s，B-N7）+ advisory lock（LAYOUT_PUBLISH 仓库序号 → BARCODE）；
 * 草稿 CAS（rowVersion，412）；权威校验；两轮匹配；被停用/改码/复用仓位按 id 升序 FOR UPDATE 后复核库存；
 * 按 id 写投影（编码唯一约束 DEFERRABLE，互换在提交时检查）；重建登记表；自动生成补打请求；审计同事务。
 */
export async function publishLayout(pool: pg.Pool, inp: PublishInput): Promise<PublishOutput> {
  return withLongTransaction(pool, PUBLISH_TX_TIMEOUT, async (c) => {
    const wh = await c.query<{
      id: string;
      code: string;
      lock_seq: number;
      location_code_pattern: string;
    }>(`SELECT id, code, lock_seq, location_code_pattern FROM warehouses WHERE id = $1`, [
      inp.warehouseId,
    ]);
    const w = wh.rows[0];
    if (!w) throw new ApiError('NOT_FOUND', '仓库不存在');
    const l1 = xactLockSql(LOCK_NS.LAYOUT_PUBLISH, w.lock_seq);
    await c.query(l1.text, l1.values);
    await lockBarcodes(c);

    const idemScope = `layout-publish:${w.id}`;
    const d = await c.query<{ id: string; row_version: number; doc: LayoutDoc }>(
      `SELECT id, row_version, doc FROM layout_versions WHERE warehouse_id = $1 AND status = 'DRAFT' FOR UPDATE`,
      [w.id],
    );
    const draft = d.rows[0];
    if (!draft) {
      // 重复点击：返回已发布版本（D5）
      const prev = await c.query<{ response: Omit<PublishOutput, 'replayed'> }>(
        `SELECT k.response FROM idempotency_keys k
          WHERE k.scope = $1 AND k.key = (SELECT id::text || ':' || $2::text FROM layout_versions
                                           WHERE warehouse_id = $3 AND status IN ('PUBLISHED','ARCHIVED')
                                           ORDER BY version DESC LIMIT 1)`,
        [idemScope, String(inp.rowVersion), w.id],
      );
      if (prev.rows[0]) return { ...prev.rows[0].response, replayed: true };
      throw new ApiError('CONFLICT', '没有可发布的草稿');
    }
    if (draft.row_version !== inp.rowVersion)
      throw new ApiError('PRECONDITION_FAILED', '草稿已被他人修改', {
        context: { currentRowVersion: draft.row_version },
      });

    const doc = draft.doc;
    const { issues, plan } = await previewPublish(c, w.id, doc, w.location_code_pattern);
    if (!plan)
      throw new ApiError('LAYOUT_INVALID', undefined, {
        context: { issues: issues.filter((i) => i.severity === 'ERROR') },
      });

    // 锁被停用/改码/复用的仓位（id 升序，与库存写入同一锁顺序 02 §6.2），锁内复核库存
    const touched = [
      ...new Set([
        ...plan.deactivated.map((e) => e.id),
        ...plan.matches
          .filter((m) => m.round === 2 || plan.expanded.locations[m.idx]!.code !== m.existing.code)
          .map((m) => m.existing.id),
      ]),
    ].sort();
    if (touched.length) {
      await c.query(`SELECT id FROM locations WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [
        touched,
      ]);
      await afterLocationsLocked('publish-locked', touched);
      const fresh = await c.query<{ id: string; on_hand: number }>(
        `SELECT location_id AS id, sum(on_hand)::int AS on_hand FROM stock_balances
          WHERE location_id = ANY($1::uuid[]) GROUP BY location_id`,
        [touched],
      );
      const oh = new Map(fresh.rows.map((x) => [x.id, x.on_hand]));
      for (const x of plan.diff.deactivated) x.onHand = oh.get(x.locationId) ?? 0;
      for (const x of plan.diff.recoded) x.onHand = oh.get(x.locationId) ?? 0;
    }
    const withStock = plan.diff.deactivated.filter((x) => x.onHand > 0);
    if (withStock.length)
      throw new ApiError('LAYOUT_HAS_STOCK', `${withStock.length} 个待停用仓位仍有库存`, {
        context: { locations: withStock },
      });
    const recodeStock = plan.diff.recoded.filter((x) => x.onHand > 0);
    if (recodeStock.length && !inp.confirmRecode)
      throw new ApiError(
        'LAYOUT_RECODE_NEEDS_CONFIRM',
        `${recodeStock.length} 个有库存仓位将改码`,
        {
          context: { recoded: recodeStock },
        },
      );

    const ver = await c.query<{ v: number }>(
      `SELECT COALESCE(max(version), 0) + 1 AS v FROM layout_versions WHERE warehouse_id = $1`,
      [w.id],
    );
    const version = ver.rows[0]!.v;

    // ---- 库区（按 code upsert；不在新布局中的保留旧 layout_version，列表按已发布版本过滤） ----
    const zr = await c.query<{ id: string; code: string }>(
      `INSERT INTO zones (warehouse_id, layout_version, code, name, kind, polygon, color)
       SELECT $1, $2, t.code, t.name, t.kind, t.polygon::jsonb, t.color
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(code, name, kind, polygon, color)
       ON CONFLICT (warehouse_id, code) DO UPDATE SET layout_version = EXCLUDED.layout_version,
         name = EXCLUDED.name, kind = EXCLUDED.kind, polygon = EXCLUDED.polygon, color = EXCLUDED.color
       RETURNING id, code`,
      [
        w.id,
        version,
        doc.zones.map((z) => z.code),
        doc.zones.map((z) => z.name ?? null),
        doc.zones.map((z) => z.kind),
        doc.zones.map((z) => JSON.stringify(z.polygon)),
        doc.zones.map((z) => z.color ?? null),
      ],
    );
    const zoneId = new Map(zr.rows.map((z) => [z.code, z.id]));

    // ---- 货架（按 layout_key 匹配；码变更与停用先换成墓碑码，避免非延迟唯一约束的瞬时冲突） ----
    const er = await c.query<{ id: string; layout_key: string; code: string; is_active: boolean }>(
      `SELECT id, layout_key, code, is_active FROM racks WHERE warehouse_id = $1`,
      [w.id],
    );
    const rackByKey = new Map(er.rows.map((x) => [x.layout_key, x]));
    const docRacks = doc.racks.map((dr, k) => ({ dr, ex: plan.expanded.racks[k]! }));
    const inDoc = new Set(doc.racks.map((x) => x.key));
    const rackDeact = er.rows.filter((x) => x.is_active && !inDoc.has(x.layout_key));
    const rackRecoded = docRacks.filter((x) => {
      const e = rackByKey.get(x.dr.key);
      return e && e.code !== x.ex.code;
    });
    const rackTomb = [
      ...rackDeact.map((x) => x.id),
      ...rackRecoded.map((x) => rackByKey.get(x.dr.key)!.id),
    ];
    if (rackTomb.length)
      await c.query(`UPDATE racks SET code = ${tombstone} WHERE id = ANY($1::uuid[])`, [rackTomb]);
    if (rackDeact.length)
      await c.query(`UPDATE racks SET is_active = false WHERE id = ANY($1::uuid[])`, [
        rackDeact.map((x) => x.id),
      ]);
    const rackCols = (rows: typeof docRacks) => [
      rows.map((x) => zoneId.get(x.dr.zone)!),
      rows.map((x) => x.dr.key),
      rows.map((x) => x.ex.code),
      rows.map((x) => x.ex.aisle),
      rows.map((x) => x.ex.side),
      rows.map((x) => x.ex.rackNo),
      rows.map((x) => x.ex.bayStart),
      rows.map((x) => JSON.stringify(x.ex.type)),
      rows.map((x) => x.dr.x),
      rows.map((x) => x.dr.z),
      rows.map((x) => x.dr.rotationDeg),
    ];
    const keepR = docRacks.filter((x) => rackByKey.has(x.dr.key));
    const newR = docRacks.filter((x) => !rackByKey.has(x.dr.key));
    if (keepR.length)
      await c.query(
        `UPDATE racks r SET zone_id = t.zone_id, code = t.code, aisle = t.aisle, side = t.side, rack_no = t.rack_no,
                bay_start = t.bay_start, rack_type = t.rack_type::jsonb, pos_x = t.x, pos_z = t.z,
                rotation_deg = t.rot, is_active = true, layout_version = $2
           FROM unnest($3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::int[], $8::text[], $9::int[], $10::int[],
                       $11::text[], $12::numeric[], $13::numeric[], $14::int[])
                AS t(id, zone_id, layout_key, code, aisle, side, rack_no, bay_start, rack_type, x, z, rot)
          WHERE r.id = t.id AND r.warehouse_id = $1`,
        [w.id, version, keepR.map((x) => rackByKey.get(x.dr.key)!.id), ...rackCols(keepR)],
      );
    const rackId = new Map(keepR.map((x) => [x.dr.key, rackByKey.get(x.dr.key)!.id]));
    if (newR.length) {
      const ins = await c.query<{ id: string; layout_key: string }>(
        `INSERT INTO racks (warehouse_id, layout_version, zone_id, layout_key, code, aisle, side, rack_no, bay_start,
                            rack_type, pos_x, pos_z, rotation_deg)
         SELECT $1, $2, t.zone_id, t.layout_key, t.code, t.aisle, t.side, t.rack_no, t.bay_start, t.rack_type::jsonb, t.x, t.z, t.rot
           FROM unnest($3::uuid[], $4::text[], $5::text[], $6::int[], $7::text[], $8::int[], $9::int[],
                       $10::text[], $11::numeric[], $12::numeric[], $13::int[])
                AS t(zone_id, layout_key, code, aisle, side, rack_no, bay_start, rack_type, x, z, rot)
         RETURNING id, layout_key`,
        [w.id, version, ...rackCols(newR)],
      );
      for (const x of ins.rows) rackId.set(x.layout_key, x.id);
    }

    // ---- 仓位（按 id 写投影，不依赖 ON CONFLICT；编码唯一约束 DEFERRABLE） ----
    const locs = plan.expanded.locations;
    const ms = plan.matches;
    if (ms.length)
      await c.query(
        `UPDATE locations l SET code = t.code, zone_id = t.zone_id, rack_id = t.rack_id, bay = t.bay, level = t.level,
                position = t.position, rack_bay_index = t.rbi, kind = t.kind, is_active = t.active
           FROM unnest($2::uuid[], $3::text[], $4::uuid[], $5::uuid[], $6::int[], $7::int[], $8::int[], $9::int[],
                       $10::text[], $11::boolean[])
                AS t(id, code, zone_id, rack_id, bay, level, position, rbi, kind, active)
          WHERE l.id = t.id AND l.warehouse_id = $1`,
        [
          w.id,
          ms.map((m) => m.existing.id),
          ms.map((m) => locs[m.idx]!.code),
          ms.map((m) => zoneId.get(locs[m.idx]!.zone)!),
          ms.map((m) => (locs[m.idx]!.rackKey ? rackId.get(locs[m.idx]!.rackKey!)! : null)),
          ms.map((m) => locs[m.idx]!.bay),
          ms.map((m) => locs[m.idx]!.level),
          ms.map((m) => locs[m.idx]!.position),
          ms.map((m) => locs[m.idx]!.rackBayIndex),
          ms.map((m) => locs[m.idx]!.kind),
          ms.map((m) => m.isActive),
        ],
      );
    if (plan.deactivated.length)
      await c.query(
        `UPDATE locations SET is_active = false WHERE id = ANY($1::uuid[]) AND is_active`,
        [plan.deactivated.map((e) => e.id)],
      );
    let addedIds: { id: string; code: string }[] = [];
    if (plan.added.length) {
      const a = plan.added.map((i) => locs[i]!);
      const ins = await c.query<{ id: string; code: string }>(
        `INSERT INTO locations (warehouse_id, zone_id, rack_id, code, bay, level, position, rack_bay_index, kind, pick_seq)
         SELECT $1, t.zone_id, t.rack_id, t.code, t.bay, t.level, t.position, t.rbi, t.kind, t.pick_seq
           FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::int[], $6::int[], $7::int[], $8::int[], $9::text[], $10::int[])
                AS t(zone_id, rack_id, code, bay, level, position, rbi, kind, pick_seq)
         RETURNING id, code`,
        [
          w.id,
          a.map((l) => zoneId.get(l.zone)!),
          a.map((l) => (l.rackKey ? rackId.get(l.rackKey)! : null)),
          a.map((l) => l.code),
          a.map((l) => l.bay),
          a.map((l) => l.level),
          a.map((l) => l.position),
          a.map((l) => l.rackBayIndex),
          a.map((l) => l.kind),
          a.map((l) => l.pickSeq),
        ],
      );
      addedIds = ins.rows;
    }

    // ---- 登记表、版本、仓库 ----
    await rebuildWarehouseRegistry(c, w.id, [
      ...ms.map((m) => m.existing.id),
      ...addedIds.map((x) => x.id),
    ]);
    await c.query(
      `UPDATE layout_versions SET status = 'ARCHIVED' WHERE warehouse_id = $1 AND status = 'PUBLISHED'`,
      [w.id],
    );
    const cas = await c.query(
      `UPDATE layout_versions SET status = 'PUBLISHED', version = $3, published_at = now(), published_by = $4
        WHERE id = $1 AND status = 'DRAFT' AND row_version = $2`,
      [draft.id, inp.rowVersion, version, inp.userId],
    );
    if (!cas.rowCount) throw new ApiError('PRECONDITION_FAILED', '草稿已被他人修改');
    await c.query(
      `UPDATE warehouses SET published_layout_version = $2, width_m = $3, depth_m = $4, height_m = $5 WHERE id = $1`,
      [w.id, version, doc.warehouse.widthM, doc.warehouse.depthM, doc.warehouse.heightM],
    );

    // ---- 待补打（07 §4）：新增 + 改码仓位；新增 + 改码货架 ----
    const rp: { kind: string; id: string; reason: string }[] = [
      ...addedIds.map((x) => ({ kind: 'LOCATION', id: x.id, reason: 'LAYOUT_NEW' })),
      ...plan.diff.recoded.map((x) => ({
        kind: 'LOCATION',
        id: x.locationId,
        reason: 'LAYOUT_RECODE',
      })),
      ...newR.map((x) => ({ kind: 'RACK', id: rackId.get(x.dr.key)!, reason: 'LAYOUT_NEW' })),
      ...rackRecoded.map((x) => ({
        kind: 'RACK',
        id: rackId.get(x.dr.key)!,
        reason: 'LAYOUT_RECODE',
      })),
    ];
    let reprintRequestIds: string[] = [];
    if (rp.length) {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO label_reprint_requests (warehouse_id, kind, entity_id, reason, requested_by)
         SELECT $1, t.kind, t.eid, t.reason, $2 FROM unnest($3::text[], $4::uuid[], $5::text[]) AS t(kind, eid, reason)
         RETURNING id`,
        [w.id, inp.userId, rp.map((x) => x.kind), rp.map((x) => x.id), rp.map((x) => x.reason)],
      );
      reprintRequestIds = ins.rows.map((x) => x.id);
    }

    const result = { layoutVersion: version, diff: plan.diff, reprintRequestIds };
    await writeAudit(c, {
      ...inp.audit,
      warehouseId: w.id,
      action: 'layout.publish',
      entity: 'layout_version',
      entityId: String(num(draft.id)),
      after: {
        layoutVersion: version,
        confirmRecode: inp.confirmRecode,
        added: plan.diff.added.length,
        kept: plan.diff.kept,
        recoded: plan.diff.recoded.length,
        deactivated: plan.diff.deactivated.length,
        reused: plan.diff.reused.length,
        recodedWithStock: recodeStock.map((x) => x.locationId),
      },
    });
    await c.query(
      `INSERT INTO idempotency_keys (scope, key, user_id, request_hash, response) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (scope, key) DO NOTHING`,
      [
        idemScope,
        `${draft.id}:${inp.rowVersion}`,
        inp.userId,
        createHash('sha256').update(`${draft.id}:${inp.rowVersion}`).digest('hex'),
        JSON.stringify(result),
      ],
    );
    if (layoutTestHooks.beforeCommit) await layoutTestHooks.beforeCommit(c);
    return { ...result, replayed: false };
  });
}
