import type { ScanKind } from '@wms3d/contracts';
import { splitPayload } from '../core/coding.ts';

/** 分类上下文：服务端由登记表/数据库实现，移动端由本地缓存实现。查找函数都是精确匹配。 */
export interface ClassifyContext {
  warehouseCode: string;
  /** 已知仓库代码（判断 WRONG_WAREHOUSE） */
  knownWarehouseCodes: ReadonlySet<string>;
  /** barcode_registry / 本地缓存：整串精确匹配（载荷、SKU 条码） */
  lookupRegistry(
    value: string,
  ): { kind: 'SKU' | 'LOCATION' | 'RACK'; warehouseCode: string | null; entityId: string } | null;
  /** 当前仓库裸编码匹配 */
  lookupLocationCode(code: string): string | null;
  lookupRackCode(code: string): string | null;
}

export interface ClassifyResult {
  kind: ScanKind;
  entityId?: string;
  otherWarehouseCode?: string;
  /** 规范化后的文本（trim、去 CR/LF/TAB） */
  text: string;
}

/**
 * 规范化扫码文本：去 \r\n\t 与其他 C0 控制字符（GS1 的 GS=0x1D 等）、trim、去 AIM 符号标识前缀（]C1、]E0、]Q1 等）。
 * 注意：先去前缀再 trim，避免 "]C1 WH1.A01" 残留空格。
 */
export function normalizeScan(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .replace(/^\][A-Za-z][0-9]/, '')
      .trim()
  );
}

/** 02 §3.2 的分类顺序（v2.1 M-N12）。 */
export function classifyScan(raw: string, ctx: ClassifyContext): ClassifyResult {
  const text = normalizeScan(raw);
  if (!text) return { kind: 'UNKNOWN', text };
  const fromRegistry = (v: string): ClassifyResult | null => {
    const hit = ctx.lookupRegistry(v);
    if (!hit) return null;
    if (hit.kind !== 'SKU' && hit.warehouseCode && hit.warehouseCode !== ctx.warehouseCode)
      return { kind: 'WRONG_WAREHOUSE', otherWarehouseCode: hit.warehouseCode, text };
    return { kind: hit.kind, entityId: hit.entityId, text };
  };
  // 1. 整串原文精确匹配
  const r1 = fromRegistry(text);
  if (r1) return r1;
  // 2. 大写后精确匹配
  const up = text.toUpperCase();
  if (up !== text) {
    const r2 = fromRegistry(up);
    if (r2) return r2;
  }
  // 3. 前缀
  const sp = splitPayload(up);
  if (sp) {
    if (ctx.knownWarehouseCodes.has(sp.warehouseCode) && sp.warehouseCode !== ctx.warehouseCode)
      return { kind: 'WRONG_WAREHOUSE', otherWarehouseCode: sp.warehouseCode, text };
    if (sp.warehouseCode === ctx.warehouseCode) {
      const loc = ctx.lookupLocationCode(sp.code);
      if (loc) return { kind: 'LOCATION', entityId: loc, text };
      const rack = ctx.lookupRackCode(sp.code);
      if (rack) return { kind: 'RACK', entityId: rack, text };
      return { kind: 'UNKNOWN', text };
    }
  }
  // 4. 裸编码
  const loc = ctx.lookupLocationCode(up);
  if (loc) return { kind: 'LOCATION', entityId: loc, text };
  const rack = ctx.lookupRackCode(up);
  if (rack) return { kind: 'RACK', entityId: rack, text };
  return { kind: 'UNKNOWN', text };
}

/**
 * 服务端/缓存预取（WS-A1）：classifyScan 的查找都是精确匹配，这里给出它可能查询的全部键，
 * 调用方一次批量取回后用同步 Map 构造 ClassifyContext（避免逐步串行查询）。
 */
export function scanLookupKeys(raw: string): { registry: string[]; codes: string[] } {
  const text = normalizeScan(raw);
  if (!text) return { registry: [], codes: [] };
  const up = text.toUpperCase();
  const registry = up === text ? [text] : [text, up];
  const codes = [up];
  const sp = splitPayload(up);
  if (sp) codes.push(sp.code);
  return { registry, codes: [...new Set(codes)] };
}
