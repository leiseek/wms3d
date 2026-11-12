import { describe, expect, it } from 'vitest';
import { LabelRenderRequest, type LabelTemplate } from '@wms3d/contracts';
import {
  buildRenderBody,
  clampOffset,
  loadOffset,
  perSheet,
  pickTemplate,
  saveOffset,
  templatesFor,
} from './labels';

const T = (key: string, kinds: LabelTemplate['kinds'], sheet: LabelTemplate['sheet'] = null) =>
  ({
    key,
    name: key,
    kinds,
    widthMm: 100,
    heightMm: 50,
    sheet,
    maxModules: null,
    supportsBarePayload: false,
  }) as LabelTemplate;
const ALL = [
  T('loc-100x50', ['LOCATION']),
  T('rack-100x150', ['RACK']),
  T('a4-3x8', ['LOCATION', 'SKU'], { cols: 3, rows: 8 }),
  T('a4-2x7', ['LOCATION', 'RACK', 'SKU'], { cols: 2, rows: 7 }),
  T('sku-60x40', ['SKU']),
];
const WH = '49564ebf-ce9c-8b5e-acee-3395023ab684';
const ID = '2a5bceca-226b-8123-900b-c39467802945';

describe('模板过滤（货架码不能印到仓位模板）', () => {
  it('按对象类型过滤', () => {
    expect(templatesFor(ALL, 'RACK').map((t) => t.key)).toEqual(['rack-100x150', 'a4-2x7']);
    expect(templatesFor(ALL, 'SKU').map((t) => t.key)).toEqual(['a4-3x8', 'a4-2x7', 'sku-60x40']);
  });
  it('切换类型时不兼容的模板被替换', () => {
    expect(pickTemplate(ALL, 'RACK', 'loc-100x50')).toBe('rack-100x150');
    expect(pickTemplate(ALL, 'RACK', 'a4-2x7')).toBe('a4-2x7');
    expect(pickTemplate([], 'RACK', null)).toBeNull();
  });
  it('每页张数', () => {
    expect(perSheet(ALL[2]!)).toBe(24);
    expect(perSheet(ALL[0]!)).toBe(1);
  });
});

describe('render 请求体', () => {
  const base = {
    template: 'loc-100x50' as const,
    kind: 'LOCATION' as const,
    warehouseId: WH,
    ids: [ID],
    dpi: 203 as const,
    offset: { x: 0, y: 0 },
    isSheet: false,
  };
  it('最小请求通过契约校验', () => {
    const b = buildRenderBody(base);
    expect(b).toEqual({
      template: 'loc-100x50',
      kind: 'LOCATION',
      warehouseId: WH,
      ids: [ID],
      format: 'PDF',
      dpi: 203,
    });
    expect(LabelRenderRequest.safeParse(b).success).toBe(true);
  });
  it('A4 起始格、偏移、补打 id', () => {
    const b = buildRenderBody({
      ...base,
      template: 'a4-3x8',
      isSheet: true,
      startCell: 5,
      offset: { x: 1.26, y: -20 },
      reprintRequestIds: [ID],
    });
    expect(b).toMatchObject({
      startCell: 5,
      offsetMm: { x: 1.3, y: -10 },
      reprintRequestIds: [ID],
    });
    expect(LabelRenderRequest.safeParse(b).success).toBe(true);
  });
  it('热敏模板忽略起始格；SKU 标签也带仓库（v1.2）', () => {
    expect(buildRenderBody({ ...base, startCell: 5 })).not.toHaveProperty('startCell');
    const sku = buildRenderBody({ ...base, kind: 'SKU', template: 'sku-60x40' });
    expect(sku.warehouseId).toBe(WH);
    expect(LabelRenderRequest.safeParse(sku).success).toBe(true);
  });
  it('空选择与超过 5000 张报错', () => {
    expect(() => buildRenderBody({ ...base, ids: [] })).toThrow('请先选择');
    expect(() => buildRenderBody({ ...base, ids: Array(5001).fill(ID) })).toThrow('5000');
  });
});

describe('偏移偏好', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };
  it('按模板保存/读取并夹到 ±10mm', () => {
    const s = mem();
    saveOffset('a4-3x8', { x: 12, y: -0.44 }, s);
    expect(loadOffset('a4-3x8', s)).toEqual({ x: 10, y: -0.4 });
    expect(loadOffset('loc-100x50', s)).toEqual({ x: 0, y: 0 });
  });
  it('损坏数据回退为 0', () => {
    const s = mem();
    s.setItem('wms3d.labelOffsets', '{oops');
    expect(loadOffset('x', s)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: Number.NaN, y: 3 })).toEqual({ x: 0, y: 3 });
  });
});
