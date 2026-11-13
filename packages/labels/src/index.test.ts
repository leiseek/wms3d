import { describe, expect, it } from 'vitest';
import {
  PACKAGE_NAME,
  checkCapacity,
  countCode128Modules,
  getLabelTemplate,
  isValidEan13,
  LabelCapacityError,
  LabelKindMismatchError,
  labelTemplates,
  maxModulesFor,
  renderLabelsPdf,
  renderLabelsZpl,
  zplEscape,
  skuSymbology,
  xDimension,
  type LabelItem,
} from './index.ts';

describe('@wms3d/labels public API', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@wms3d/labels');
  });

  it('exposes all 7 LabelTemplateKey 模板，字段与契约一致', () => {
    const keys = labelTemplates.map((t) => t.key);
    expect(keys).toEqual([
      'loc-100x50',
      'loc-60x40',
      'loc-70x30',
      'rack-100x150',
      'a4-3x8',
      'a4-2x7',
      'sku-60x40',
    ]);
    for (const t of labelTemplates) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.kinds.length).toBeGreaterThan(0);
      expect(t.widthMm).toBeGreaterThan(0);
      expect(t.heightMm).toBeGreaterThan(0);
      if (t.key.startsWith('a4-')) {
        expect(t.sheet).not.toBeNull();
      } else {
        expect(t.sheet).toBeNull();
      }
    }
    expect(getLabelTemplate('loc-100x50').maxModules).toEqual({ dpi203: 253, dpi300: 281 });
  });
});

describe('容量与 X 维', () => {
  const defaultPayload = 'WH1.A03-17-C02';

  it('默认载荷 WH1.A03-17-C02 为 Code128-B 189 + 静区 20 = 209 模块', () => {
    expect(countCode128Modules(defaultPayload, false)).toBe(189);
    expect(countCode128Modules(defaultPayload, true)).toBe(209);
    expect(countCode128Modules('A03-17-C02', false)).toBe(145);
    expect(countCode128Modules('A03-17-C02', true)).toBe(165);
  });

  it('默认带前缀载荷可放入所有仓位 / A4 模板（203 与 300dpi）', () => {
    const keys = ['loc-100x50', 'loc-60x40', 'loc-70x30', 'a4-3x8', 'a4-2x7'] as const;
    for (const key of keys) {
      for (const dpi of [203, 300] as const) {
        const r = checkCapacity(key, defaultPayload, dpi);
        expect(r.ok, `${key}@${dpi} modules=${r.modules} max=${r.max}`).toBe(true);
        expect(r.modules).toBe(209);
      }
    }
    expect(checkCapacity('rack-100x150', 'WH1.RA03-L02', 203).ok).toBe(true);
  });

  it('超长载荷被 checkCapacity 拒绝，并建议更宽模板（错误信息）', () => {
    const long = `WH1.${'AB'.repeat(40)}`;
    const r = checkCapacity('loc-60x40', long, 203);
    expect(r.ok).toBe(false);
    expect(r.modules).toBeGreaterThan(r.max);
    expect(r.max).toBe(230);
  });

  it('loc-70x30 裸编码改用 0.375mm 档，上限 176@203 / 195@300', () => {
    expect(maxModulesFor('loc-70x30', 203, true)).toBe(176);
    expect(maxModulesFor('loc-70x30', 300, true)).toBe(195);
    expect(xDimension('loc-70x30', 203, true).dots).toBe(3);
    expect(xDimension('loc-70x30', 203, false).dots).toBe(2);
    const bare = checkCapacity('loc-70x30', 'A03-17-C02', 203);
    expect(bare.ok).toBe(true);
    expect(bare.modules).toBe(165);
    expect(bare.max).toBe(176);
    // 带前缀若误用 0.375 档会超容；带前缀走 0.25 档则通过
    const prefixed = checkCapacity('loc-70x30', defaultPayload, 203);
    expect(prefixed.ok).toBe(true);
    expect(prefixed.max).toBe(264);
  });

  it('X 维按 dpi 取整到整数点', () => {
    const a = xDimension('loc-100x50', 203);
    expect(a.dots).toBe(3);
    expect(a.mm).toBeCloseTo((3 * 25.4) / 203, 6);
    expect(a.pt).toBeCloseTo((3 * 72) / 203, 6);
    const b = xDimension('loc-100x50', 300);
    expect(b.dots).toBe(4);
    expect(b.mm).toBeCloseTo((4 * 25.4) / 300, 6);
  });

  it('合法 EAN-13 走 EAN，否则 Code128', () => {
    expect(isValidEan13('5901234123457')).toBe(true);
    expect(isValidEan13('5901234123450')).toBe(false);
    expect(skuSymbology('5901234123457')).toBe('ean13');
    expect(skuSymbology('SKU-DEMO-01')).toBe('code128');
  });
});

describe('PDF / ZPL 渲染（结构）', () => {
  const locItem: LabelItem = {
    kind: 'LOCATION',
    code: 'A03-17-C02',
    payload: 'WH1.A03-17-C02',
    subtitle: '一号仓库',
  };

  it('超长载荷渲染抛出 LabelCapacityError', async () => {
    const long = `WH1.${'AB'.repeat(40)}`;
    await expect(
      renderLabelsPdf({
        template: 'loc-60x40',
        dpi: 203,
        items: [{ kind: 'LOCATION', code: 'X', payload: long }],
      }),
    ).rejects.toBeInstanceOf(LabelCapacityError);
  });

  it('货架码必须用 rack-100x150，仓位模板拒绝 RACK', async () => {
    const rack: LabelItem = { kind: 'RACK', code: 'RA03-L02', payload: 'WH1.RA03-L02' };
    await expect(
      renderLabelsPdf({ template: 'loc-100x50', dpi: 203, items: [rack] }),
    ).rejects.toBeInstanceOf(LabelKindMismatchError);
    await expect(
      renderLabelsZpl({ template: 'loc-60x40', dpi: 203, items: [rack] }),
    ).rejects.toBeInstanceOf(LabelKindMismatchError);
    const pdf = await renderLabelsPdf({ template: 'rack-100x150', dpi: 203, items: [rack] });
    expect(pdf.byteLength).toBeGreaterThan(100);
  });

  it('模板 kinds 与 item.kind 必须匹配（A4 允许 LOCATION/SKU，拒绝 RACK）', async () => {
    await expect(
      renderLabelsPdf({
        template: 'a4-3x8',
        dpi: 203,
        items: [{ kind: 'RACK', code: 'RA03-L02', payload: 'WH1.RA03-L02' }],
      }),
    ).rejects.toBeInstanceOf(LabelKindMismatchError);
    await expect(
      renderLabelsPdf({
        template: 'rack-100x150',
        dpi: 203,
        items: [{ kind: 'LOCATION', code: 'A03-17-C02', payload: 'WH1.A03-17-C02' }],
      }),
    ).rejects.toBeInstanceOf(LabelKindMismatchError);
    const sku: LabelItem = {
      kind: 'SKU',
      code: 'SKU-DEMO-01',
      payload: 'SKU-DEMO-01',
      title: '示例',
    };
    const pdf = await renderLabelsPdf({ template: 'a4-3x8', dpi: 203, items: [sku] });
    expect(pdf.byteLength).toBeGreaterThan(100);
  });

  it('热敏页尺寸等于标签尺寸；A4 为 210×297mm', async () => {
    const thermal = await renderLabelsPdf({
      template: 'loc-100x50',
      dpi: 203,
      items: [locItem],
    });
    const a4 = await renderLabelsPdf({
      template: 'a4-3x8',
      dpi: 203,
      items: [locItem],
    });
    const [tw, th] = pageSizePts(thermal);
    expect(tw).toBeCloseTo(mmToPt(100), 4);
    expect(th).toBeCloseTo(mmToPt(50), 4);
    expect(pageSizePts(a4)[0]).toBeCloseTo(roundPt(210), 1);
    expect(pageSizePts(a4)[1]).toBeCloseTo(roundPt(297), 1);
  });

  it('PDF 为矢量：无图像 XObject，字体为子集且含中文', async () => {
    const pdf = await renderLabelsPdf({
      template: 'loc-100x50',
      dpi: 203,
      items: [locItem],
    });
    const s = Buffer.from(pdf).toString('latin1');
    expect(s).not.toMatch(/\/Subtype\s*\/Image/);
    expect(s).toMatch(/\/FontFile3?/);
    expect(s).toMatch(/\/BaseFont\s*\/[A-Za-z0-9]{4,}\+/);
    expect(s).toMatch(/一号仓库|NotoSans/);
  });

  it('A4 起始格与多页：startCell=24 两张应产生 2 页', async () => {
    const pdf = await renderLabelsPdf({
      template: 'a4-3x8',
      dpi: 203,
      startCell: 24,
      items: [locItem, { ...locItem, code: 'A03-18-C02', payload: 'WH1.A03-18-C02' }],
    });
    expect(countPages(pdf)).toBe(2);
  });

  it('1000 张仓位标签渲染 < 5s（预热后计时）', async () => {
    const warmup = locItems(2);
    await renderLabelsPdf({ template: 'loc-100x50', dpi: 203, items: warmup });
    const items = locItems(1000);
    const t0 = performance.now();
    const pdf = await renderLabelsPdf({ template: 'loc-100x50', dpi: 203, items });
    const ms = performance.now() - t0;
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(countPages(pdf)).toBe(1000);
    expect(ms, `took ${ms.toFixed(0)}ms`).toBeLessThan(5000);
  });

  it('实验性 ZPL 含 ^CI28 与 ASCII 载荷，省略中文', async () => {
    const zpl = await renderLabelsZpl({
      template: 'loc-100x50',
      dpi: 203,
      items: [locItem],
    });
    expect(zpl.startsWith('^XA')).toBe(true);
    expect(zpl).toContain('^CI28');
    expect(zpl).toContain('WH1.A03-17-C02');
    expect(zpl).toContain('^BC');
    expect(zpl).toContain('^BQ');
    expect(zpl).toContain('^XZ');
    expect(zpl).not.toContain('一号仓库');
  });

  it('ZPL ^FD 转义 ^ ~ _，注入指令不会提前结束标签（CR1 #9）', async () => {
    expect(zplEscape('A^XZ~JR_B')).toBe('A_5EXZ_7EJR_5FB');
    const zpl = await renderLabelsZpl({
      template: 'sku-60x40',
      dpi: 203,
      items: [{ kind: 'SKU', code: 'X', payload: 'ABC^XZ', title: 'N~JR' }],
    });
    expect(zpl).toContain('_5EXZ');
    expect(zpl).toContain('_7EJR');
    // 转义后不应再出现裸 ^FDABC^XZ（会提前结束）
    expect(zpl).not.toMatch(/\^FDABC\^XZ/);
    expect(zpl.trim().endsWith('^XZ')).toBe(true);
    expect(zpl.split('^XZ').length).toBe(2); // 仅结尾一处
  });
});

function locItems(n: number): LabelItem[] {
  const items: LabelItem[] = [];
  for (let i = 0; i < n; i++) {
    const aisle = String((i % 20) + 1).padStart(2, '0');
    const bay = String((i % 30) + 1).padStart(2, '0');
    const level = String.fromCharCode(65 + (i % 5));
    const pos = String((i % 4) + 1).padStart(2, '0');
    const code = `A${aisle}-${bay}-${level}${pos}`;
    items.push({ kind: 'LOCATION', code, payload: `WH1.${code}`, subtitle: '一号仓库' });
  }
  return items;
}

function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}
function roundPt(mm: number): number {
  return Math.round(mmToPt(mm) * 100) / 100;
}

function pdfLatin1(pdf: Uint8Array): string {
  return Buffer.from(pdf).toString('latin1');
}

/** 读取第一页 MediaBox。 */
function pageSizePts(pdf: Uint8Array): [number, number] {
  const s = pdfLatin1(pdf);
  const m = /\/MediaBox\s*\[\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\]/.exec(s);
  if (!m) throw new Error('MediaBox not found');
  return [Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])];
}

function countPages(pdf: Uint8Array): number {
  const s = pdfLatin1(pdf);
  const count = /\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/.exec(s);
  if (count) return Number(count[1]);
  return (s.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
}
