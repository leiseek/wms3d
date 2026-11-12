/**
 * bwip-js 自定义 drawing → pdfkit 矢量路径。
 * 改编自 bwip-js 4.11 examples/drawing-pdfkit.js（矢量、无栅格）。
 */
import type { DrawingContext, RenderOptions } from 'bwip-js/node';
import bwipjs from 'bwip-js/node';
import type PDFDocument from 'pdfkit';

type FontLib = typeof bwipjs.FontLib;
type Doc = InstanceType<typeof PDFDocument>;

const ELLIPSE_MAGIC = 0.55228475 - 0.00045;

export function drawingPdfkit(
  doc: Doc,
  opts: RenderOptions,
  fontLib: FontLib = bwipjs.FontLib,
): DrawingContext<Doc> {
  let tx0 = 0,
    tx1 = 0,
    tx2 = 0,
    tx3 = 0;
  let ty0 = 0,
    ty1 = 0,
    ty2 = 0,
    ty3 = 0;
  let gsWidth = 0;
  let gsHeight = 0;
  let gsDx = 0;
  let gsDy = 0;

  const transform = (x: number, y: number): [number, number] => {
    const xx = x + gsDx;
    const yy = y + gsDy;
    const tx = tx0 * xx + tx1 * yy + tx2 * (gsWidth - 1) + tx3 * (gsHeight - 1);
    const ty = ty0 * xx + ty1 * yy + ty2 * (gsWidth - 1) + ty3 * (gsHeight - 1);
    return [tx, ty];
  };
  const moveTo = (x: number, y: number) => {
    const [px, py] = transform(x, y);
    doc.moveTo(px, py);
  };
  const lineTo = (x: number, y: number) => {
    const [px, py] = transform(x, y);
    doc.lineTo(px, py);
  };
  const quadTo = (cx: number, cy: number, x: number, y: number) => {
    const p1 = transform(cx, cy);
    const p2 = transform(x, y);
    doc.quadraticCurveTo(p1[0], p1[1], p2[0], p2[1]);
  };
  const cubicTo = (cx1: number, cy1: number, cx2: number, cy2: number, x: number, y: number) => {
    const p1 = transform(cx1, cy1);
    const p2 = transform(cx2, cy2);
    const p3 = transform(x, y);
    doc.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
  };

  return {
    scale() {
      return null;
    },
    measure(str, font, fwidth, fheight) {
      const fw = fwidth | 0;
      const fh = fheight | 0;
      const fontid = fontLib.lookup(font);
      let width = 0;
      let ascent = 0;
      let descent = 0;
      for (let i = 0; i < str.length; i++) {
        const glyph = fontLib.getpaths(fontid, str.charCodeAt(i), fw, fh);
        if (!glyph) continue;
        ascent = Math.max(ascent, glyph.ascent);
        descent = Math.max(descent, -glyph.descent);
        width += glyph.advance;
      }
      return { width, ascent, descent };
    },
    init(width, height) {
      const padl = opts.paddingleft ?? 0;
      const padr = opts.paddingright ?? 0;
      const padt = opts.paddingtop ?? 0;
      const padb = opts.paddingbottom ?? 0;
      const rot = opts.rotate || 'N';
      width += padl + padr;
      height += padt + padb;
      tx0 = tx1 = tx2 = tx3 = ty0 = ty1 = ty2 = ty3 = 0;
      switch (rot) {
        case 'R':
          tx1 = -1;
          tx2 = 1;
          ty0 = 1;
          break;
        case 'I':
          tx0 = -1;
          tx2 = 1;
          ty1 = -1;
          ty3 = 1;
          break;
        case 'L':
          tx1 = 1;
          ty0 = -1;
          ty3 = 1;
          break;
        default:
          tx0 = ty1 = 1;
          break;
      }
      const swap = rot === 'L' || rot === 'R';
      gsWidth = swap ? height : width;
      gsHeight = swap ? width : height;
      doc.save();
      doc.lineCap('butt');
      if (/^[0-9a-fA-F]{6}$/.test(`${opts.backgroundcolor ?? ''}`)) {
        gsDx = gsDy = 0;
        moveTo(0, 0);
        lineTo(width, 0);
        lineTo(width, height);
        lineTo(0, height);
        lineTo(0, 0);
        doc.fillColor(`#${opts.backgroundcolor}`);
        doc.fill('non-zero');
      }
      gsDx = padl;
      gsDy = padt;
    },
    line(x0, y0, x1, y1, lw, _rgb) {
      // 线性条码的线总是正交的：用填充矩形代替描边，避免线宽对半分导致的栅格误差。
      const p0 = transform(x0, y0);
      const p1 = transform(x1, y1);
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      if (Math.abs(dx) < 1e-6) {
        const y = Math.min(p0[1], p1[1]);
        doc.rect(p0[0] - lw / 2, y, lw, Math.abs(dy)).fill('#000000');
      } else if (Math.abs(dy) < 1e-6) {
        const x = Math.min(p0[0], p1[0]);
        doc.rect(x, p0[1] - lw / 2, Math.abs(dx), lw).fill('#000000');
      } else {
        moveTo(x0, y0);
        lineTo(x1, y1);
        doc.lineWidth(lw).strokeColor('#000000').stroke();
      }
    },
    polygon(pts) {
      const first = pts[0];
      if (!first) return;
      moveTo(first[0], first[1]);
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i]!;
        lineTo(p[0], p[1]);
      }
    },
    hexagon(pts) {
      this.polygon(pts);
    },
    ellipse(x, y, rx, ry) {
      const dx = rx * ELLIPSE_MAGIC;
      const dy = ry * ELLIPSE_MAGIC;
      moveTo(x - rx, y);
      cubicTo(x - rx, y - dy, x - dx, y - ry, x, y - ry);
      cubicTo(x + dx, y - ry, x + rx, y - dy, x + rx, y);
      cubicTo(x + rx, y + dy, x + dx, y + ry, x, y + ry);
      cubicTo(x - dx, y + ry, x - rx, y + dy, x - rx, y);
    },
    fill(rgb) {
      doc.fillColor(`#${rgb}`);
      doc.fill('even-odd');
    },
    text(x, y, str, rgb, font) {
      const fontid = fontLib.lookup(font.name);
      const fwidth = font.width | 0;
      const fheight = font.height | 0;
      const dx = font.dx | 0;
      let cx = x;
      for (let k = 0; k < str.length; k++) {
        const glyph = fontLib.getpaths(fontid, str.charCodeAt(k), fwidth, fheight);
        if (!glyph) continue;
        for (const seg of glyph) {
          if (seg.type === 'M') moveTo(seg.x + cx, y - seg.y);
          else if (seg.type === 'L') lineTo(seg.x + cx, y - seg.y);
          else if (seg.type === 'Q') quadTo(seg.cx + cx, y - seg.cy, seg.x + cx, y - seg.y);
          else if (seg.type === 'C')
            cubicTo(seg.cx1 + cx, y - seg.cy1, seg.cx2 + cx, y - seg.cy2, seg.x + cx, y - seg.y);
        }
        cx += glyph.advance + dx;
      }
      doc.fillColor(`#${rgb}`);
      doc.fill('non-zero');
    },
    end() {
      doc.restore();
      return doc;
    },
  };
}
