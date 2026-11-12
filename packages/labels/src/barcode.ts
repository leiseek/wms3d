import bwipjs from 'bwip-js/node';
import type PDFDocument from 'pdfkit';
import { drawingPdfkit } from './drawing-pdfkit.ts';
import {
  CODE128_QUIET_MODULES,
  EAN13_QUIET_LEFT,
  EAN13_QUIET_RIGHT,
  linearRaw,
  qrRaw,
} from './barcode-metrics.ts';
import { mmToPt } from './units.ts';

type Doc = InstanceType<typeof PDFDocument>;

const SCALE_Y = 4;

export interface LinearDrawResult {
  widthPt: number;
  heightPt: number;
  modules: number;
}

/**
 * 用 bwip-js 自定义 drawing 把线性条码画进 pdfkit。
 * scaleX/scaleY + doc.scale 使 1 模块 = modulePt，条高 = heightMm（互不干扰）。
 */
export function drawLinearBarcode(
  doc: Doc,
  opts: {
    xPt: number;
    yPt: number;
    bcid: 'code128' | 'ean13';
    text: string;
    modulePt: number;
    heightMm: number;
    quietLeft?: number;
    quietRight?: number;
  },
): LinearDrawResult {
  const quietL =
    opts.quietLeft ?? (opts.bcid === 'ean13' ? EAN13_QUIET_LEFT : CODE128_QUIET_MODULES);
  const quietR =
    opts.quietRight ?? (opts.bcid === 'ean13' ? EAN13_QUIET_RIGHT : CODE128_QUIET_MODULES);
  const scaleY = SCALE_Y;
  const scaleX = scaleY * opts.modulePt;
  const k = 1 / scaleY;
  const renderOpts = {
    bcid: opts.bcid,
    text: opts.text,
    scaleX,
    scaleY,
    height: opts.heightMm,
    paddingleft: quietL,
    paddingright: quietR,
    paddingtop: 0,
    paddingbottom: 0,
    includetext: false,
  };
  doc.save();
  doc.translate(opts.xPt, opts.yPt);
  doc.scale(k);
  bwipjs.render(renderOpts, drawingPdfkit(doc, renderOpts));
  doc.restore();

  const body = linearRaw(opts.bcid, opts.text).sbs.reduce((a, b) => a + b, 0);
  const modules = body + quietL + quietR;
  return {
    widthPt: modules * opts.modulePt,
    heightPt: mmToPt(opts.heightMm),
    modules,
  };
}

export interface QrDrawResult {
  widthPt: number;
  heightPt: number;
  modules: number;
  versionModules: number;
}

/** 把 QR 画进边长为 sizePt（含静区）的方框，左上角 (xPt, yPt)。 */
export function drawQrCode(
  doc: Doc,
  opts: { xPt: number; yPt: number; text: string; sizePt: number; quiet?: number },
): QrDrawResult {
  // QR 用 bwip-js raw 矩阵画成矢量矩形。不走 DrawingContext+scale：
  // BWIPP 对部分 2D 符号内部还会再 ×2，模块尺寸会偏大并越界。
  const quiet = opts.quiet ?? 4;
  const raw = qrRaw(opts.text);
  const total = raw.pixx + 2 * quiet;
  const modulePt = opts.sizePt / total;
  doc.save();
  doc.translate(opts.xPt, opts.yPt);
  doc.fillColor('#000000');
  for (let y = 0; y < raw.pixy; y++) {
    let x = 0;
    const row = y * raw.pixx;
    while (x < raw.pixx) {
      while (x < raw.pixx && !raw.pixs[row + x]) x++;
      const start = x;
      while (x < raw.pixx && raw.pixs[row + x]) x++;
      if (x > start) {
        doc
          .rect(
            (start + quiet) * modulePt,
            (y + quiet) * modulePt,
            (x - start) * modulePt,
            modulePt,
          )
          .fill();
      }
    }
  }
  doc.restore();
  return {
    widthPt: opts.sizePt,
    heightPt: opts.sizePt,
    modules: total,
    versionModules: raw.pixx,
  };
}
