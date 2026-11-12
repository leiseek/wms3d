import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MAX_COMMAND_LINES, PlanError, planMovements, type ResolvedCommand } from './plan.ts';

const L1 = '00000000-0000-4000-8000-00000000000a';
const L2 = '00000000-0000-4000-8000-00000000000b';
const L3 = 'F0000000-0000-4000-8000-000000000001';
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '20000000-0000-4000-8000-000000000002';

describe('planMovements（02 §6.1）', () => {
  it('INBOUND / OUTBOUND 符号与排序', () => {
    const p = planMovements({
      type: 'INBOUND',
      lines: [
        { locationId: L2, skuId: S1, qty: 3 },
        { locationId: L1, skuId: S2, qty: 1 },
        { locationId: L1, skuId: S1, qty: 2 },
      ],
    });
    expect(p.lockLocations).toEqual([L1, L2]);
    expect(p.deltas.map((d) => [d.locationId, d.skuId, d.delta])).toEqual([
      [L1, S1, 2],
      [L1, S2, 1],
      [L2, S1, 3],
    ]);
    expect(p.hasInbound).toBe(true);
    const o = planMovements({ type: 'OUTBOUND', lines: [{ locationId: L1, skuId: S1, qty: 4 }] });
    expect(o.deltas[0]!.delta).toBe(-4);
    expect(o.hasInbound).toBe(false);
  });

  it('TRANSFER 展开为 from −q / to +q，同键合并', () => {
    const p = planMovements({
      type: 'TRANSFER',
      lines: [
        { fromLocationId: L2, toLocationId: L1, skuId: S1, qty: 5 },
        { fromLocationId: L2, toLocationId: L1, skuId: S1, qty: 2 },
      ],
    });
    expect(p.deltas).toEqual([
      { locationId: L1, skuId: S1, lotNo: '', delta: 7 },
      { locationId: L2, skuId: S1, lotNo: '', delta: -7 },
    ]);
  });

  it('合并后为 0 → VALIDATION_FAILED', () => {
    expect(() =>
      planMovements({
        type: 'ADJUST',
        lines: [
          { locationId: L1, skuId: S1, qtyDelta: 3 },
          { locationId: L1, skuId: S1, qtyDelta: -3 },
        ],
      }),
    ).toThrow(PlanError);
    expect(() =>
      planMovements({
        type: 'TRANSFER',
        lines: [
          { fromLocationId: L1, toLocationId: L2, skuId: S1, qty: 1 },
          { fromLocationId: L2, toLocationId: L1, skuId: S1, qty: 1 },
        ],
      }),
    ).toThrow(/合并后为 0/);
  });

  it('非法输入：空、超行数、from=to、非正 qty、0 delta', () => {
    expect(() => planMovements({ type: 'INBOUND', lines: [] })).toThrow(PlanError);
    const many = Array.from({ length: MAX_COMMAND_LINES + 1 }, () => ({
      locationId: L1,
      skuId: S1,
      qty: 1,
    }));
    expect(() => planMovements({ type: 'INBOUND', lines: many })).toThrow(/最多/);
    expect(() =>
      planMovements({
        type: 'TRANSFER',
        lines: [{ fromLocationId: L1, toLocationId: L1.toUpperCase(), skuId: S1, qty: 1 }],
      }),
    ).toThrow(/不能相同/);
    expect(() =>
      planMovements({ type: 'OUTBOUND', lines: [{ locationId: L1, skuId: S1, qty: 0 }] }),
    ).toThrow(PlanError);
    expect(() =>
      planMovements({ type: 'REVERSAL', lines: [{ locationId: L1, skuId: S1, qtyDelta: 0 }] }),
    ).toThrow(PlanError);
    expect(new PlanError('x').code).toBe('VALIDATION_FAILED');
  });

  it('id 归一为小写（与 PG uuid 排序一致），lotNo 参与键', () => {
    const p = planMovements({
      type: 'ADJUST',
      lines: [
        { locationId: L3, skuId: S1, qtyDelta: 1 },
        { locationId: L1, skuId: S1, qtyDelta: 1, lotNo: 'B' },
        { locationId: L1, skuId: S1, qtyDelta: 1, lotNo: 'A' },
      ],
    });
    expect(p.lockLocations).toEqual([L1, L3.toLowerCase()]);
    expect(p.deltas.map((d) => d.lotNo)).toEqual(['A', 'B', '']);
  });

  it('属性：守恒、排序、去重、无 0（随机命令）', () => {
    const loc = fc.constantFrom(L1, L2, L3);
    const sku = fc.constantFrom(S1, S2);
    const qty = fc.integer({ min: 1, max: 50 });
    const cmd: fc.Arbitrary<ResolvedCommand> = fc.oneof(
      fc.record({
        type: fc.constantFrom('INBOUND' as const, 'OUTBOUND' as const),
        lines: fc.array(fc.record({ locationId: loc, skuId: sku, qty }), {
          minLength: 1,
          maxLength: 8,
        }),
      }),
      fc.record({
        type: fc.constant('TRANSFER' as const),
        lines: fc.array(
          fc
            .tuple(loc, loc, sku, qty)
            .filter(([a, b]) => a !== b)
            .map(([fromLocationId, toLocationId, skuId, q]) => ({
              fromLocationId,
              toLocationId,
              skuId,
              qty: q,
            })),
          { minLength: 1, maxLength: 8 },
        ),
      }),
    );
    fc.assert(
      fc.property(cmd, (c) => {
        let p;
        try {
          p = planMovements(c);
        } catch (e) {
          expect(e).toBeInstanceOf(PlanError);
          return;
        }
        // 每键净额 = 输入按键求和
        const expected = new Map<string, number>();
        const add = (l: string, s: string, d: number) => {
          const k = `${l.toLowerCase()}|${s}`;
          expected.set(k, (expected.get(k) ?? 0) + d);
        };
        if (c.type === 'TRANSFER')
          for (const l of c.lines) {
            add(l.fromLocationId, l.skuId, -l.qty);
            add(l.toLocationId, l.skuId, l.qty);
          }
        else if (c.type === 'INBOUND' || c.type === 'OUTBOUND')
          for (const l of c.lines)
            add(l.locationId, l.skuId, c.type === 'INBOUND' ? l.qty : -l.qty);
        for (const [k, v] of [...expected]) if (v === 0) expected.delete(k);
        expect(new Map(p.deltas.map((d) => [`${d.locationId}|${d.skuId}`, d.delta]))).toEqual(
          expected,
        );
        if (c.type === 'TRANSFER') expect(p.deltas.reduce((n, d) => n + d.delta, 0)).toBe(0);
        const keys = p.deltas.map((d) => `${d.locationId}\u0000${d.skuId}\u0000${d.lotNo}`);
        expect([...keys].sort()).toEqual(keys);
        expect(new Set(keys).size).toBe(keys.length);
        expect([...p.lockLocations].sort()).toEqual(p.lockLocations);
        expect(new Set(p.lockLocations)).toEqual(new Set(p.deltas.map((d) => d.locationId)));
        expect(p.hasInbound).toBe(p.deltas.some((d) => d.delta > 0));
      }),
      { numRuns: 300 },
    );
  });
});
