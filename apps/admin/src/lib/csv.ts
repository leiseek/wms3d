import { SKU_CSV_COLUMNS } from '@wms3d/contracts';

/** RFC 4180 CSV 解析（支持引号、转义引号、引号内换行、CRLF、UTF-8 BOM）。 */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // 防公式注入（=,+,-,@ 开头的文本在 Excel 中会被执行）
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export type SkuCsvColumn = (typeof SKU_CSV_COLUMNS)[number];
export type RowErrorCode = 'DUPLICATE' | 'BARCODE_CONFLICT' | 'FORMAT' | 'REQUIRED';
export interface RowError {
  /** 数据行号（1 起，不含表头），与服务端 ImportResult.errors[].row 一致 */
  row: number;
  column: string | null;
  code: RowErrorCode;
  message: string;
  source: 'local' | 'server';
}
export interface SkuCsvPreview {
  header: string[];
  rows: Record<SkuCsvColumn, string>[];
  errors: RowError[];
  skuCount: number;
}

const SKU_CODE = /^[A-Za-z0-9._\-/]{1,64}$/;
const BARCODE = /^[\x21-\x7E]{1,64}$/;
const INT_COLS: SkuCsvColumn[] = [
  'pack_qty',
  'safety_stock',
  'length_mm',
  'width_mm',
  'height_mm',
  'weight_g',
];

/**
 * 前端预检（05 §3：papaparse 风格前端预览 + 服务端权威）：表头、必填、格式、文件内重复。
 * 同一 SKU 多条码用多行：同 code 多行合法，但 (code, barcode) 重复或同一条码挂到不同 code 视为错误。
 */
export function previewSkuCsv(text: string, maxRows = 50_000): SkuCsvPreview {
  const all = parseCsv(text);
  const errors: RowError[] = [];
  const header = (all[0] ?? []).map((h) => h.trim().toLowerCase());
  const missing = ['code', 'name'].filter((c) => !header.includes(c));
  const unknown = header.filter((h) => !(SKU_CSV_COLUMNS as readonly string[]).includes(h));
  if (missing.length)
    errors.push({
      row: 0,
      column: missing.join(','),
      code: 'REQUIRED',
      message: `表头缺少必需列：${missing.join('、')}`,
      source: 'local',
    });
  if (unknown.length)
    errors.push({
      row: 0,
      column: unknown.join(','),
      code: 'FORMAT',
      message: `未知列：${unknown.join('、')}（模板列：${SKU_CSV_COLUMNS.join(',')}）`,
      source: 'local',
    });
  const body = all.slice(1);
  if (body.length > maxRows)
    errors.push({
      row: 0,
      column: null,
      code: 'FORMAT',
      message: `超过 ${maxRows} 行上限`,
      source: 'local',
    });
  const rows: Record<SkuCsvColumn, string>[] = [];
  const barcodeOwner = new Map<string, { code: string; row: number }>();
  const names = new Map<string, string>();
  body.slice(0, maxRows).forEach((cells, i) => {
    const rowNo = i + 1;
    const r = Object.fromEntries(SKU_CSV_COLUMNS.map((c) => [c, ''])) as Record<
      SkuCsvColumn,
      string
    >;
    header.forEach((h, j) => {
      if ((SKU_CSV_COLUMNS as readonly string[]).includes(h))
        r[h as SkuCsvColumn] = (cells[j] ?? '').trim();
    });
    rows.push(r);
    const err = (column: string | null, code: RowErrorCode, message: string) =>
      errors.push({ row: rowNo, column, code, message, source: 'local' });
    if (cells.length !== header.length)
      err(null, 'FORMAT', `列数 ${cells.length} 与表头 ${header.length} 不一致`);
    if (!r.code) err('code', 'REQUIRED', 'SKU 编码必填');
    else if (!SKU_CODE.test(r.code)) err('code', 'FORMAT', `SKU 编码格式不正确：${r.code}`);
    if (!r.name) err('name', 'REQUIRED', '名称必填');
    else if (r.name.length > 128) err('name', 'FORMAT', '名称超过 128 字');
    if (r.uom && r.uom.length > 8) err('uom', 'FORMAT', '单位超过 8 字');
    for (const c of INT_COLS) {
      const v = r[c];
      if (v === '') continue;
      const n = Number(v);
      const min = c === 'safety_stock' ? 0 : 1;
      if (!/^\d+$/.test(v) || !Number.isSafeInteger(n) || n < min)
        err(c, 'FORMAT', `${c} 必须是 ≥ ${min} 的整数：${v}`);
    }
    if (r.barcode) {
      if (!BARCODE.test(r.barcode)) err('barcode', 'FORMAT', `条码含非法字符：${r.barcode}`);
      else {
        const prev = barcodeOwner.get(r.barcode);
        if (prev && prev.code !== r.code)
          err(
            'barcode',
            'BARCODE_CONFLICT',
            `条码 ${r.barcode} 已在第 ${prev.row} 行分配给 ${prev.code}`,
          );
        else if (prev) err('barcode', 'DUPLICATE', `与第 ${prev.row} 行重复`);
        else barcodeOwner.set(r.barcode, { code: r.code, row: rowNo });
      }
    }
    if (r.code && r.name) {
      const n0 = names.get(r.code);
      if (n0 !== undefined && n0 !== r.name)
        err('name', 'DUPLICATE', `同一 SKU ${r.code} 的名称前后不一致`);
      else names.set(r.code, r.name);
    }
  });
  return { header, rows, errors, skuCount: names.size };
}

/** 合并前端与服务端错误，按行号排序并去重。 */
export function mergeRowErrors(local: RowError[], server: Omit<RowError, 'source'>[]): RowError[] {
  const seen = new Set<string>();
  const out: RowError[] = [];
  // 服务端/mock 行号含表头（表头=1，首行数据=2）；前端预检是数据行（首行数据=1）。
  const adj = server.map((s) => ({
    ...s,
    source: 'server' as const,
    row: s.row > 0 ? s.row - 1 : s.row,
  }));
  for (const e of [...local, ...adj]) {
    const k = `${e.row}|${e.column ?? ''}|${e.code}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => a.row - b.row);
}

/** 错误报告 CSV（可下载）：行号、列、错误码、说明、来源 + 原始行内容。 */
export function errorReportCsv(errors: RowError[], rows: Record<string, string>[]): string {
  return toCsv([
    ['row', 'column', 'error', 'message', 'source', ...SKU_CSV_COLUMNS],
    ...errors.map((e) => [
      e.row,
      e.column ?? '',
      e.code,
      e.message,
      e.source === 'local' ? '前端预检' : '服务端预检',
      ...SKU_CSV_COLUMNS.map((c) => (e.row > 0 ? (rows[e.row - 1]?.[c] ?? '') : '')),
    ]),
  ]);
}

export const SKU_CSV_TEMPLATE = toCsv([
  [...SKU_CSV_COLUMNS],
  ['SKU-0001', '示例商品', '500ml', 'EA', '6901234567892', 1, 10, 80, 80, 200, 520],
]);
