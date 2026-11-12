/**
 * 演示数据（09 §4）：主数据直接写入（用户、仓库、货架类型、已发布布局 v1 及其投影、SKU/条码、条码注册表）。
 * 初始库存由 WS-A2 在 postTransaction 完成后以 INBOUND 交易补充（`--with-stock`，见 docs/workstreams/ws-a2.md）。
 * 幂等：WH1 已存在则跳过。用法：node --experimental-strip-types src/db/seed-demo.ts [<url>]（缺省 DATABASE_URL）
 */
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import pg from 'pg';
import { demo } from '@wms3d/domain';

export async function seedDemo(url: string): Promise<'seeded' | 'skipped'> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const exists = await client.query(`SELECT 1 FROM warehouses WHERE code = $1`, [
      demo.demoWarehouse.code,
    ]);
    if (exists.rowCount) return 'skipped';
    const hash = await argon2.hash(demo.DEMO_PASSWORD, { type: argon2.argon2id });
    await client.query('BEGIN');
    for (const w of [demo.demoWarehouse, demo.demoWarehouse2]) {
      await client.query(
        `INSERT INTO warehouses (id, code, name, timezone, width_m, depth_m, height_m, location_code_pattern, barcode_prefix_enabled, allow_mixed_sku)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          w.id,
          w.code,
          w.name,
          w.timezone,
          w.widthM,
          w.depthM,
          w.heightM,
          w.locationCodePattern,
          w.barcodePrefixEnabled,
          w.allowMixedSku,
        ],
      );
    }
    const whByCode = new Map<string, string>(
      [demo.demoWarehouse, demo.demoWarehouse2].map((w) => [w.code, w.id]),
    );
    for (const u of demo.demoUsers) {
      await client.query(
        `INSERT INTO users (id, username, display_name, password_hash, role, all_warehouses, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,false)`,
        [u.id, u.username, u.displayName, hash, u.role, u.allWarehouses],
      );
      for (const c of u.warehouseCodes) {
        await client.query(`INSERT INTO user_warehouses (user_id, warehouse_id) VALUES ($1,$2)`, [
          u.id,
          whByCode.get(c),
        ]);
      }
    }
    const admin = demo.demoUsers[0]!.id;
    const whId = demo.demoWarehouse.id;
    const doc = demo.demoLayout;
    for (const rt of doc.rackTypes) {
      await client.query(`INSERT INTO rack_types (key, name, spec) VALUES ($1,$2,$3)`, [
        rt.key,
        rt.name ?? null,
        JSON.stringify(rt),
      ]);
    }
    await client.query(
      `INSERT INTO layout_versions (warehouse_id, version, status, doc, created_by, published_at, published_by) VALUES ($1,1,'PUBLISHED',$2,$3,now(),$3)`,
      [whId, JSON.stringify(doc), admin],
    );
    const zoneIds = new Map<string, string>();
    for (const z of doc.zones) {
      const r = await client.query<{ id: string }>(
        `INSERT INTO zones (warehouse_id, layout_version, code, name, kind, polygon, color) VALUES ($1,1,$2,$3,$4,$5,$6) RETURNING id`,
        [whId, z.code, z.name ?? null, z.kind, JSON.stringify(z.polygon), z.color ?? null],
      );
      zoneIds.set(z.code, r.rows[0]!.id);
    }
    const docRack = new Map(doc.racks.map((r) => [r.key, r]));
    for (const r of demo.demoRacks) {
      const d = docRack.get(r.key)!;
      await client.query(
        `INSERT INTO racks (id, warehouse_id, zone_id, layout_key, code, aisle, side, rack_no, bay_start, rack_type, pos_x, pos_z, rotation_deg, layout_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1)`,
        [
          r.id,
          whId,
          zoneIds.get(r.zone),
          r.key,
          r.code,
          r.aisle,
          r.side,
          r.rackNo,
          r.bayStart,
          JSON.stringify(r.type),
          d.x,
          d.z,
          d.rotationDeg,
        ],
      );
      await client.query(
        `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id) VALUES ($1,'RACK',$2,$3)`,
        [`${demo.demoWarehouse.code}.${r.code}`, whId, r.id],
      );
    }
    for (const l of demo.demoLocations) {
      const rackDoc = l.rackKey ? docRack.get(l.rackKey) : undefined;
      const maxQty = rackDoc
        ? (doc.rackTypes.find((t) => t.key === rackDoc.type)?.defaultMaxQty ?? null)
        : null;
      await client.query(
        `INSERT INTO locations (id, warehouse_id, zone_id, rack_id, code, bay, level, position, rack_bay_index, kind, pick_seq, max_qty)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          l.id,
          whId,
          zoneIds.get(l.zone),
          l.rackId,
          l.code,
          l.bay,
          l.level,
          l.position,
          l.rackBayIndex,
          l.kind,
          l.pickSeq,
          maxQty,
        ],
      );
      await client.query(
        `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id) VALUES ($1,'LOCATION',$2,$3)`,
        [l.payload, whId, l.id],
      );
    }
    await client.query(`UPDATE warehouses SET published_layout_version = 1 WHERE id = $1`, [whId]);
    for (const s of demo.demoSkus) {
      await client.query(
        `INSERT INTO skus (id, code, name, spec, uom, safety_stock) VALUES ($1,$2,$3,$4,$5,$6)`,
        [s.id, s.code, s.name, s.spec, s.uom, s.safetyStock],
      );
      for (const b of s.barcodes) {
        await client.query(
          `INSERT INTO sku_barcodes (id, sku_id, barcode, pack_qty, is_primary) VALUES ($1,$2,$3,$4,$5)`,
          [b.id, s.id, b.barcode, b.packQty, b.isPrimary],
        );
        await client.query(
          `INSERT INTO barcode_registry (value, kind, warehouse_id, entity_id) VALUES ($1,'SKU',NULL,$2)`,
          [b.barcode, s.id],
        );
      }
    }
    await client.query('COMMIT');
    return 'seeded';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('缺少数据库 URL（参数或 DATABASE_URL）');
    process.exit(2);
  }
  seedDemo(url).then(
    (r) => console.log(r === 'seeded' ? '演示数据已写入' : 'WH1 已存在，跳过'),
    (e: unknown) => {
      console.error('写入失败：', e);
      process.exit(1);
    },
  );
}
