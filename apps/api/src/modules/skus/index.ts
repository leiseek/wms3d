import { routes, SKU_CSV_COLUMNS } from '@wms3d/contracts';
import { auditCtx, writeAudit } from '../../lib/audit.ts';
import {
  decodeCursor,
  encodeCursor,
  isUniqueViolation,
  pgConstraint,
  poolOf,
  withTx,
} from '../../lib/db.ts';
import { ApiError } from '../../lib/problem.ts';
import { lockBarcodes } from '../../lib/registry.ts';
import type { ApiModule } from '../types.ts';
import { csvCell } from './csv.ts';
import { importSkus } from './import.ts';
import {
  assertSkuWrite,
  clashError,
  findBarcodeClashes,
  loadSku,
  normalizePrimary,
  skusView,
  type SkuRow,
} from './service.ts';

/** skus 模块（03 §5、05 §3，D25 组织级主数据）：CRUD、条码登记表（跨实体唯一）、CSV 导入/导出（防公式注入）。 */
export const skusModule: ApiModule = ({ routes: r, services }) => {
  r.register(routes.listSkus, async ({ query }) => {
    const pool = poolOf(services);
    const after = decodeCursor<string>(query.cursor);
    const q = query.q?.trim() || null;
    const like = q ? `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
    const rows = await pool.query<SkuRow>(
      `SELECT s.* FROM skus s
        WHERE ($1::text IS NULL OR s.code > $1)
          AND ($2::text IS NULL OR s.code ILIKE $2 OR s.name ILIKE $2
               OR EXISTS (SELECT 1 FROM sku_barcodes b WHERE b.sku_id = s.id AND b.barcode = $3))
          AND ($4::boolean IS NULL OR s.is_active = $4)
        ORDER BY s.code LIMIT $5`,
      [
        after,
        like,
        q,
        query.isActive === undefined ? null : query.isActive === 'true',
        query.limit + 1,
      ],
    );
    const more = rows.rows.length > query.limit;
    const page = rows.rows.slice(0, query.limit);
    return {
      items: await skusView(pool, page),
      nextCursor: more ? encodeCursor(page[page.length - 1]!.code) : null,
    };
  });

  r.register(routes.createSku, async ({ body, auth, req }) => {
    assertSkuWrite(auth);
    const codes = body.barcodes.map((b) => b.barcode);
    if (new Set(codes).size !== codes.length) throw new ApiError('VALIDATION_FAILED', '条码重复');
    try {
      return await withTx(poolOf(services), async (c) => {
        if (codes.length) {
          await lockBarcodes(c);
          const clashes = await findBarcodeClashes(c, codes);
          if (clashes.length) throw clashError(clashes);
        }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO skus (code, name, spec, uom, length_mm, width_mm, height_mm, weight_g, safety_stock)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            body.code,
            body.name,
            body.spec,
            body.uom,
            body.lengthMm,
            body.widthMm,
            body.heightMm,
            body.weightG,
            body.safetyStock,
          ],
        );
        const id = ins.rows[0]!.id;
        if (codes.length) {
          await c.query(
            `INSERT INTO sku_barcodes (sku_id, barcode, pack_qty, is_primary)
             SELECT $1, * FROM unnest($2::text[], $3::int[], $4::boolean[])`,
            [id, codes, body.barcodes.map((b) => b.packQty), body.barcodes.map((b) => b.isPrimary)],
          );
          await c.query(
            `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id) SELECT v, 'SKU', NULL, $1 FROM unnest($2::text[]) v`,
            [id, codes],
          );
          const firstPrimary = body.barcodes.findIndex((b) => b.isPrimary);
          if (firstPrimary >= 0) {
            const p = await c.query<{ id: string }>(
              `SELECT id FROM sku_barcodes WHERE barcode = $1`,
              [codes[firstPrimary]],
            );
            await normalizePrimary(c, [id], p.rows[0]!.id);
          } else await normalizePrimary(c, [id]);
        }
        const sku = (await loadSku(c, id))!;
        await writeAudit(c, {
          ...auditCtx(req),
          action: 'sku.create',
          entity: 'sku',
          entityId: id,
          after: sku,
        });
        return sku;
      });
    } catch (e) {
      if (isUniqueViolation(e))
        throw /barcode|registry/.test(pgConstraint(e) ?? '')
          ? new ApiError('BARCODE_CONFLICT', '条码已被占用')
          : new ApiError('CONFLICT', 'SKU 编码已存在');
      throw e;
    }
  });

  r.register(routes.getSku, async ({ params }) => {
    const sku = await loadSku(poolOf(services), params.id);
    if (!sku) throw new ApiError('NOT_FOUND', 'SKU 不存在');
    return sku;
  });

  r.register(routes.patchSku, async ({ params, body, auth, req }) => {
    assertSkuWrite(auth);
    return withTx(poolOf(services), async (c) => {
      const before = await loadSku(c, params.id);
      if (!before) throw new ApiError('NOT_FOUND', 'SKU 不存在');
      const set: string[] = [];
      const vals: unknown[] = [params.id];
      const map: Record<string, string> = {
        name: 'name',
        spec: 'spec',
        uom: 'uom',
        lengthMm: 'length_mm',
        widthMm: 'width_mm',
        heightMm: 'height_mm',
        weightG: 'weight_g',
        safetyStock: 'safety_stock',
        isActive: 'is_active',
      };
      for (const [k, colName] of Object.entries(map)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        vals.push(v);
        set.push(`${colName} = $${vals.length}`);
      }
      if (set.length) await c.query(`UPDATE skus SET ${set.join(', ')} WHERE id = $1`, vals);
      const after = (await loadSku(c, params.id))!;
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'sku.update',
        entity: 'sku',
        entityId: params.id,
        before,
        after,
      });
      return after;
    });
  });

  r.register(routes.addSkuBarcode, async ({ params, body, auth, req }) => {
    assertSkuWrite(auth);
    return withTx(poolOf(services), async (c) => {
      const exists = await c.query(`SELECT 1 FROM skus WHERE id = $1 FOR UPDATE`, [params.id]);
      if (!exists.rowCount) throw new ApiError('NOT_FOUND', 'SKU 不存在');
      await lockBarcodes(c);
      const clashes = await findBarcodeClashes(c, [body.barcode]);
      if (clashes.length) throw clashError(clashes);
      const ins = await c.query<{ id: string }>(
        `INSERT INTO sku_barcodes (sku_id, barcode, pack_qty, is_primary) VALUES ($1,$2,$3,$4) RETURNING id`,
        [params.id, body.barcode, body.packQty, body.isPrimary],
      );
      await c.query(
        `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id) VALUES ($1,'SKU',NULL,$2)`,
        [body.barcode, params.id],
      );
      await normalizePrimary(c, [params.id], body.isPrimary ? ins.rows[0]!.id : undefined);
      await c.query(`UPDATE skus SET updated_at = now() WHERE id = $1`, [params.id]);
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'sku.barcode.add',
        entity: 'sku',
        entityId: params.id,
        after: { barcode: body.barcode, packQty: body.packQty, isPrimary: body.isPrimary },
      });
      return (await loadSku(c, params.id))!;
    });
  });

  r.register(routes.deleteSkuBarcode, async ({ params, auth, req }) => {
    assertSkuWrite(auth);
    return withTx(poolOf(services), async (c) => {
      const del = await c.query<{ barcode: string; pack_qty: number }>(
        `DELETE FROM sku_barcodes WHERE id = $1 AND sku_id = $2 RETURNING barcode, pack_qty`,
        [params.barcodeId, params.id],
      );
      if (!del.rows[0]) throw new ApiError('NOT_FOUND', '条码不存在');
      await c.query(
        `DELETE FROM barcode_registry WHERE value = $1 AND kind = 'SKU' AND entity_id = $2`,
        [del.rows[0].barcode, params.id],
      );
      await c.query(
        `INSERT INTO masterdata_tombstones (entity, entity_id) VALUES ('barcode', $1)`,
        [params.barcodeId],
      );
      await normalizePrimary(c, [params.id]);
      await c.query(`UPDATE skus SET updated_at = now() WHERE id = $1`, [params.id]);
      await writeAudit(c, {
        ...auditCtx(req),
        action: 'sku.barcode.delete',
        entity: 'sku',
        entityId: params.id,
        before: { barcode: del.rows[0].barcode, packQty: del.rows[0].pack_qty },
      });
      return (await loadSku(c, params.id))!;
    });
  });

  r.register(routes.importSkus, async ({ query, auth, req }) => {
    assertSkuWrite(auth);
    if (!req.isMultipart())
      throw new ApiError('VALIDATION_FAILED', '需要 multipart/form-data（字段 file）');
    const file = await req.file();
    if (!file) throw new ApiError('VALIDATION_FAILED', '缺少 CSV 文件');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new ApiError('VALIDATION_FAILED', 'CSV 文件过大');
    return importSkus(
      poolOf(services),
      buf.toString('utf8'),
      query.dryRun === 'true',
      auditCtx(req),
    );
  });

  r.register(routes.exportSkus, async ({ reply }) => {
    const pool = poolOf(services);
    const rows = await pool.query<{
      code: string;
      name: string;
      spec: string | null;
      uom: string;
      barcode: string | null;
      pack_qty: number | null;
      safety_stock: number;
      length_mm: number | null;
      width_mm: number | null;
      height_mm: number | null;
      weight_g: number | null;
    }>(
      `SELECT s.code, s.name, s.spec, s.uom, b.barcode, b.pack_qty, s.safety_stock, s.length_mm, s.width_mm, s.height_mm, s.weight_g
         FROM skus s LEFT JOIN sku_barcodes b ON b.sku_id = s.id
        ORDER BY s.code, b.is_primary DESC NULLS LAST, b.barcode`,
    );
    const lines = [SKU_CSV_COLUMNS.join(',')];
    for (const x of rows.rows)
      lines.push(
        [
          x.code,
          x.name,
          x.spec,
          x.uom,
          x.barcode,
          x.pack_qty,
          x.safety_stock,
          x.length_mm,
          x.width_mm,
          x.height_mm,
          x.weight_g,
        ]
          .map(csvCell)
          .join(','),
      );
    return reply
      .code(200)
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="skus.csv"')
      .send('\uFEFF' + lines.join('\r\n') + '\r\n');
  });
};
