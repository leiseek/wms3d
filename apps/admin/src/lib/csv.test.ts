import { describe, expect, it } from 'vitest';
import { SKU_CSV_COLUMNS } from '@wms3d/contracts';
import {
  csvCell,
  errorReportCsv,
  mergeRowErrors,
  parseCsv,
  previewSkuCsv,
  SKU_CSV_TEMPLATE,
  toCsv,
} from './csv';

const H = SKU_CSV_COLUMNS.join(',');

describe('parseCsv', () => {
  it('引号、转义、引号内换行、CRLF、BOM', () => {
    const t = '\uFEFFa,b,c\r\n"x,1","he said ""hi""","line1\nline2"\r\n\r\n4,5,6';
    expect(parseCsv(t)).toEqual([
      ['a', 'b', 'c'],
      ['x,1', 'he said "hi"', 'line1\nline2'],
      ['4', '5', '6'],
    ]);
  });
  it('末尾空单元格', () => {
    expect(parseCsv('a,b,\n1,,')).toEqual([
      ['a', 'b', ''],
      ['1', '', ''],
    ]);
  });
  it('与 toCsv 往返', () => {
    const rows = [
      ['code', 'name'],
      ['A-1', '含,逗号 "引号"\n换行'],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('csvCell 防公式注入', () => {
  it.each([
    ['=SUM(A1)', "'=SUM(A1)"],
    ['+1', "'+1"],
    ['@x', "'@x"],
    ['-5', '-5'],
    ['-x', "'-x"],
    [null, ''],
    [12, '12'],
  ])('%s', (input, out) => expect(csvCell(input)).toBe(out));
});

describe('previewSkuCsv', () => {
  it('模板本身无错误', () => {
    const p = previewSkuCsv(SKU_CSV_TEMPLATE);
    expect(p.errors).toEqual([]);
    expect(p.skuCount).toBe(1);
  });
  it('缺必需列', () => {
    const p = previewSkuCsv('code,spec\nA,1');
    expect(p.errors[0]).toMatchObject({ row: 0, code: 'REQUIRED' });
  });
  it('未知列', () => {
    expect(previewSkuCsv('code,name,colour\nA,B,red').errors[0]).toMatchObject({
      row: 0,
      code: 'FORMAT',
    });
  });
  it('逐行：必填、格式、文件内条码冲突/重复、同 SKU 名称不一致', () => {
    const csv = [
      H,
      'S-1,商品1,,EA,111,1,0,,,,', // ok
      'S-1,商品1,,EA,222,6,0,,,,', // 同 SKU 第二条码 ok
      ',无编码,,EA,,,,,,,', // REQUIRED code
      'S 2,空格,,EA,,,,,,,', // FORMAT code
      'S-3,,,EA,,,,,,,', // REQUIRED name
      'S-4,商品4,,EA,111,1,0,,,,', // BARCODE_CONFLICT (111 → S-1)
      'S-1,商品1,,EA,222,6,0,,,,', // DUPLICATE barcode
      'S-5,商品5,,EA,,0,-1,1.5,,,', // FORMAT pack_qty / safety_stock / length
      'S-1,另一个名字,,EA,,,,,,,', // DUPLICATE name mismatch
      'S-6,短行', // FORMAT 列数
    ].join('\n');
    const p = previewSkuCsv(csv);
    const by = (row: number) =>
      p.errors.filter((e) => e.row === row).map((e) => `${e.column}:${e.code}`);
    expect(by(1)).toEqual([]);
    expect(by(2)).toEqual([]);
    expect(by(3)).toEqual(['code:REQUIRED']);
    expect(by(4)).toEqual(['code:FORMAT']);
    expect(by(5)).toEqual(['name:REQUIRED']);
    expect(by(6)).toEqual(['barcode:BARCODE_CONFLICT']);
    expect(by(7)).toEqual(['barcode:DUPLICATE']);
    expect(by(8)).toEqual(['pack_qty:FORMAT', 'safety_stock:FORMAT', 'length_mm:FORMAT']);
    expect(by(9)).toEqual(['name:DUPLICATE']);
    expect(by(10)).toEqual(['null:FORMAT']);
    expect(p.rows).toHaveLength(10);
  });
  it('行数上限', () => {
    const csv = [H, 'A,a', 'B,b', 'C,c'].join('\n');
    const p = previewSkuCsv(csv, 2);
    expect(p.rows).toHaveLength(2);
    expect(p.errors.some((e) => e.row === 0 && e.message.includes('2 行上限'))).toBe(true);
  });
});

describe('错误合并与报告', () => {
  it('合并去重并按行排序', () => {
    const local = [
      { row: 3, column: 'code', code: 'REQUIRED' as const, message: 'm', source: 'local' as const },
    ];
    const server = [
      { row: 2, column: 'barcode', code: 'BARCODE_CONFLICT' as const, message: '已被 X 使用' },
      { row: 4, column: 'code', code: 'REQUIRED' as const, message: '缺少 code' },
    ];
    const m = mergeRowErrors(local, server);
    expect(m.map((e) => [e.row, e.column, e.source])).toEqual([
      [1, 'barcode', 'server'],
      [3, 'code', 'local'],
    ]);
  });
  it('报告带原始行', () => {
    const p = previewSkuCsv([H, ',缺编码,,EA,,,,,,,'].join('\n'));
    const report = parseCsv(errorReportCsv(p.errors, p.rows));
    expect(report[0]!.slice(0, 5)).toEqual(['row', 'column', 'error', 'message', 'source']);
    expect(report[1]!.slice(0, 3)).toEqual(['1', 'code', 'REQUIRED']);
    expect(report[1]![6]).toBe('缺编码');
  });
});
