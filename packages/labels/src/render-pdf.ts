import { compilePattern, DEFAULT_PATTERN, levelLetter, splitPayload } from '@wms3d/domain';
import type { LabelTemplateKey } from '@wms3d/contracts';
import PDFDocument from 'pdfkit';
import { assertCapacity } from './capacity.ts';
import { drawLinearBarcode, drawQrCode } from './barcode.ts';
import { countPayloadModules, qrRaw, skuSymbology } from './barcode-metrics.ts';
import { LABEL_FONT_NAME, resolveLabelFontPath } from './fonts.ts';
import {
  assertItemKind,
  getLabelTemplate,
  isPrefixedPayload,
  xDimension,
  type TemplateSpec,
} from './templates.ts';
import type { CalibrationInput, Dpi, LabelItem, LabelRenderInput } from './types.ts';
import { MAX_LABELS_PER_RENDER } from './types.ts';
import { mmToPt } from './units.ts';

type Doc = InstanceType<typeof PDFDocument>;

const LOCATION_PATTERN = compilePattern(DEFAULT_PATTERN);
const BAR_HEIGHT_MM = 15;
const MARGIN_MM = 2;

function registerFont(doc: Doc): void {
  doc.registerFont(LABEL_FONT_NAME, resolveLabelFontPath());
  doc.font(LABEL_FONT_NAME);
}

function newDoc(widthMm: number, heightMm: number): { doc: Doc; done: Promise<Uint8Array> } {
  const doc = new PDFDocument({
    size: [mmToPt(widthMm), mmToPt(heightMm)],
    margin: 0,
    autoFirstPage: true,
    compress: false, // 大批量渲染优先速度（验收：1000 张 < 5s）
    info: {
      Title: 'WMS3D labels',
      Author: 'WMS3D',
      Creator: '@wms3d/labels',
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  registerFont(doc);
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on('error', reject);
  });
  return { doc, done };
}

function addPage(doc: Doc, widthMm: number, heightMm: number): void {
  doc.addPage({ size: [mmToPt(widthMm), mmToPt(heightMm)], margin: 0 });
  doc.font(LABEL_FONT_NAME);
}

function warehouseOf(item: LabelItem): string | undefined {
  return splitPayload(item.payload)?.warehouseCode;
}

function levelOf(code: string): string | undefined {
  const parts = LOCATION_PATTERN.parse(code);
  if (!parts) return undefined;
  try {
    return levelLetter(parts.level);
  } catch {
    return undefined;
  }
}

function fillText(
  doc: Doc,
  text: string,
  xMm: number,
  yMm: number,
  opts: {
    fontMm: number;
    widthMm?: number;
    align?: 'left' | 'center' | 'right';
    lineGap?: number;
    lineBreak?: boolean;
  },
): void {
  doc
    .font(LABEL_FONT_NAME)
    .fontSize(mmToPt(opts.fontMm))
    .fillColor('#000000')
    .text(text, mmToPt(xMm), mmToPt(yMm), {
      width: opts.widthMm != null ? mmToPt(opts.widthMm) : undefined,
      align: opts.align ?? 'left',
      lineBreak: opts.lineBreak ?? opts.widthMm != null,
      lineGap: opts.lineGap ?? 0,
    });
}

function drawLevelArrow(doc: Doc, xMm: number, yMm: number, sizeMm: number, letter?: string): void {
  const x = mmToPt(xMm);
  const y = mmToPt(yMm);
  const s = mmToPt(sizeMm);
  doc.save();
  doc.fillColor('#000000');
  doc
    .moveTo(x + s / 2, y)
    .lineTo(x + s, y + s * 0.55)
    .lineTo(x, y + s * 0.55)
    .closePath()
    .fill();
  doc.rect(x + s * 0.35, y + s * 0.5, s * 0.3, s * 0.45).fill();
  doc.restore();
  if (letter) {
    fillText(doc, letter, xMm, yMm + sizeMm * 0.95, {
      fontMm: sizeMm * 0.55,
      widthMm: sizeMm,
      align: 'center',
    });
  }
}

function linearOpts(template: LabelTemplateKey, item: LabelItem, dpi: Dpi) {
  const bare = !isPrefixedPayload(item.payload);
  const x = xDimension(template, dpi, bare);
  // 仅 sku-60x40 对合法 EAN-13 改用 EAN；仓位/货架始终 Code128。
  const bcid = template === 'sku-60x40' ? skuSymbology(item.payload) : 'code128';
  return { x, bcid, bare };
}

/** loc-100x50：可见 QR 目标 18mm（16–18），含静区边长随版本缩放，且不挤占条码。 */
function loc100x50QrTotalMm(payload: string): number {
  const quiet = 4;
  const visibleTargetMm = 18;
  const raw = qrRaw(payload);
  const totalModules = raw.pixx + 2 * quiet;
  const barY = 50 - MARGIN_MM - BAR_HEIGHT_MM - 2; // 31
  const maxByHeight = barY - MARGIN_MM - 2; // 与条码至少 2mm
  const maxByWidth = 27; // 为左侧大号编码留约 60mm
  const rawTotal = (visibleTargetMm / raw.pixx) * totalModules;
  return Math.min(rawTotal, maxByHeight, maxByWidth);
}

function drawLoc100x50(doc: Doc, item: LabelItem, dpi: Dpi, ox: number, oy: number): void {
  const { x, bcid } = linearOpts('loc-100x50', item, dpi);
  doc.save();
  doc.translate(mmToPt(ox), mmToPt(oy));
  const qrSize = loc100x50QrTotalMm(item.payload);
  const arrowSize = 8;
  const codeFontMm = 12;
  const codeY = MARGIN_MM;
  // QR 靠右，层箭头放在副标题行，避免挤掉大号编码宽度导致换行。
  const qrX = 100 - MARGIN_MM - qrSize;
  const textWidth = qrX - MARGIN_MM - 2;
  fillText(doc, item.code, MARGIN_MM, codeY, {
    fontMm: codeFontMm,
    widthMm: textWidth,
    lineBreak: false,
  });
  const wh = [warehouseOf(item), item.subtitle].filter(Boolean).join('  ');
  const level = levelOf(item.code);
  const subtitleWidth = textWidth - (level ? arrowSize + 1 : 0);
  if (wh) {
    // 大号编码字形底部约 14.2mm，副标题从 y=17 起，间距 ≥ 2mm。
    fillText(doc, wh, MARGIN_MM, 17, { fontMm: 3.5, widthMm: subtitleWidth });
  }
  if (level) {
    drawLevelArrow(doc, qrX - 1 - arrowSize, 16, arrowSize, level);
  }
  drawQrCode(doc, {
    xPt: mmToPt(qrX),
    yPt: mmToPt(MARGIN_MM),
    text: item.payload,
    sizePt: mmToPt(qrSize),
  });

  const barY = 50 - MARGIN_MM - BAR_HEIGHT_MM - 2;
  drawLinearBarcode(doc, {
    xPt: mmToPt(MARGIN_MM),
    yPt: mmToPt(barY),
    bcid,
    text: item.payload,
    modulePt: x.pt,
    heightMm: BAR_HEIGHT_MM,
  });
  doc.restore();
}

function drawLoc60x40(doc: Doc, item: LabelItem, dpi: Dpi, ox: number, oy: number): void {
  const { x, bcid } = linearOpts('loc-60x40', item, dpi);
  doc.save();
  doc.translate(mmToPt(ox), mmToPt(oy));
  fillText(doc, item.code, MARGIN_MM, MARGIN_MM, { fontMm: 8, widthMm: 56 });
  const wh = warehouseOf(item);
  if (wh) fillText(doc, wh, MARGIN_MM, 12.5, { fontMm: 3, widthMm: 56 });
  drawLinearBarcode(doc, {
    xPt: mmToPt(MARGIN_MM),
    yPt: mmToPt(40 - MARGIN_MM - BAR_HEIGHT_MM),
    bcid,
    text: item.payload,
    modulePt: x.pt,
    heightMm: BAR_HEIGHT_MM,
  });
  doc.restore();
}

/** 70×30：上边距 2 + 字高 7 + 间距 2 + 条高 15 + 下边距 4。 */
function drawLoc70x30(doc: Doc, item: LabelItem, dpi: Dpi, ox: number, oy: number): void {
  const { x, bcid } = linearOpts('loc-70x30', item, dpi);
  const modules = countPayloadModules('loc-70x30', item.payload);
  const barWidthMm = modules * x.mm;
  const x0 = Math.max(0, (70 - barWidthMm) / 2);
  doc.save();
  doc.translate(mmToPt(ox), mmToPt(oy));
  fillText(doc, item.code, MARGIN_MM, 2, { fontMm: 7, widthMm: 66, align: 'center' });
  drawLinearBarcode(doc, {
    xPt: mmToPt(x0),
    yPt: mmToPt(2 + 7 + 2),
    bcid,
    text: item.payload,
    modulePt: x.pt,
    heightMm: BAR_HEIGHT_MM,
  });
  doc.restore();
}

function drawRack(doc: Doc, item: LabelItem, _dpi: Dpi, ox: number, oy: number): void {
  doc.save();
  doc.translate(mmToPt(ox), mmToPt(oy));
  fillText(doc, item.code, MARGIN_MM, 6, { fontMm: 22, widthMm: 96, align: 'center' });
  const wh = [warehouseOf(item), item.subtitle].filter(Boolean).join('  ');
  if (wh) fillText(doc, wh, MARGIN_MM, 32, { fontMm: 5, widthMm: 96, align: 'center' });
  const qrSize = 70;
  drawQrCode(doc, {
    xPt: mmToPt((100 - qrSize) / 2),
    yPt: mmToPt(42),
    text: item.payload,
    sizePt: mmToPt(qrSize),
  });
  doc.restore();
}

function drawA4Cell(
  doc: Doc,
  template: 'a4-3x8' | 'a4-2x7',
  item: LabelItem,
  dpi: Dpi,
  ox: number,
  oy: number,
  cellW: number,
  cellH: number,
): void {
  const { x } = linearOpts(template, item, dpi);
  const bcid = item.kind === 'SKU' ? skuSymbology(item.payload) : 'code128';
  doc.save();
  doc.translate(mmToPt(ox), mmToPt(oy));
  const withQr = template === 'a4-2x7';
  const qrSize = withQr ? 12 : 0;
  const text = item.kind === 'SKU' ? (item.title ?? item.code) : item.code;
  fillText(doc, text, 2, 2, {
    fontMm: template === 'a4-3x8' ? 5.5 : 6.5,
    widthMm: cellW - 4 - qrSize,
  });
  if (item.kind === 'SKU' && item.code && item.title) {
    fillText(doc, item.code, 2, 11, { fontMm: 3.5, widthMm: cellW - 4 - qrSize });
  } else {
    const wh = warehouseOf(item);
    if (wh) fillText(doc, wh, 2, 11, { fontMm: 2.8, widthMm: cellW - 4 - qrSize });
  }
  if (withQr) {
    drawQrCode(doc, {
      xPt: mmToPt(cellW - 2 - qrSize),
      yPt: mmToPt(2),
      text: item.payload,
      sizePt: mmToPt(qrSize),
    });
  }
  drawLinearBarcode(doc, {
    xPt: mmToPt(2),
    yPt: mmToPt(cellH - 2 - BAR_HEIGHT_MM),
    bcid,
    text: item.payload,
    modulePt: x.pt,
    heightMm: BAR_HEIGHT_MM,
  });
  doc.restore();
}

function drawSku60x40(doc: Doc, item: LabelItem, dpi: Dpi, ox: number, oy: number): void {
  const { x, bcid } = linearOpts('sku-60x40', item, dpi);
  doc.save();
  doc.translate(mmToPt(ox), mmToPt(oy));
  const title = item.title ?? item.code;
  fillText(doc, title, MARGIN_MM, 2, { fontMm: 4.2, widthMm: 56 });
  // 第二行：编码（若与标题不同）
  if (item.code && item.code !== title) {
    fillText(doc, item.code, MARGIN_MM, 11.5, { fontMm: 3.2, widthMm: 56 });
  }
  drawLinearBarcode(doc, {
    xPt: mmToPt(MARGIN_MM),
    yPt: mmToPt(40 - MARGIN_MM - BAR_HEIGHT_MM),
    bcid,
    text: item.payload,
    modulePt: x.pt,
    heightMm: BAR_HEIGHT_MM,
  });
  doc.restore();
}

function drawOne(
  doc: Doc,
  spec: TemplateSpec,
  item: LabelItem,
  dpi: Dpi,
  ox: number,
  oy: number,
): void {
  assertItemKind(spec.key, item.kind);
  assertCapacity(spec.key, item.payload, dpi);
  const cellW = spec.cellMm?.width ?? spec.widthMm;
  const cellH = spec.cellMm?.height ?? spec.heightMm;
  switch (spec.key) {
    case 'loc-100x50':
      drawLoc100x50(doc, item, dpi, ox, oy);
      break;
    case 'loc-60x40':
      drawLoc60x40(doc, item, dpi, ox, oy);
      break;
    case 'loc-70x30':
      drawLoc70x30(doc, item, dpi, ox, oy);
      break;
    case 'rack-100x150':
      drawRack(doc, item, dpi, ox, oy);
      break;
    case 'a4-3x8':
    case 'a4-2x7':
      drawA4Cell(doc, spec.key, item, dpi, ox, oy, cellW, cellH);
      break;
    case 'sku-60x40':
      drawSku60x40(doc, item, dpi, ox, oy);
      break;
  }
}

function a4Origin(spec: TemplateSpec): { left: number; top: number } {
  const sheet = spec.sheet;
  const cell = spec.cellMm;
  if (!sheet || !cell) return { left: 0, top: 0 };
  const gridW = sheet.cols * cell.width;
  const gridH = sheet.rows * cell.height;
  return { left: (spec.widthMm - gridW) / 2, top: (spec.heightMm - gridH) / 2 };
}

export async function renderLabelsPdf(input: LabelRenderInput): Promise<Uint8Array> {
  if (input.items.length > MAX_LABELS_PER_RENDER) {
    throw new Error(`单次最多渲染 ${MAX_LABELS_PER_RENDER} 张，收到 ${input.items.length}`);
  }
  const spec = getLabelTemplate(input.template);
  const dpi = input.dpi;
  const offX = input.offsetMm?.x ?? 0;
  const offY = input.offsetMm?.y ?? 0;
  const { doc, done } = newDoc(spec.widthMm, spec.heightMm);

  if (spec.sheet && spec.cellMm) {
    const { cols, rows } = spec.sheet;
    const perPage = cols * rows;
    const start = Math.max(1, input.startCell ?? 1) - 1;
    if (start >= perPage) {
      throw new Error(`startCell=${input.startCell} 超出本页格数 ${perPage}`);
    }
    const origin = a4Origin(spec);
    let slot = start;
    let page = 0;
    if (input.items.length === 0) {
      // 保留空白首页
    } else {
      for (const item of input.items) {
        if (page > 0 && slot === 0) addPage(doc, spec.widthMm, spec.heightMm);
        const col = slot % cols;
        const row = Math.floor(slot / cols);
        const ox = origin.left + col * spec.cellMm.width + offX;
        const oy = origin.top + row * spec.cellMm.height + offY;
        drawOne(doc, spec, item, dpi, ox, oy);
        slot += 1;
        if (slot >= perPage) {
          slot = 0;
          page += 1;
        }
      }
    }
  } else {
    const items = input.items.length === 0 ? [null] : input.items;
    items.forEach((item, i) => {
      if (i > 0) addPage(doc, spec.widthMm, spec.heightMm);
      if (item) drawOne(doc, spec, item, dpi, offX, offY);
    });
  }

  doc.end();
  return done;
}

/** 校准页：10mm 刻度尺 + 测试条码 + 边框。 */
export async function renderCalibrationPdf(input: CalibrationInput): Promise<Uint8Array> {
  const spec = getLabelTemplate(input.template);
  const { doc, done } = newDoc(spec.widthMm, spec.heightMm);
  const w = spec.widthMm;
  const h = spec.heightMm;
  // 外框
  doc.save();
  doc.lineWidth(mmToPt(0.4)).strokeColor('#000000');
  doc.rect(mmToPt(0.5), mmToPt(0.5), mmToPt(w - 1), mmToPt(h - 1)).stroke();
  doc.restore();

  // 10mm 刻度尺（上边与左边）
  doc.save();
  doc.lineWidth(mmToPt(0.2)).strokeColor('#000000').fillColor('#000000');
  const maxX = Math.floor(w);
  for (let mm = 0; mm <= maxX; mm++) {
    const len = mm % 10 === 0 ? 6 : mm % 5 === 0 ? 3.5 : 2;
    doc.moveTo(mmToPt(mm), mmToPt(0)).lineTo(mmToPt(mm), mmToPt(len)).stroke();
    if (mm % 10 === 0 && mm > 0 && mm < w - 8) {
      fillText(doc, String(mm), mm - 3, len + 0.5, { fontMm: 2.2, widthMm: 6, align: 'center' });
    }
  }
  const maxY = Math.floor(h);
  for (let mm = 0; mm <= maxY; mm++) {
    const len = mm % 10 === 0 ? 6 : mm % 5 === 0 ? 3.5 : 2;
    doc.moveTo(mmToPt(0), mmToPt(mm)).lineTo(mmToPt(len), mmToPt(mm)).stroke();
  }
  fillText(doc, '10 mm', 8, 8, { fontMm: 3 });
  doc.restore();

  const samplePayload = 'WH1.A03-17-C02';
  const sampleItem: LabelItem = {
    kind: spec.kinds[0] ?? 'LOCATION',
    code:
      spec.kinds[0] === 'RACK'
        ? 'RA03-L02'
        : spec.kinds[0] === 'SKU'
          ? 'SKU-DEMO-01'
          : 'A03-17-C02',
    payload:
      spec.kinds[0] === 'SKU'
        ? 'SKU-DEMO-01'
        : spec.kinds[0] === 'RACK'
          ? 'WH1.RA03-L02'
          : samplePayload,
    title: '校准样张',
    subtitle: '打印请选实际大小 / 100%，关闭适合纸张',
  };

  if (spec.sheet && spec.cellMm) {
    const origin = a4Origin(spec);
    // 在第 1 格放样张，并画出全部单元格边框
    for (let r = 0; r < spec.sheet.rows; r++) {
      for (let c = 0; c < spec.sheet.cols; c++) {
        const ox = origin.left + c * spec.cellMm.width;
        const oy = origin.top + r * spec.cellMm.height;
        doc.save();
        doc
          .lineWidth(mmToPt(0.15))
          .strokeColor('#999999')
          .rect(mmToPt(ox), mmToPt(oy), mmToPt(spec.cellMm.width), mmToPt(spec.cellMm.height))
          .stroke();
        doc.restore();
      }
    }
    drawOne(doc, spec, sampleItem, input.dpi, origin.left, origin.top);
    fillText(
      doc,
      `${spec.name}  校准页  ${input.dpi}dpi    缩放选「实际大小 / 100%」，关闭「适合纸张」`,
      10,
      spec.heightMm - 8,
      { fontMm: 3.2, widthMm: spec.widthMm - 20, align: 'center' },
    );
  } else {
    // 热敏：把样张略缩小贴在尺下方，避免与刻度重叠太多
    drawOne(doc, spec, sampleItem, input.dpi, 0, 0);
    fillText(doc, `${spec.name}  ${input.dpi}dpi  请用实际大小打印`, 8, h - 5, {
      fontMm: 2.6,
      widthMm: w - 16,
      align: 'center',
    });
  }

  doc.end();
  return done;
}
