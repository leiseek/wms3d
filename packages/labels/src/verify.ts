/**
 * 标签回读核对（M4.5）：PDF → pdftoppm 栅格化 → zxing-wasm 解码，对照期望载荷。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

const require = createRequire(import.meta.url);
let zxingReady: Promise<void> | null = null;

export async function ensureZXing(): Promise<void> {
  if (!zxingReady) {
    const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    zxingReady = prepareZXingModule({
      overrides: { wasmBinary: readFileSync(wasmPath) },
      fireImmediately: true,
    }).then(() => undefined);
  }
  await zxingReady;
}

/** 把 PDF 栅格成 PNG 页并解码全部条码文本（出现顺序）。 */
export async function decodePdf(pdf: Uint8Array, dpi = 300): Promise<string[]> {
  await ensureZXing();
  const dir = mkdtempSync(join(tmpdir(), 'wms-labels-rb-'));
  try {
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
      const results = await readBarcodes(readFileSync(p), {
        tryHarder: true,
        tryRotate: false,
        formats: ['Code128', 'QRCode', 'EAN13'],
        maxNumberOfSymbols: 64,
      });
      for (const r of results) if (r.isValid && r.text) texts.push(r.text);
    }
    return texts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface LabelVerifyHit {
  expected: string;
  actual: string | null;
  pass: boolean;
  code?: string;
}

export interface LabelVerifyOutcome {
  passed: number;
  failed: number;
  items: LabelVerifyHit[];
  decoded: string[];
}

/** 用多重集合消耗解码结果，对照每张标签的期望载荷。 */
export function matchDecoded(
  expected: Array<{ payload: string; code?: string }>,
  decoded: string[],
): LabelVerifyOutcome {
  const bag = new Map<string, number>();
  for (const t of decoded) bag.set(t, (bag.get(t) ?? 0) + 1);
  const items: LabelVerifyHit[] = expected.map((e) => {
    const n = bag.get(e.payload) ?? 0;
    if (n > 0) {
      bag.set(e.payload, n - 1);
      return { expected: e.payload, actual: e.payload, pass: true, code: e.code };
    }
    return { expected: e.payload, actual: null, pass: false, code: e.code };
  });
  const passed = items.filter((i) => i.pass).length;
  return { passed, failed: items.length - passed, items, decoded };
}

export async function verifyLabelPdf(
  pdf: Uint8Array,
  expected: Array<{ payload: string; code?: string }>,
  dpi = 300,
): Promise<LabelVerifyOutcome> {
  const decoded = await decodePdf(pdf, dpi);
  return matchDecoded(expected, decoded);
}
