import { routes, type LayoutDoc, type LayoutVersion, type RackTypeSpec } from '@wms3d/contracts';
import { auditCtx, writeAudit } from '../../lib/audit.ts';
import {
  iso,
  isoOrNull,
  isUniqueViolation,
  num,
  poolOf,
  withTx,
  type Queryable,
} from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { loadWarehouse } from '../../lib/wh-views.ts';
import type { ApiModule } from '../types.ts';
import { previewPublish, publishLayout } from './publish.ts';

interface LvRow {
  id: string;
  warehouse_id: string;
  version: number | null;
  status: LayoutVersion['status'];
  row_version: number;
  based_on_version: number | null;
  doc: LayoutDoc;
  created_by: string;
  created_at: Date;
  published_at: Date | null;
  published_by: string | null;
}
const lvView = (r: LvRow): LayoutVersion => ({
  id: num(r.id),
  warehouseId: r.warehouse_id,
  version: r.version,
  status: r.status,
  rowVersion: r.row_version,
  basedOnVersion: r.based_on_version,
  doc: r.doc,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  publishedAt: isoOrNull(r.published_at),
  publishedBy: r.published_by,
});

interface RtRow {
  id: string;
  key: string;
  name: string | null;
  spec: RackTypeSpec;
}
const rtView = (r: RtRow) => ({
  ...r.spec,
  key: r.key,
  ...(r.name ? { name: r.name } : {}),
  id: r.id,
});

async function loadDraft(q: Queryable, warehouseId: string): Promise<LvRow | null> {
  const r = await q.query<LvRow>(
    `SELECT * FROM layout_versions WHERE warehouse_id = $1 AND status = 'DRAFT'`,
    [warehouseId],
  );
  return r.rows[0] ?? null;
}

/** layout 模块（02 §3–§4/§9、05）：模板库、布局版本、草稿 CRUD（If-Match）、校验 + 差异、发布。 */
export const layoutModule: ApiModule = ({ routes: r, services }) => {
  // ---------- 模板库 ----------
  r.register(routes.listRackTypes, async () => {
    const rows = await poolOf(services).query<RtRow>(
      `SELECT id, key, name, spec FROM rack_types ORDER BY key`,
    );
    return { items: rows.rows.map(rtView) };
  });

  r.register(routes.createRackType, async ({ body, req }) => {
    try {
      return await withTx(poolOf(services), async (c) => {
        const ins = await c.query<RtRow>(
          `INSERT INTO rack_types (key, name, spec) VALUES ($1,$2,$3) RETURNING id, key, name, spec`,
          [body.key, body.name ?? null, JSON.stringify(body)],
        );
        const out = rtView(ins.rows[0]!);
        await writeAudit(c, {
          ...auditCtx(req),
          action: 'rack_type.create',
          entity: 'rack_type',
          entityId: out.id,
          after: out,
        });
        return out;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError('CONFLICT', '模板 key 已存在');
      throw e;
    }
  });

  r.register(routes.patchRackType, async ({ params, body, req }) => {
    try {
      return await withTx(poolOf(services), async (c) => {
        const before = await c.query<RtRow>(
          `SELECT id, key, name, spec FROM rack_types WHERE id = $1 FOR UPDATE`,
          [params.id],
        );
        if (!before.rows[0]) throw new ApiError('NOT_FOUND', '模板不存在');
        const upd = await c.query<RtRow>(
          `UPDATE rack_types SET key = $2, name = $3, spec = $4 WHERE id = $1 RETURNING id, key, name, spec`,
          [params.id, body.key, body.name ?? null, JSON.stringify(body)],
        );
        const out = rtView(upd.rows[0]!);
        await writeAudit(c, {
          ...auditCtx(req),
          action: 'rack_type.update',
          entity: 'rack_type',
          entityId: out.id,
          before: rtView(before.rows[0]),
          after: out,
        });
        return out;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError('CONFLICT', '模板 key 已存在');
      throw e;
    }
  });

  // ---------- 版本 ----------
  r.register(routes.listLayoutVersions, async ({ warehouseId }) => {
    const rows = await poolOf(services).query<LvRow>(
      `SELECT * FROM layout_versions WHERE warehouse_id = $1 ORDER BY version DESC NULLS FIRST, id DESC`,
      [warehouseId],
    );
    return {
      items: rows.rows.map((x) => {
        const { doc: _d, ...v } = lvView(x);
        return v;
      }),
    };
  });

  r.register(routes.getLayout, async ({ warehouseId, query }) => {
    const pool = poolOf(services);
    const v = query.version;
    const rows =
      v === 'draft'
        ? await pool.query<LvRow>(
            `SELECT * FROM layout_versions WHERE warehouse_id = $1 AND status = 'DRAFT'`,
            [warehouseId],
          )
        : v === 'published'
          ? await pool.query<LvRow>(
              `SELECT lv.* FROM layout_versions lv JOIN warehouses w ON w.id = lv.warehouse_id
                WHERE lv.warehouse_id = $1 AND lv.version = w.published_layout_version`,
              [warehouseId],
            )
          : await pool.query<LvRow>(
              `SELECT * FROM layout_versions WHERE warehouse_id = $1 AND version = $2`,
              [warehouseId, v],
            );
    if (!rows.rows[0]) throw new ApiError('NOT_FOUND', '布局版本不存在');
    return lvView(rows.rows[0]);
  });

  // ---------- 草稿 ----------
  r.register(routes.createDraft, async ({ warehouseId, body, auth, req }) => {
    const pool = poolOf(services);
    try {
      return await withTx(pool, async (c) => {
        const w = await loadWarehouse(c, warehouseId!);
        if (!w) throw new ApiError('NOT_FOUND', '仓库不存在');
        let doc: LayoutDoc = {
          schemaVersion: 2,
          warehouse: { widthM: num(w.width_m), depthM: num(w.depth_m), heightM: num(w.height_m) },
          zones: [],
          rackTypes: [],
          racks: [],
          floorAreas: [],
        };
        if (body.basedOnVersion !== null) {
          const base = await c.query<{ doc: LayoutDoc }>(
            `SELECT doc FROM layout_versions WHERE warehouse_id = $1 AND version = $2`,
            [warehouseId, body.basedOnVersion],
          );
          if (!base.rows[0])
            throw new ApiError('NOT_FOUND', `布局版本 ${body.basedOnVersion} 不存在`);
          doc = base.rows[0].doc;
        }
        const ins = await c.query<LvRow>(
          `INSERT INTO layout_versions (warehouse_id, status, doc, based_on_version, created_by)
           VALUES ($1, 'DRAFT', $2, $3, $4) RETURNING *`,
          [warehouseId, JSON.stringify(doc), body.basedOnVersion, auth.userId],
        );
        const out = lvView(ins.rows[0]!);
        await writeAudit(c, {
          ...auditCtx(req),
          warehouseId,
          action: 'layout.draft.create',
          entity: 'layout_version',
          entityId: String(out.id),
          after: { basedOnVersion: body.basedOnVersion },
        });
        return out;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError('CONFLICT', '该仓库已有草稿（每仓库仅一个）');
      throw e;
    }
  });

  r.register(routes.saveDraft, async ({ warehouseId, body, ifMatch }) => {
    if (ifMatch === null)
      throw new ApiError('PRECONDITION_FAILED', 'If-Match 必须是 rowVersion 整数');
    const pool = poolOf(services);
    const upd = await pool.query<LvRow>(
      `UPDATE layout_versions SET doc = $3, row_version = row_version + 1
        WHERE warehouse_id = $1 AND status = 'DRAFT' AND row_version = $2 RETURNING *`,
      [warehouseId, ifMatch, JSON.stringify(body.doc)],
    );
    if (upd.rows[0]) return lvView(upd.rows[0]);
    const cur = await loadDraft(pool, warehouseId!);
    if (!cur) throw new ApiError('NOT_FOUND', '草稿不存在');
    throw new ApiError('PRECONDITION_FAILED', '草稿已被他人修改', {
      context: { currentRowVersion: cur.row_version },
    });
  });

  r.register(routes.deleteDraft, async ({ warehouseId, req }) => {
    await withTx(poolOf(services), async (c) => {
      const del = await c.query<{ id: string }>(
        `DELETE FROM layout_versions WHERE warehouse_id = $1 AND status = 'DRAFT' RETURNING id`,
        [warehouseId],
      );
      if (!del.rows[0]) throw new ApiError('NOT_FOUND', '草稿不存在');
      await writeAudit(c, {
        ...auditCtx(req),
        warehouseId,
        action: 'layout.draft.delete',
        entity: 'layout_version',
        entityId: String(num(del.rows[0].id)),
      });
    });
    return undefined;
  });

  r.register(routes.validateLayout, async ({ warehouseId }) => {
    const pool = poolOf(services);
    const w = await loadWarehouse(pool, warehouseId!);
    if (!w) throw new ApiError('NOT_FOUND', '仓库不存在');
    const d = await loadDraft(pool, warehouseId!);
    if (!d) throw new ApiError('NOT_FOUND', '草稿不存在');
    const { issues, plan } = await previewPublish(pool, w.id, d.doc, w.location_code_pattern);
    return {
      issues,
      diff: plan?.diff ?? { added: [], kept: 0, recoded: [], deactivated: [], reused: [] },
      locationCount: plan?.expanded.locations.length ?? 0,
    };
  });

  r.register(routes.publishLayout, async ({ warehouseId, body, auth, req }) => {
    const out = await publishLayout(poolOf(services), {
      warehouseId: warehouseId!,
      rowVersion: body.rowVersion,
      confirmRecode: body.confirmRecode,
      userId: auth.userId,
      audit: auditCtx(req),
    });
    if (!out.replayed) {
      services.bus.publish(warehouseId!, {
        event: 'layout.published',
        data: { layoutVersion: out.layoutVersion },
      });
      if (out.reprintRequestIds.length)
        services.bus.publish(warehouseId!, {
          event: 'reprint.created',
          data: { count: out.reprintRequestIds.length },
        });
    }
    return {
      layoutVersion: out.layoutVersion,
      diff: out.diff,
      reprintRequestIds: out.reprintRequestIds,
    };
  });
};
