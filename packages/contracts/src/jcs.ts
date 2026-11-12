import { TXN_HASH_EXCLUDED_FIELDS } from './inventory.ts';

/**
 * RFC 8785 JSON Canonicalization Scheme（03 §4.1）。
 * ES 的 JSON.stringify 对 string / 有限 number 的输出与 JCS 一致；这里只负责按 UTF-16 码元排序键并去掉 undefined。
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JCS: 不支持 NaN/Infinity');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  throw new TypeError(`JCS: 不支持的类型 ${typeof value}`);
}

/** 去掉传输层字段（顶层）后的规范化字符串。服务端对**解析前的原始请求体**计算。 */
export function txnHashInput(rawBody: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...rawBody };
  for (const f of TXN_HASH_EXCLUDED_FIELDS) delete copy[f];
  return canonicalize(copy);
}

/** sha256(hex) of txnHashInput —— 用 WebCrypto，Node 24 与浏览器通用。 */
export async function requestHash(rawBody: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(txnHashInput(rawBody));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
