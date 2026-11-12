/** mm → PostScript pt（1 pt = 1/72 in）。 */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

export function ptToMm(pt: number): number {
  return (pt * 25.4) / 72;
}

/** 整数打印点在给定 dpi 下的毫米宽度。 */
export function dotsToMm(dots: number, dpi: number): number {
  return (dots * 25.4) / dpi;
}

export function dotsToPt(dots: number, dpi: number): number {
  return (dots * 72) / dpi;
}
