import bwipjs from 'bwip-js/node';
import type { LabelTemplateKey } from '@wms3d/contracts';

export const CODE128_QUIET_MODULES = 10;
export const EAN13_QUIET_LEFT = 11;
export const EAN13_QUIET_RIGHT = 7;

interface LinearRaw {
  sbs: number[];
  bhs?: number[];
  bbs?: number[];
}

function asLinear(raw: unknown): LinearRaw {
  if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== 'object' || raw[0] == null) {
    throw new Error('bwip-js raw 未返回线性条码数据');
  }
  const row = raw[0] as LinearRaw;
  if (!Array.isArray(row.sbs)) throw new Error('bwip-js raw 缺少 sbs');
  return row;
}

const rawCache = new Map<string, unknown>();
function cachedRaw(bcid: string, text: string): unknown {
  const k = `${bcid}\0${text}`;
  let v = rawCache.get(k);
  if (v === undefined) {
    v = bwipjs.raw({ bcid, text });
    rawCache.set(k, v);
  }
  return v;
}

/** Code128 模块数（默认含左右各 10X 静区）。 */
export function countCode128Modules(payload: string, includeQuiet = true): number {
  const { sbs } = asLinear(cachedRaw('code128', payload));
  const body = sbs.reduce((a, b) => a + b, 0);
  return includeQuiet ? body + 2 * CODE128_QUIET_MODULES : body;
}

/** EAN-13 模块数（含左 11X、右 7X 静区）。 */
export function countEan13Modules(payload: string, includeQuiet = true): number {
  const { sbs } = asLinear(cachedRaw('ean13', payload));
  const body = sbs.reduce((a, b) => a + b, 0);
  return includeQuiet ? body + EAN13_QUIET_LEFT + EAN13_QUIET_RIGHT : body;
}

export function isValidEan13(text: string): boolean {
  if (!/^\d{13}$/.test(text)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = text.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === text.charCodeAt(12) - 48;
}

/** SKU：合法 EAN-13 用 EAN，否则 Code128。 */
export function skuSymbology(payload: string): 'ean13' | 'code128' {
  return isValidEan13(payload) ? 'ean13' : 'code128';
}

export function countPayloadModules(template: LabelTemplateKey, payload: string): number {
  if (template === 'sku-60x40' && isValidEan13(payload)) return countEan13Modules(payload);
  if (template === 'rack-100x150') return 0;
  return countCode128Modules(payload);
}

export function linearRaw(bcid: 'code128' | 'ean13', text: string): LinearRaw {
  return asLinear(cachedRaw(bcid, text));
}

export interface QrRaw {
  pixs: number[];
  pixx: number;
  pixy: number;
}

export function qrRaw(text: string): QrRaw {
  const raw = cachedRaw('qrcode', text) as QrRaw[];
  const row = raw[0];
  if (!row || !Array.isArray(row.pixs)) throw new Error('bwip-js raw 未返回 QR 数据');
  return row;
}
