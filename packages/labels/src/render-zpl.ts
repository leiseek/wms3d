import { splitPayload } from '@wms3d/domain';
import { assertCapacity } from './capacity.ts';
import { skuSymbology } from './barcode-metrics.ts';
import { assertItemKind, getLabelTemplate, isPrefixedPayload, xDimension } from './templates.ts';
import type { LabelItem, ZplRenderInput } from './types.ts';
import { MAX_LABELS_PER_RENDER } from './types.ts';

/**
 * 实验性 ZPL（M5 / 07 §1、ADR-0006）：仅 ASCII + 条码，开头 ^CI28。
 * 中文名称省略；不直发打印机。
 */
export async function renderLabelsZpl(input: ZplRenderInput): Promise<string> {
  if (input.items.length > MAX_LABELS_PER_RENDER) {
    throw new Error(`单次最多渲染 ${MAX_LABELS_PER_RENDER} 张，收到 ${input.items.length}`);
  }
  const spec = getLabelTemplate(input.template);
  const dpi = input.dpi;
  const labels = input.items.map((item) => renderOne(spec.key, dpi, item));
  return labels.join('\n');
}

function dots(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

function asciiOnly(s: string): string {
  return s.replace(/[^\x20-\x7E]/g, '').trim();
}

/** 把 ^ ~ _ 转成 ^FH_ 十六进制，防止注入打印机指令（CR1 #9）。 */
export function zplEscape(s: string): string {
  return asciiOnly(s).replace(
    /[\^~_]/g,
    (c) => `_${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

export function zplFd(s: string): string {
  return `^FH_^FD${zplEscape(s)}`;
}

function renderOne(
  key: ReturnType<typeof getLabelTemplate>['key'],
  dpi: ZplRenderInput['dpi'],
  item: LabelItem,
): string {
  assertItemKind(key, item.kind);
  assertCapacity(key, item.payload, dpi);
  const spec = getLabelTemplate(key);
  const bare = !isPrefixedPayload(item.payload);
  const x = xDimension(key, dpi, bare);
  const pw = dots(spec.sheet ? (spec.cellMm?.width ?? 70) : spec.widthMm, dpi);
  const ll = dots(spec.sheet ? (spec.cellMm?.height ?? 37) : spec.heightMm, dpi);
  const code = asciiOnly(item.code) || 'CODE';
  const payload = asciiOnly(item.payload);
  const wh = splitPayload(item.payload)?.warehouseCode ?? '';
  const by = x.dots;
  const lines: string[] = ['^XA', '^CI28', `^PW${pw}`, `^LL${ll}`];

  if (key === 'rack-100x150') {
    lines.push(
      `^FO${dots(4, dpi)},${dots(8, dpi)}^A0N,${dots(22, dpi)},${dots(20, dpi)}${zplFd(code)}^FS`,
    );
    if (wh)
      lines.push(
        `^FO${dots(4, dpi)},${dots(32, dpi)}^A0N,${dots(5, dpi)},${dots(5, dpi)}${zplFd(wh)}^FS`,
      );
    const qr = dots(70, dpi);
    const qox = Math.max(0, Math.round((pw - qr) / 2));
    lines.push(
      `^FO${qox},${dots(42, dpi)}^BQN,2,${Math.max(2, Math.round(x.dots * 2))}^FH_^FDQA,${zplEscape(payload)}^FS`,
    );
  } else if (key === 'sku-60x40') {
    const title = asciiOnly(item.title ?? item.code);
    lines.push(
      `^FO${dots(2, dpi)},${dots(2, dpi)}^A0N,${dots(4, dpi)},${dots(4, dpi)}${zplFd(title)}^FS`,
    );
    if (skuSymbology(item.payload) === 'ean13') {
      lines.push(
        `^FO${dots(2, dpi)},${dots(40 - 2 - 15, dpi)}^BY${by}^BEN,${dots(15, dpi)},N,N${zplFd(payload.slice(0, 12))}^FS`,
      );
    } else {
      lines.push(
        `^FO${dots(2, dpi)},${dots(40 - 2 - 15, dpi)}^BY${by}^BCN,${dots(15, dpi)},N,N,N${zplFd(payload)}^FS`,
      );
    }
  } else if (key === 'loc-70x30') {
    lines.push(
      `^FO${dots(2, dpi)},${dots(2, dpi)}^A0N,${dots(7, dpi)},${dots(6, dpi)}${zplFd(code)}^FS`,
    );
    lines.push(
      `^FO${dots(2, dpi)},${dots(11, dpi)}^BY${by}^BCN,${dots(15, dpi)},N,N,N${zplFd(payload)}^FS`,
    );
  } else if (key === 'loc-100x50') {
    lines.push(
      `^FO${dots(2, dpi)},${dots(2, dpi)}^A0N,${dots(12, dpi)},${dots(10, dpi)}${zplFd(code)}^FS`,
    );
    if (wh)
      lines.push(
        `^FO${dots(2, dpi)},${dots(16, dpi)}^A0N,${dots(3.5, dpi)},${dots(3.5, dpi)}${zplFd(wh)}^FS`,
      );
    lines.push(
      `^FO${dots(2, dpi)},${dots(31, dpi)}^BY${by}^BCN,${dots(15, dpi)},N,N,N${zplFd(payload)}^FS`,
    );
    lines.push(`^FO${dots(80, dpi)},${dots(2, dpi)}^BQN,2,4^FH_^FDQA,${zplEscape(payload)}^FS`);
  } else {
    // loc-60x40 与 A4 单元格
    lines.push(
      `^FO${dots(2, dpi)},${dots(2, dpi)}^A0N,${dots(7, dpi)},${dots(6, dpi)}${zplFd(code)}^FS`,
    );
    if (wh)
      lines.push(
        `^FO${dots(2, dpi)},${dots(10, dpi)}^A0N,${dots(3, dpi)},${dots(3, dpi)}${zplFd(wh)}^FS`,
      );
    const barY = (spec.cellMm?.height ?? spec.heightMm) - 2 - 15;
    lines.push(
      `^FO${dots(2, dpi)},${dots(barY, dpi)}^BY${by}^BCN,${dots(15, dpi)},N,N,N${zplFd(payload)}^FS`,
    );
    if (key === 'a4-2x7') {
      lines.push(
        `^FO${dots((spec.cellMm?.width ?? 99) - 14, dpi)},${dots(2, dpi)}^BQN,2,3^FH_^FDQA,${zplEscape(payload)}^FS`,
      );
    }
  }
  lines.push('^XZ');
  return lines.join('\n');
}
