import { describe, expect, it } from 'vitest';
import { classifyScan, normalizeScan, type ClassifyContext } from './index.ts';

const reg = new Map<
  string,
  { kind: 'SKU' | 'LOCATION' | 'RACK'; warehouseCode: string | null; entityId: string }
>([
  ['WH1.A03-17-C02', { kind: 'LOCATION', warehouseCode: 'WH1', entityId: 'loc1' }],
  ['WH2.A01-01-A01', { kind: 'LOCATION', warehouseCode: 'WH2', entityId: 'loc9' }],
  ['AB1.234', { kind: 'SKU', warehouseCode: null, entityId: 'skuDot' }],
  ['6901234567892', { kind: 'SKU', warehouseCode: null, entityId: 'sku1' }],
  ['abc-lower', { kind: 'SKU', warehouseCode: null, entityId: 'skuLower' }],
]);
const ctx: ClassifyContext = {
  warehouseCode: 'WH1',
  knownWarehouseCodes: new Set(['WH1', 'WH2']),
  lookupRegistry: (v) => reg.get(v) ?? null,
  lookupLocationCode: (c) => (c === 'A03-17-C02' ? 'loc1' : null),
  lookupRackCode: (c) => (c === 'RA03-L02' ? 'rack1' : null),
};

describe('classifyScan（02 §3.2）', () => {
  it('载荷、裸编码、货架码', () => {
    expect(classifyScan('WH1.A03-17-C02', ctx)).toMatchObject({
      kind: 'LOCATION',
      entityId: 'loc1',
    });
    expect(classifyScan('A03-17-C02', ctx)).toMatchObject({ kind: 'LOCATION', entityId: 'loc1' });
    expect(classifyScan('WH1.RA03-L02', ctx)).toMatchObject({ kind: 'RACK', entityId: 'rack1' });
  });
  it('含点号的 SKU 条码不被误判为跨仓（先整串精确匹配）', () => {
    expect(classifyScan('AB1.234', ctx)).toMatchObject({ kind: 'SKU', entityId: 'skuDot' });
  });
  it('跨仓：登记表命中或已知前缀', () => {
    expect(classifyScan('WH2.A01-01-A01', ctx)).toMatchObject({
      kind: 'WRONG_WAREHOUSE',
      otherWarehouseCode: 'WH2',
    });
    expect(classifyScan('WH2.Z99-99-Z99', ctx)).toMatchObject({ kind: 'WRONG_WAREHOUSE' });
    expect(classifyScan('XX9.FOO', ctx)).toMatchObject({ kind: 'UNKNOWN' });
  });
  it('大小写：SKU 原样优先，仓位载荷兼容小写（Caps Lock）', () => {
    expect(classifyScan('abc-lower', ctx)).toMatchObject({ kind: 'SKU', entityId: 'skuLower' });
    expect(classifyScan('wh1.a03-17-c02', ctx)).toMatchObject({
      kind: 'LOCATION',
      entityId: 'loc1',
    });
  });
  it('规范化：CR/LF/TAB、AIM 前缀', () => {
    expect(normalizeScan(']C16901234567892\r\n')).toBe('6901234567892');
    expect(classifyScan('  6901234567892\t', ctx)).toMatchObject({ kind: 'SKU', entityId: 'sku1' });
    expect(classifyScan('', ctx).kind).toBe('UNKNOWN');
  });
});
