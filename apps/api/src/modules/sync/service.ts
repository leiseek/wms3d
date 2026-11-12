/**
 * 主数据同步（03 §5、D24/M28、v2.1 B-N7）。
 * 游标为 (updated_at µs, kind, id) 的组合 keyset，跨 skus / sku_barcodes / 本仓 locations 合并排序；
 * 一轮翻页结束后 nextCursor = 本轮所见最大 updated_at − 180s（安全窗口 > 最长事务 120s），客户端按 id 幂等 upsert。
 * tombstones 仅在增量一轮的第一页返回；total 仅在首次全量第一页返回。
 */
import type { z } from 'zod';
import type { SyncDigest, SyncPage } from '@wms3d/contracts';
import { toPayload } from '@wms3d/domain';
import { ApiError } from '../../lib/problem.ts';
import {
  decodeCursor,
  encodeCursor,
  isRecord,
  iso,
  sha256,
  type Queryable,
} from '../inventory/util.ts';

export const SYNC_SAFETY_WINDOW_S = 180;
const EPOCH = '1970-01-01T00:00:00.000000Z';
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const KINDS = { sku: 1, barcode: 2, location: 3 } as const;

interface SyncCursor {
  /** keyset 起点 updated_at（µs ISO） */
  t: string;
  /** 起点 kind（0 = 本轮开始） */
  k: number;
  i: string;
  /** 本轮已见最大 updated_at */
  h: string;
  /** 本轮是否增量（首页带 tombstones） */
  inc: boolean;
}

const isCursor = (v: unknown): v is SyncCursor =>
  isRecord(v) &&
  typeof v.t === 'string' &&
  typeof v.k === 'number' &&
  typeof v.i === 'string' &&
  /^[0-9a-f-]{36}$/.test(v.i) &&
  typeof v.h === 'string' &&
  typeof v.inc === 'boolean' &&
  !Number.isNaN(Date.parse(v.t)) &&
  !Number.isNaN(Date.parse(v.h));

const US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const usText = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', ${US})`;

type Page = z.output<typeof SyncPage>;

export async function syncPage(
  q: Queryable,
  wh: string,
  query: { cursor?: string | undefined; limit: number },
): Promise<Page> {
  const cur = decodeCursor(query.cursor, isCursor);
  const serverTime = new Date().toISOString();
  const start: SyncCursor = cur ?? { t: EPOCH, k: 0, i: ZERO_ID, h: EPOCH, inc: false };
  const w = await q.query<{ code: string; prefix: boolean }>(
    `SELECT code, barcode_prefix_enabled AS prefix FROM warehouses WHERE id = $1`,
    [wh],
  );
  if (!w.rows[0]) throw new ApiError('NOT_FOUND');
  const { code: whCode, prefix } = w.rows[0];

  const keys = await q.query<{ k: number; id: string; u: string }>(
    `SELECT k, id, ${usText('updated_at')} AS u FROM (
        SELECT ${KINDS.sku} AS k, id, updated_at FROM skus
        UNION ALL SELECT ${KINDS.barcode}, id, updated_at FROM sku_barcodes
        UNION ALL SELECT ${KINDS.location}, id, updated_at FROM locations WHERE warehouse_id = $1
      ) u
      WHERE (updated_at, k, id) > ($2::timestamptz, $3::int, $4::uuid)
      ORDER BY updated_at, k, id
      LIMIT $5`,
    [wh, start.t, start.k, start.i, query.limit + 1],
  );
  const hasMore = keys.rows.length > query.limit;
  const rows = keys.rows.slice(0, query.limit);
  const idsOf = (k: number) => rows.filter((r) => r.k === k).map((r) => r.id);

  const [skus, barcodes, locations] = await Promise.all([
    q.query<{
      id: string;
      code: string;
      name: string;
      spec: string | null;
      uom: string;
      is_active: boolean;
      u: string;
    }>(
      `SELECT id, code, name, spec, uom, is_active, ${usText('updated_at')} AS u
         FROM skus WHERE id = ANY($1::uuid[]) ORDER BY updated_at, id`,
      [idsOf(KINDS.sku)],
    ),
    q.query<{ id: string; sku_id: string; barcode: string; pack_qty: number; u: string }>(
      `SELECT id, sku_id, barcode, pack_qty, ${usText('updated_at')} AS u
         FROM sku_barcodes WHERE id = ANY($1::uuid[]) ORDER BY updated_at, id`,
      [idsOf(KINDS.barcode)],
    ),
    q.query<{
      id: string;
      code: string;
      kind: string;
      is_active: boolean;
      rack_code: string | null;
      u: string;
    }>(
      `SELECT l.id, l.code, l.kind, l.is_active, r.code AS rack_code, ${usText('l.updated_at')} AS u
         FROM locations l LEFT JOIN racks r ON r.id = l.rack_id
        WHERE l.id = ANY($1::uuid[]) AND l.warehouse_id = $2 ORDER BY l.updated_at, l.id`,
      [idsOf(KINDS.location), wh],
    ),
  ]);

  const firstPage = start.k === 0;
  const tombstones =
    firstPage && start.inc
      ? (
          await q.query<{
            entity: 'sku' | 'barcode' | 'location';
            entity_id: string;
            deleted_at: Date;
          }>(
            `SELECT entity, entity_id, deleted_at FROM masterdata_tombstones
              WHERE deleted_at > $2::timestamptz AND entity IN ('sku','barcode','location')
                AND (warehouse_id IS NULL OR warehouse_id = $1)
              ORDER BY id`,
            [wh, start.t],
          )
        ).rows.map((t) => ({ entity: t.entity, id: t.entity_id, deletedAt: iso(t.deleted_at) }))
      : [];

  let total: number | undefined;
  if (!cur) {
    const c = await q.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM skus) + (SELECT count(*) FROM sku_barcodes)
             + (SELECT count(*) FROM locations WHERE warehouse_id = $1))::int AS n`,
      [wh],
    );
    total = c.rows[0]!.n;
  }

  const last = rows[rows.length - 1];
  const high = last && last.u > start.h ? last.u : start.h;
  let next: SyncCursor;
  if (hasMore) {
    next = { t: last!.u, k: last!.k, i: last!.id, h: high, inc: start.inc };
  } else {
    const back = new Date(Date.parse(high) - SYNC_SAFETY_WINDOW_S * 1000);
    const t = high === EPOCH ? EPOCH : back.toISOString().replace('Z', '000Z');
    next = { t, k: 0, i: ZERO_ID, h: high, inc: true };
  }

  return {
    skus: skus.rows.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      spec: s.spec,
      uom: s.uom,
      isActive: s.is_active,
      updatedAt: iso(s.u),
    })),
    barcodes: barcodes.rows.map((b) => ({
      id: b.id,
      skuId: b.sku_id,
      barcode: b.barcode,
      packQty: b.pack_qty,
      updatedAt: iso(b.u),
    })),
    locations: locations.rows.map((l) => ({
      id: l.id,
      code: l.code,
      payload: toPayload(whCode, l.code, prefix),
      kind: l.kind,
      isActive: l.is_active,
      rackCode: l.rack_code,
      updatedAt: iso(l.u),
    })),
    tombstones,
    nextCursor: encodeCursor(next),
    hasMore,
    ...(total === undefined ? {} : { total }),
    serverTime,
  };
}

/**
 * 摘要：三类条数 + sha256(按 (entity, id) 字节序排序的 `entity|id|updatedAt(毫秒 ISO，与 SyncPage 相同)` 以 \n 连接)。
 * 客户端以相同算法对本地副本计算并比对（算法见 docs/contract-requests/ws-a2-1.md）。
 */
export async function syncDigest(q: Queryable, wh: string): Promise<z.output<typeof SyncDigest>> {
  const r = await q.query<{ e: string; id: string; u: string }>(
    `SELECT e, id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS u FROM (
        SELECT 'barcode' AS e, id, updated_at FROM sku_barcodes
        UNION ALL SELECT 'location', id, updated_at FROM locations WHERE warehouse_id = $1
        UNION ALL SELECT 'sku', id, updated_at FROM skus
      ) x ORDER BY e COLLATE "C", id::text COLLATE "C"`,
    [wh],
  );
  const n = { sku: 0, barcode: 0, location: 0 } as Record<string, number>;
  const lines: string[] = [];
  for (const x of r.rows) {
    n[x.e]!++;
    lines.push(`${x.e}|${x.id}|${x.u}`);
  }
  return {
    skus: n.sku!,
    barcodes: n.barcode!,
    locations: n.location!,
    hash: sha256(lines.join('\n')),
  };
}
