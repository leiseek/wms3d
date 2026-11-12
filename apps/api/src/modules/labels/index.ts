import {
  routes,
  type LabelTemplate,
  type ReprintRequest as ReprintRequestSchema,
} from '@wms3d/contracts';
import type { z } from 'zod';
import { toPayload } from '@wms3d/domain';
import { auditCtx, writeAudit } from '../../lib/audit.ts';
import {
  decodeCursor,
  encodeCursor,
  iso,
  isoOrNull,
  poolOf,
  withTx,
  type Queryable,
} from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import type { ApiModule } from '../types.ts';
import {
  checkCapacity,
  labelTemplates as libTemplates,
  MAX_LABELS_PER_RENDER,
  renderCalibrationPdf,
  renderLabelsPdf,
  renderLabelsZpl,
  type LabelItem,
} from '@wms3d/labels';

export const MAX_LABELS = MAX_LABELS_PER_RENDER;

/** 库内模板描述 → 契约 LabelTemplate（只暴露契约字段）。 */
export const labelTemplates: LabelTemplate[] = libTemplates.map((t) => ({
  key: t.key,
  name: t.name,
  kinds: [...t.kinds],
  widthMm: t.widthMm,
  heightMm: t.heightMm,
  sheet: t.sheet,
  maxModules: t.maxModules,
  supportsBarePayload: t.supportsBarePayload,
}));

type ReprintRequest = z.infer<typeof ReprintRequestSchema>;

interface ReprintRow {
  id: string;
  warehouse_id: string;
  kind: ReprintRequest['kind'];
  entity_id: string;
  code: string | null;
  reason: ReprintRequest['reason'];
  note: string | null;
  status: ReprintRequest['status'];
  requested_by: string;
  requested_at: Date;
  done_at: Date | null;
}
const REPRINT_SQL = `SELECT q.*, COALESCE(l.code, r.code, s.code) AS code
  FROM label_reprint_requests q
  LEFT JOIN locations l ON q.kind = 'LOCATION' AND l.id = q.entity_id
  LEFT JOIN racks r ON q.kind = 'RACK' AND r.id = q.entity_id
  LEFT JOIN skus s ON q.kind = 'SKU' AND s.id = q.entity_id`;
const reprintView = (x: ReprintRow): ReprintRequest => ({
  id: x.id,
  warehouseId: x.warehouse_id,
  kind: x.kind,
  entityId: x.entity_id,
  code: x.code ?? '',
  reason: x.reason,
  note: x.note,
  status: x.status,
  requestedBy: x.requested_by,
  requestedAt: iso(x.requested_at),
  doneAt: isoOrNull(x.done_at),
});
async function loadReprint(q: Queryable, id: string): Promise<ReprintRequest | null> {
  const r = await q.query<ReprintRow>(`${REPRINT_SQL} WHERE q.id = $1`, [id]);
  return r.rows[0] ? reprintView(r.rows[0]) : null;
}

type Filter = {
  zone?: string | undefined;
  rack?: string | undefined;
  codeFrom?: string | undefined;
  codeTo?: string | undefined;
};

async function resolveItems(
  q: Queryable,
  kind: LabelItem['kind'],
  warehouseId: string,
  ids: string[] | undefined,
  f: Filter | undefined,
): Promise<LabelItem[]> {
  const w = await q.query<{ code: string; name: string; prefix: boolean }>(
    `SELECT code, name, barcode_prefix_enabled AS prefix FROM warehouses WHERE id = $1`,
    [warehouseId],
  );
  const wh = w.rows[0]!;
  const args = [
    warehouseId,
    ids ?? null,
    f?.zone ?? null,
    f?.rack ?? null,
    f?.codeFrom ?? null,
    f?.codeTo ?? null,
    MAX_LABELS + 1,
  ];
  if (kind === 'LOCATION') {
    const r = await q.query<{ code: string; level: number | null }>(
      `SELECT l.code, l.level FROM locations l
         LEFT JOIN zones z ON z.id = l.zone_id LEFT JOIN racks k ON k.id = l.rack_id
        WHERE l.warehouse_id = $1
          AND (CASE WHEN $2::uuid[] IS NOT NULL THEN l.id = ANY($2::uuid[]) ELSE l.is_active END)
          AND ($3::text IS NULL OR z.code = $3) AND ($4::text IS NULL OR k.code = $4)
          AND ($5::text IS NULL OR l.code >= $5) AND ($6::text IS NULL OR l.code <= $6)
        ORDER BY l.code LIMIT $7`,
      args,
    );
    return r.rows.map((x) => ({
      kind,
      code: x.code,
      payload: toPayload(wh.code, x.code, wh.prefix),
      subtitle: wh.name,
    }));
  }
  if (kind === 'RACK') {
    const r = await q.query<{ code: string }>(
      `SELECT k.code FROM racks k LEFT JOIN zones z ON z.id = k.zone_id
        WHERE k.warehouse_id = $1 AND k.is_active
          AND ($2::uuid[] IS NULL OR k.id = ANY($2::uuid[]))
          AND ($3::text IS NULL OR z.code = $3) AND ($4::text IS NULL OR k.code = $4)
          AND ($5::text IS NULL OR k.code >= $5) AND ($6::text IS NULL OR k.code <= $6)
        ORDER BY k.code LIMIT $7`,
      args,
    );
    return r.rows.map((x) => ({
      kind,
      code: x.code,
      payload: toPayload(wh.code, x.code, wh.prefix),
      subtitle: wh.name,
    }));
  }
  const r = await q.query<{ code: string; name: string; barcode: string | null }>(
    `SELECT s.code, s.name,
            (SELECT b.barcode FROM sku_barcodes b WHERE b.sku_id = s.id ORDER BY b.is_primary DESC, b.barcode LIMIT 1) AS barcode
       FROM skus s
      WHERE (CASE WHEN $1::uuid[] IS NOT NULL THEN s.id = ANY($1::uuid[]) ELSE s.is_active END)
        AND ($2::text IS NULL OR s.code >= $2) AND ($3::text IS NULL OR s.code <= $3)
      ORDER BY s.code LIMIT $4`,
    [ids ?? null, f?.codeFrom ?? null, f?.codeTo ?? null, MAX_LABELS + 1],
  );
  return r.rows.map((x) => ({ kind, code: x.code, payload: x.barcode ?? x.code, title: x.name }));
}

/** labels 模块（07）：模板、PDF 渲染（容量校验、≤ 5000 张、审计）、校准页、补打请求队列。 */
export const labelsModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.listLabelTemplates, async () => ({ items: labelTemplates }));

  r.register(routes.renderLabels, async ({ body, warehouseId, req, reply }) => {
    const t = labelTemplates.find((x) => x.key === body.template)!;
    // 货架标签只能用 rack-100x150（模板 kinds 由 @wms3d/labels 定义）
    if (!t.kinds.includes(body.kind))
      throw new ApiError('VALIDATION_FAILED', `模板 ${t.key} 不支持 ${body.kind} 标签`, {
        errors: [{ path: 'template', message: `支持：${t.kinds.join(', ')}` }],
      });
    const pool = poolOf(services);
    const items = await resolveItems(pool, body.kind, warehouseId!, body.ids, body.filter);
    if (!items.length) throw new ApiError('VALIDATION_FAILED', '没有可打印的对象');
    if (items.length > MAX_LABELS)
      throw new ApiError('VALIDATION_FAILED', `单次最多 ${MAX_LABELS} 张`);
    const tooLong = items
      .map((it) => ({ it, cap: checkCapacity(body.template, it.payload, body.dpi) }))
      .filter((x) => !x.cap.ok);
    if (tooLong.length)
      throw new ApiError(
        'VALIDATION_FAILED',
        `${tooLong.length} 个条码超出模板 ${t.key} 容量，请换更宽的模板`,
        {
          context: {
            max: tooLong[0]!.cap.max,
            items: tooLong.slice(0, 50).map((x) => ({ code: x.it.code, modules: x.cap.modules })),
          },
        },
      );
    // ZPL 为实验性（07 §1）：仅单张标签模板，A4 多联只出 PDF
    if (body.format === 'ZPL' && t.sheet)
      throw new ApiError('VALIDATION_FAILED', 'A4 多联模板不支持 ZPL', {
        errors: [{ path: 'format', message: 'PDF' }],
      });
    const out =
      body.format === 'ZPL'
        ? await renderLabelsZpl({ template: body.template, dpi: body.dpi, items })
        : await renderLabelsPdf({
            template: body.template,
            dpi: body.dpi,
            ...(body.startCell ? { startCell: body.startCell } : {}),
            ...(body.offsetMm ? { offsetMm: body.offsetMm } : {}),
            items,
          });
    const done = await withTx(pool, async (c) => {
      let marked: string[] = [];
      if (body.reprintRequestIds?.length) {
        const u = await c.query<{ id: string }>(
          `UPDATE label_reprint_requests SET status = 'DONE', done_at = now()
            WHERE id = ANY($1::uuid[]) AND warehouse_id = $2 AND status = 'PENDING' RETURNING id`,
          [body.reprintRequestIds, warehouseId],
        );
        marked = u.rows.map((x) => x.id);
      }
      await writeAudit(c, {
        ...auditCtx(req),
        warehouseId,
        action: 'labels.render',
        entity: 'label',
        after: {
          template: body.template,
          kind: body.kind,
          dpi: body.dpi,
          format: body.format,
          count: items.length,
          reprintsDone: marked.length,
        },
      });
      return marked;
    });
    const zpl = typeof out === 'string';
    return reply
      .code(200)
      .type(zpl ? 'application/vnd.zebra.zpl; charset=utf-8' : 'application/pdf')
      .header(
        'content-disposition',
        `inline; filename="labels-${body.template}.${zpl ? 'zpl' : 'pdf'}"`,
      )
      .header('X-Label-Count', String(items.length))
      .header('X-Reprints-Done', String(done.length))
      .send(zpl ? out : Buffer.from(out));
  });

  r.register(routes.calibrationPdf, async ({ query, reply }) => {
    if (query.dpi !== 203 && query.dpi !== 300)
      throw new ApiError('VALIDATION_FAILED', 'dpi 只能是 203 或 300', {
        errors: [{ path: 'dpi', message: '203 | 300' }],
      });
    const pdf = await renderCalibrationPdf({ template: query.template, dpi: query.dpi });
    return reply
      .code(200)
      .type('application/pdf')
      .header('content-disposition', `inline; filename="calibration-${query.template}.pdf"`)
      .send(Buffer.from(pdf));
  });

  r.register(routes.listReprints, async ({ query, warehouseId }) => {
    const pool = poolOf(services);
    const after = decodeCursor<[string, string]>(query.cursor);
    const rows = await pool.query<ReprintRow>(
      `${REPRINT_SQL}
        WHERE q.warehouse_id = $1 AND ($2::text IS NULL OR q.status = $2)
          AND ($3::timestamptz IS NULL OR (q.requested_at, q.id) < ($3::timestamptz, $4::uuid))
        ORDER BY q.requested_at DESC, q.id DESC LIMIT $5`,
      [warehouseId, query.status ?? null, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    const more = rows.rows.length > query.limit;
    const page = rows.rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(reprintView),
      nextCursor: more && last ? encodeCursor([iso(last.requested_at), last.id]) : null,
    };
  });

  r.register(routes.createReprint, async ({ body, auth, req }) => {
    const pool = poolOf(services);
    const out = await withTx(pool, async (c) => {
      const exists =
        body.kind === 'LOCATION'
          ? await c.query(`SELECT 1 FROM locations WHERE id = $1 AND warehouse_id = $2`, [
              body.entityId,
              body.warehouseId,
            ])
          : body.kind === 'RACK'
            ? await c.query(`SELECT 1 FROM racks WHERE id = $1 AND warehouse_id = $2`, [
                body.entityId,
                body.warehouseId,
              ])
            : await c.query(`SELECT 1 FROM skus WHERE id = $1`, [body.entityId]);
      if (!exists.rowCount) throw new ApiError('NOT_FOUND', '标签对象不存在');
      const dup = await c.query<{ id: string }>(
        `SELECT id FROM label_reprint_requests
          WHERE warehouse_id = $1 AND kind = $2 AND entity_id = $3 AND status = 'PENDING' LIMIT 1`,
        [body.warehouseId, body.kind, body.entityId],
      );
      if (dup.rows[0]) return { r: (await loadReprint(c, dup.rows[0].id))!, created: false };
      const ins = await c.query<{ id: string }>(
        `INSERT INTO label_reprint_requests (warehouse_id, kind, entity_id, reason, note, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [body.warehouseId, body.kind, body.entityId, body.reason, body.note ?? null, auth.userId],
      );
      const rp = (await loadReprint(c, ins.rows[0]!.id))!;
      await writeAudit(c, {
        ...auditCtx(req),
        warehouseId: body.warehouseId,
        action: 'label.reprint.request',
        entity: 'label_reprint_request',
        entityId: rp.id,
        after: { kind: rp.kind, code: rp.code, reason: rp.reason },
      });
      return { r: rp, created: true };
    });
    if (out.created)
      services.bus.publish(body.warehouseId, { event: 'reprint.created', data: { count: 1 } });
    return out.r;
  });

  r.register(routes.patchReprint, async ({ params, body, warehouseId, req }) => {
    return withTx(poolOf(services), async (c) => {
      const cur = await c.query<{ status: string }>(
        `SELECT status FROM label_reprint_requests WHERE id = $1 AND warehouse_id = $2 FOR UPDATE`,
        [params.id, warehouseId],
      );
      const st = cur.rows[0]?.status;
      if (!st) throw new ApiError('NOT_FOUND', '补打请求不存在');
      if (st !== 'PENDING' && st !== body.status)
        throw new ApiError('CONFLICT', `补打请求已是 ${st}`);
      if (st === 'PENDING') {
        await c.query(
          `UPDATE label_reprint_requests SET status = $2, done_at = CASE WHEN $2 = 'DONE' THEN now() ELSE NULL END WHERE id = $1`,
          [params.id, body.status],
        );
        await writeAudit(c, {
          ...auditCtx(req),
          warehouseId,
          action: 'label.reprint.update',
          entity: 'label_reprint_request',
          entityId: params.id,
          before: { status: st },
          after: { status: body.status },
        });
      }
      return (await loadReprint(c, params.id))!;
    });
  });
};
