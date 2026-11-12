import { describe, expect, it } from 'vitest';
import { normalizeScan, scanLookupKeys } from './classify.ts';

describe('scanLookupKeys / normalizeScan', () => {
  it('去 GS 等控制字符与 AIM 前缀', () => {
    expect(normalizeScan(']C1 WH1.A01-01-A01\x1d\r\n')).toBe('WH1.A01-01-A01');
    expect(normalizeScan('\t\r\n')).toBe('');
  });
  it('登记表键：原文 + 大写；编码键：大写 + 拆前缀', () => {
    expect(scanLookupKeys('wh1.a01-01-a01')).toEqual({
      registry: ['wh1.a01-01-a01', 'WH1.A01-01-A01'],
      codes: ['WH1.A01-01-A01', 'A01-01-A01'],
    });
    expect(scanLookupKeys('6901234567892')).toEqual({
      registry: ['6901234567892'],
      codes: ['6901234567892'],
    });
    expect(scanLookupKeys('  ')).toEqual({ registry: [], codes: [] });
  });
});
