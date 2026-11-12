import { describe, expect, it } from 'vitest';
import { highlightIds, reversalBlockedReason, summarizeBySku } from './stock';

describe('summarizeBySku', () => {
  it('按 SKU 汇总，合并同仓位多批次，忽略零库存，排序', () => {
    const rows = [
      {
        locationId: 'l2',
        locationCode: 'A01-02-A01',
        skuId: 's1',
        skuCode: 'SKU-001',
        skuName: '水',
        onHand: 5,
      },
      {
        locationId: 'l1',
        locationCode: 'A01-01-A01',
        skuId: 's1',
        skuCode: 'SKU-001',
        skuName: '水',
        onHand: 3,
      },
      {
        locationId: 'l1',
        locationCode: 'A01-01-A01',
        skuId: 's1',
        skuCode: 'SKU-001',
        skuName: '水',
        onHand: 2,
      },
      {
        locationId: 'l3',
        locationCode: 'A01-03-A01',
        skuId: 's0',
        skuCode: 'SKU-000',
        skuName: '奶',
        onHand: 0,
      },
      {
        locationId: 'l3',
        locationCode: 'A01-03-A01',
        skuId: 's2',
        skuCode: 'SKU-000',
        skuName: '奶',
        onHand: 1,
      },
    ];
    const s = summarizeBySku(rows);
    expect(s.map((x) => [x.skuId, x.total])).toEqual([
      ['s2', 1],
      ['s1', 10],
    ]);
    expect(s[1]!.locations).toEqual([
      { locationId: 'l1', locationCode: 'A01-01-A01', onHand: 5 },
      { locationId: 'l2', locationCode: 'A01-02-A01', onHand: 5 },
    ]);
  });
  it('highlightIds 去重保序', () => {
    expect(highlightIds([{ locationId: 'b' }, { locationId: 'a' }, { locationId: 'b' }])).toEqual([
      'b',
      'a',
    ]);
  });
});

describe('冲正可用性（前端提示，服务端为准）', () => {
  it.each([
    [{ type: 'REVERSAL', reversedByTxnId: null }, 'ADMIN', '冲正单不可再冲正'],
    [{ type: 'INBOUND', reversedByTxnId: 'x' }, 'ADMIN', '该交易已冲正'],
    [{ type: 'COUNT_ADJUST', reversedByTxnId: null }, 'OPERATOR', '盘点调整仅主管可冲正'],
    [{ type: 'COUNT_ADJUST', reversedByTxnId: null }, 'MANAGER', null],
    [{ type: 'INBOUND', reversedByTxnId: null }, 'VIEWER', '只读用户不能冲正'],
    [{ type: 'OUTBOUND', reversedByTxnId: null }, 'OPERATOR', null],
  ])('%o by %s', (t, role, out) => expect(reversalBlockedReason(t, role)).toBe(out));
});
