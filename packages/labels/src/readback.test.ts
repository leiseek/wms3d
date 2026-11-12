import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { renderCalibrationPdf, renderLabelsPdf, xDimension, type LabelItem } from './index.ts';

const require = createRequire(import.meta.url);

const LOC: LabelItem = {
  kind: 'LOCATION',
  code: 'A03-17-C02',
  payload: 'WH1.A03-17-C02',
  subtitle: '一号仓库',
};
const BARE: LabelItem = {
  kind: 'LOCATION',
  code: 'A03-17-C02',
  payload: 'A03-17-C02',
};
const RACK: LabelItem = {
  kind: 'RACK',
  code: 'RA03-L02',
  payload: 'WH1.RA03-L02',
  subtitle: '一号仓库',
};
const SKU128: LabelItem = {
  kind: 'SKU',
  code: 'SKU-DEMO-01',
  payload: 'SKU-DEMO-01',
  title: '蓝色周转箱 600×400',
};
const SKU_EAN: LabelItem = {
  kind: 'SKU',
  code: '5901234123457',
  payload: '5901234123457',
  title: 'EAN demo',
};

const TEMPLATES = [
  { template: 'loc-100x50' as const, items: [LOC], expectQr: true, payload: LOC.payload },
  { template: 'loc-60x40' as const, items: [LOC], expectQr: false, payload: LOC.payload },
  { template: 'loc-70x30' as const, items: [LOC], expectQr: false, payload: LOC.payload },
  {
    template: 'loc-70x30' as const,
    items: [BARE],
    expectQr: false,
    payload: BARE.payload,
    name: 'loc-70x30-bare',
  },
  {
    template: 'rack-100x150' as const,
    items: [RACK],
    expectQr: true,
    minHits: 1,
    payload: RACK.payload,
  },
  { template: 'a4-3x8' as const, items: [LOC], expectQr: false, payload: LOC.payload },
  { template: 'a4-2x7' as const, items: [LOC], expectQr: true, payload: LOC.payload },
  { template: 'sku-60x40' as const, items: [SKU128], expectQr: false, payload: SKU128.payload },
  {
    template: 'sku-60x40' as const,
    items: [SKU_EAN],
    expectQr: false,
    payload: SKU_EAN.payload,
    name: 'sku-60x40-ean13',
  },
];

describe('回读：PDF → pdftoppm 300dpi → zxing-wasm', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    await prepareZXingModule({
      overrides: { wasmBinary: readFileSync(wasmPath) },
      fireImmediately: true,
    });
  });

  afterAll(() => {
    // no-op：wasm 模块常驻测试进程
  });

  for (const dpi of [203, 300] as const) {
    for (const c of TEMPLATES) {
      const title = `${c.name ?? c.template} @${dpi}dpi 解码等于载荷`;
      it(title, async () => {
        const pdf = await renderLabelsPdf({ template: c.template, dpi, items: c.items });
        const texts = await decodePdf(pdf, 300);
        expect(texts, `decoded=${JSON.stringify(texts)}`).toContain(c.payload);
        const hits = texts.filter((t) => t === c.payload);
        expect(hits.length).toBeGreaterThanOrEqual(c.minHits ?? (c.expectQr ? 2 : 1));
      });
    }
  }

  it('最长默认模式编码 + 多联 A4 整页 24 张均可回读', async () => {
    const items: LabelItem[] = [];
    for (let i = 0; i < 24; i++) {
      // 变化载荷防止碰撞误判，同时保持合法长度 10
      const aisle = String((i % 99) + 1).padStart(2, '0');
      const c = `Z${aisle}-30-Z04`;
      items.push({ kind: 'LOCATION', code: c, payload: `WH1.${c}` });
    }
    const pdf = await renderLabelsPdf({ template: 'a4-3x8', dpi: 203, items });
    const texts = await decodePdf(pdf, 300);
    for (const it of items) {
      expect(texts).toContain(it.payload);
    }
  });

  it('校准页含可解码测试条码', async () => {
    const pdf = await renderCalibrationPdf({ template: 'loc-100x50', dpi: 203 });
    const texts = await decodePdf(pdf, 300);
    expect(texts).toContain('WH1.A03-17-C02');
  });

  it('模块宽度与取整后的 X 维一致（loc-60x40 @203，体宽 = 189 模块 × X）', async () => {
    const pdf = await renderLabelsPdf({ template: 'loc-60x40', dpi: 203, items: [LOC] });
    const { width, height, pixels } = rasterPgm(pdf, 203);
    const x = xDimension('loc-60x40', 203);
    expect(x.dots).toBe(2);
    const mmPerPx = 25.4 / 203;
    const y0 = Math.floor(height * 0.55);
    const y1 = Math.floor(height * 0.95);
    let best = 0;
    for (let y = y0; y < y1; y++) {
      let minx = width,
        maxx = 0;
      const row = pixels.subarray(y * width, y * width + width);
      for (let i = 0; i < width; i++) {
        if (row[i]! < 128) {
          if (i < minx) minx = i;
          if (i > maxx) maxx = i;
        }
      }
      if (maxx > minx) best = Math.max(best, maxx - minx + 1);
    }
    expect(best).toBeGreaterThan(20);
    const inkMm = best * mmPerPx;
    const expectedMm = 189 * x.mm; // Code128 主体，不含静区
    expect(
      Math.abs(inkMm - expectedMm),
      `ink=${inkMm.toFixed(3)}mm expected=${expectedMm.toFixed(3)}mm`,
    ).toBeLessThan(0.4);
  });
});

async function decodePdf(pdf: Uint8Array, dpi: number): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'wms-labels-rb-'));
  const pdfPath = join(dir, 'in.pdf');
  writeFileSync(pdfPath, pdf);
  execFileSync('/usr/bin/pdftoppm', ['-png', '-r', String(dpi), pdfPath, join(dir, 'page')], {
    stdio: 'pipe',
  });
  const pages = readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
  const texts: string[] = [];
  for (const p of pages) {
    const buf = readFileSync(p);
    const results = await readBarcodes(buf, {
      tryHarder: true,
      tryRotate: false,
      formats: ['Code128', 'QRCode', 'EAN13'],
      maxNumberOfSymbols: 64,
    });
    for (const r of results) {
      if (r.isValid && r.text) texts.push(r.text);
    }
  }
  return texts;
}

function rasterPgm(
  pdf: Uint8Array,
  dpi: number,
): { width: number; height: number; pixels: Uint8Array } {
  const dir = mkdtempSync(join(tmpdir(), 'wms-labels-pgm-'));
  const pdfPath = join(dir, 'in.pdf');
  writeFileSync(pdfPath, pdf);
  execFileSync('/usr/bin/pdftoppm', ['-mono', '-r', String(dpi), pdfPath, join(dir, 'page')], {
    stdio: 'pipe',
  });
  const file = readdirSync(dir)
    .filter((f) => f.endsWith('.pbm') || f.endsWith('.pgm'))
    .sort()[0];
  if (!file) throw new Error('pdftoppm 未生成 pbm/pgm');
  const buf = readFileSync(join(dir, file));
  return file.endsWith('.pbm') ? parsePbm(buf) : parsePgm(buf);
}

function parsePgm(buf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  if (buf.subarray(0, 2).toString() !== 'P5') throw new Error('not P5 pgm');
  let i = 2;
  const nextTok = (): string => {
    while (i < buf.length) {
      if (buf[i] === 35 /* # */) {
        while (i < buf.length && buf[i] !== 10) i++;
        continue;
      }
      if (buf[i]! <= 32) {
        i++;
        continue;
      }
      const s = i;
      while (i < buf.length && buf[i]! > 32) i++;
      return buf.subarray(s, i).toString('ascii');
    }
    throw new Error('truncated pgm header');
  };
  const width = Number(nextTok());
  const height = Number(nextTok());
  const maxval = Number(nextTok());
  if (buf[i] === 10 || buf[i] === 13) i++;
  if (maxval !== 255) throw new Error(`unsupported maxval ${maxval}`);
  return { width, height, pixels: buf.subarray(i, i + width * height) };
}

function parsePbm(buf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  if (buf.subarray(0, 2).toString() !== 'P4') throw new Error('not P4 pbm');
  let i = 2;
  const nextTok = (): string => {
    while (i < buf.length) {
      if (buf[i] === 35) {
        while (i < buf.length && buf[i] !== 10) i++;
        continue;
      }
      if (buf[i]! <= 32) {
        i++;
        continue;
      }
      const s = i;
      while (i < buf.length && buf[i]! > 32) i++;
      return buf.subarray(s, i).toString('ascii');
    }
    throw new Error('truncated pbm header');
  };
  const width = Number(nextTok());
  const height = Number(nextTok());
  if (buf[i] === 10 || buf[i] === 13) i++;
  const rowBytes = Math.ceil(width / 8);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = buf[i + y * rowBytes + (x >> 3)]!;
      const bit = (byte >> (7 - (x & 7))) & 1;
      pixels[y * width + x] = bit ? 0 : 255; // PBM 1 = black
    }
  }
  return { width, height, pixels };
}
