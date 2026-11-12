/**
 * 本地 shim（WS-A1，待 WS-E 的 @wms3d/labels 合并后删除并改为 `import … from '@wms3d/labels'`）。
 * 接口与 docs/workstreams/ws-e.md §1 一致：labelTemplates / renderLabelsPdf / renderCalibrationPdf / checkCapacity。
 * 渲染为极简文字 PDF（无条码图形），仅用于联调；容量按 Code128-B 上界估算。
 */
import type { LabelTemplate as LabelTemplateSchema, LabelTemplateKey } from '@wms3d/contracts';
import type { z } from 'zod';

type LabelTemplate = z.infer<typeof LabelTemplateSchema>;

export interface LabelItem {
  kind: 'LOCATION' | 'RACK' | 'SKU';
  code: string;
  payload: string;
  title?: string;
  subtitle?: string;
}

export const labelTemplates: LabelTemplate[] = [
  {
    key: 'loc-100x50',
    name: '仓位 100×50',
    kinds: ['LOCATION'],
    widthMm: 100,
    heightMm: 50,
    sheet: null,
    maxModules: { dpi203: 253, dpi300: 281 },
    supportsBarePayload: true,
  },
  {
    key: 'loc-60x40',
    name: '仓位 60×40（层板架）',
    kinds: ['LOCATION'],
    widthMm: 60,
    heightMm: 40,
    sheet: null,
    maxModules: { dpi203: 230, dpi300: 230 },
    supportsBarePayload: true,
  },
  {
    key: 'loc-70x30',
    name: '横梁窄标 70×30',
    kinds: ['LOCATION'],
    widthMm: 70,
    heightMm: 30,
    sheet: null,
    maxModules: { dpi203: 264, dpi300: 259 },
    supportsBarePayload: true,
  },
  {
    key: 'rack-100x150',
    name: '货架端头 100×150',
    kinds: ['RACK'],
    widthMm: 100,
    heightMm: 150,
    sheet: null,
    maxModules: null,
    supportsBarePayload: false,
  },
  {
    key: 'a4-3x8',
    name: 'A4 3×8（70×37）',
    kinds: ['LOCATION', 'SKU'],
    widthMm: 70,
    heightMm: 37,
    sheet: { cols: 3, rows: 8 },
    maxModules: { dpi203: 270, dpi300: 270 },
    supportsBarePayload: true,
  },
  {
    key: 'a4-2x7',
    name: 'A4 2×7（99×38）',
    kinds: ['LOCATION', 'RACK', 'SKU'],
    widthMm: 99,
    heightMm: 38,
    sheet: { cols: 2, rows: 7 },
    maxModules: { dpi203: 290, dpi300: 290 },
    supportsBarePayload: true,
  },
  {
    key: 'sku-60x40',
    name: 'SKU 60×40',
    kinds: ['SKU'],
    widthMm: 60,
    heightMm: 40,
    sheet: null,
    maxModules: { dpi203: 230, dpi300: 230 },
    supportsBarePayload: true,
  },
];

const tpl = (k: LabelTemplateKey) => labelTemplates.find((t) => t.key === k)!;

/** Code128-B 上界：(起始 + 数据 + 校验) × 11 + 终止 13 + 静区 2×10。 */
export function checkCapacity(
  template: LabelTemplateKey,
  payload: string,
  dpi: 203 | 300,
): { ok: boolean; modules: number; max: number | null } {
  const modules = 11 * (payload.length + 2) + 13 + 20;
  const mm = tpl(template).maxModules;
  const max = mm ? (dpi === 300 ? mm.dpi300 : mm.dpi203) : null;
  return { ok: max === null || modules <= max, modules, max };
}

const MM = 72 / 25.4;
const esc = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (m) => `\\${m}`);

function text(x: number, y: number, size: number, s: string): string {
  return `BT /F1 ${size.toFixed(1)} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(s)}) Tj ET\n`;
}

function buildPdf(pages: { w: number; h: number; content: string }[]): Uint8Array {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const kids: string[] = [];
  let n = 4;
  for (const p of pages) {
    const pageId = n++;
    const contentId = n++;
    kids.push(`${pageId} 0 R`);
    objs[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objs[contentId] =
      `<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}endstream`;
  }
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  for (let i = 1; i < n; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${n}\n0000000000 65535 f \n`;
  for (let i = 1; i < n; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

function cell(t: LabelTemplate, it: LabelItem, ox: number, oy: number): string {
  const w = t.widthMm * MM;
  const h = t.heightMm * MM;
  const big = Math.min(h * 0.3, (w * 1.6) / Math.max(4, it.code.length));
  return (
    `0.5 w ${ox.toFixed(2)} ${oy.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S\n` +
    text(ox + 3 * MM, oy + h - big - 3 * MM, big, it.code) +
    text(ox + 3 * MM, oy + 4 * MM, 7, it.payload) +
    (it.title ? text(ox + 3 * MM, oy + 9 * MM, 7, it.title) : '')
  );
}

export async function renderLabelsPdf(input: {
  template: LabelTemplateKey;
  dpi: 203 | 300;
  startCell?: number;
  offsetMm?: { x: number; y: number };
  items: LabelItem[];
}): Promise<Uint8Array> {
  const t = tpl(input.template);
  const dx = (input.offsetMm?.x ?? 0) * MM;
  const dy = (input.offsetMm?.y ?? 0) * MM;
  const pages: { w: number; h: number; content: string }[] = [];
  if (!t.sheet) {
    for (const it of input.items)
      pages.push({ w: t.widthMm * MM, h: t.heightMm * MM, content: cell(t, it, dx, dy) });
  } else {
    const per = t.sheet.cols * t.sheet.rows;
    const W = 210 * MM;
    const H = 297 * MM;
    const mx = (W - t.sheet.cols * t.widthMm * MM) / 2;
    const my = (H - t.sheet.rows * t.heightMm * MM) / 2;
    let slot = Math.max(0, (input.startCell ?? 1) - 1) % per;
    let content = '';
    for (const it of input.items) {
      const col = slot % t.sheet.cols;
      const row = Math.floor(slot / t.sheet.cols);
      content += cell(
        t,
        it,
        mx + col * t.widthMm * MM + dx,
        H - my - (row + 1) * t.heightMm * MM + dy,
      );
      slot++;
      if (slot === per) {
        pages.push({ w: W, h: H, content });
        content = '';
        slot = 0;
      }
    }
    if (content) pages.push({ w: W, h: H, content });
  }
  if (!pages.length) pages.push({ w: t.widthMm * MM, h: t.heightMm * MM, content: '' });
  return buildPdf(pages);
}

export async function renderCalibrationPdf(input: {
  template: LabelTemplateKey;
  dpi: 203 | 300;
}): Promise<Uint8Array> {
  const t = tpl(input.template);
  const w = t.widthMm * MM;
  const h = t.heightMm * MM;
  let c = `0.5 w 0 0 ${w.toFixed(2)} ${h.toFixed(2)} re S\n`;
  for (let mm = 0; mm <= t.widthMm; mm += 10)
    c += `${(mm * MM).toFixed(2)} 0 m ${(mm * MM).toFixed(2)} ${(4 * MM).toFixed(2)} l S\n`;
  for (let mm = 0; mm <= t.heightMm; mm += 10)
    c += `0 ${(mm * MM).toFixed(2)} m ${(4 * MM).toFixed(2)} ${(mm * MM).toFixed(2)} l S\n`;
  c += text(
    6 * MM,
    h / 2,
    8,
    `${t.key} ${t.widthMm}x${t.heightMm}mm @${input.dpi}dpi - print at 100%`,
  );
  return buildPdf([{ w, h, content: c }]);
}
