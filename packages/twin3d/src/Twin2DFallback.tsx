import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Occupancy, TwinModel } from '@wms3d/contracts';
import { binStyle, COLORS, dimColor, hexToRgb, type ColorMode, type RGB } from './colors.ts';
import { boundsOf, buildSceneData, rackToWorld, worldToRack, type SceneData } from './model.ts';
import { locateInRack, pointInPolygon } from './pick.ts';
import { EMPTY } from './slots.ts';
import { buildTwinIndex, indicesOf } from './twinIndex.ts';

export interface Twin2DProps {
  model: TwinModel | null;
  occupancy: Occupancy | null;
  colorMode?: ColorMode;
  highlight?: readonly string[];
  onPick?: (locationId: string) => void;
  onPickRack?: (rackKey: string) => void;
  maxLevel?: number;
  className?: string;
  style?: CSSProperties;
}

const css = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

interface View {
  scale: number;
  ox: number;
  oy: number;
}

/** 列（货架 + 列序号 + 位置）→ 该列各层 twinIndex（从下到上） */
function columnsOf(data: SceneData, model: TwinModel): Map<string, number[]> {
  const cols = new Map<string, number[]>();
  for (let k = 0; k < data.n; k++) {
    const ri = data.locRack[k]!;
    if (ri < 0) continue;
    const key = `${ri}|${model.locations.rackBayIndex[k]}|${model.locations.pos[k]}`;
    const arr = cols.get(key) ?? [];
    arr.push(k);
    cols.set(key, arr);
  }
  for (const arr of cols.values()) arr.sort((a, b) => data.locLevel[a]! - data.locLevel[b]!);
  return cols;
}

/**
 * 2D 降级（06 §7）：同数据 Canvas2D 俯视平面图，与 TwinView 同 props；支持着色、定位高亮、点击拾取、拖动/滚轮缩放。
 * 每个"列 × 位置"画一个格子，颜色取可见层中最满的一个（含高亮则高亮）。
 */
export function Twin2DFallback(props: Twin2DProps) {
  const {
    model,
    occupancy,
    colorMode = 'occupancy',
    highlight,
    onPick,
    onPickRack,
    maxLevel,
  } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 300, h: 200 });
  const [view, setView] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; v: View } | null>(null);
  const data = useMemo(() => (model ? buildSceneData(model) : null), [model]);
  const index = useMemo(() => (model ? buildTwinIndex(model) : null), [model]);
  const cols = useMemo(() => (data && model ? columnsOf(data, model) : null), [data, model]);
  const hl = useMemo(
    () => new Set(index && highlight ? indicesOf(index, highlight) : []),
    [index, highlight],
  );
  const occ =
    occupancy && model && occupancy.layoutVersion === model.layoutVersion ? occupancy : null;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) }),
    );
    ro.observe(el);
    setSize({ w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(
    (b: { min: readonly number[]; max: readonly number[] }, pad = 1.1): View => {
      const w = (b.max[0]! - b.min[0]!) * pad || 1;
      const d = (b.max[2]! - b.min[2]!) * pad || 1;
      const scale = Math.min(size.w / w, size.h / d);
      const cx = (b.min[0]! + b.max[0]!) / 2;
      const cz = (b.min[2]! + b.max[2]!) / 2;
      return { scale, ox: size.w / 2 - cx * scale, oy: size.h / 2 - cz * scale };
    },
    [size],
  );

  // 初次 / 模型变化：适配全仓
  useEffect(() => {
    if (data) setView(fit(data.bounds, 1.05));
  }, [data, fit]);
  // 高亮：聚焦到高亮包围盒
  useEffect(() => {
    if (!data || hl.size === 0) return;
    const b = boundsOf(data, hl);
    if (!b) return;
    const pad = 4;
    setView(
      fit(
        { min: [b.min[0] - pad, 0, b.min[2] - pad], max: [b.max[0] + pad, 0, b.max[2] + pad] },
        1,
      ),
    );
  }, [data, hl, fit]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !data || !model || !view || !cols) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#eef1f5';
    g.fillRect(0, 0, size.w, size.h);
    g.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
    const px = 1 / view.scale;
    const { widthM, depthM } = model.layout.warehouse;
    g.fillStyle = '#f7f8fa';
    g.fillRect(0, 0, widthM, depthM);
    for (const z of model.layout.zones) {
      const rgb = z.color ? hexToRgb(z.color) : COLORS.neutral;
      g.beginPath();
      z.polygon.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = css(rgb, 0.12);
      g.fill();
      g.strokeStyle = css(rgb, 0.6);
      g.lineWidth = px;
      g.stroke();
      if (view.scale > 4) {
        g.fillStyle = css(rgb, 0.9);
        g.font = `${12 * px}px sans-serif`;
        g.fillText(z.name ?? z.code, z.polygon[0]![0] + 4 * px, z.polygon[0]![1] + 14 * px);
      }
    }
    const zoneRgb = new Map(
      model.layout.zones.map((z) => [z.code, z.color ? dimColor(hexToRgb(z.color), 0.35) : null]),
    );
    const dim = hl.size > 0;
    const styleOf = (k: number): RGB | null => {
      const ri = data.locRack[k]!;
      const zone =
        ri >= 0
          ? data.racks[ri]!.rack.zone
          : (data.floors.find((f) => f.twinIndex === k)?.zone ?? '');
      const st = binStyle(colorMode, occ, k, zoneRgb.get(zone) ?? null);
      if (hl.has(k)) return COLORS.highlight;
      if (st.mesh === EMPTY) return null;
      return dim ? dimColor(st.color) : st.color;
    };
    // 地面仓位
    for (const f of data.floors) {
      const c0 = styleOf(f.twinIndex);
      g.beginPath();
      f.polygon.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = c0 ? css(c0, 0.55) : 'rgba(217,217,217,0.5)';
      g.fill();
    }
    // 货架外框
    for (const r of data.racks) {
      const pts = [
        rackToWorld(r, 0, 0),
        rackToWorld(r, r.lengthM, 0),
        rackToWorld(r, r.lengthM, -r.type.depthM),
        rackToWorld(r, 0, -r.type.depthM),
      ];
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = '#ffffff';
      g.fill();
      g.strokeStyle = css(COLORS.frame);
      g.lineWidth = 1.5 * px;
      g.stroke();
    }
    // 列格子
    for (const ks of cols.values()) {
      const vis = ks.filter((k) => maxLevel === undefined || data.locLevel[k]! <= maxLevel);
      if (!vis.length) continue;
      let color: RGB | null = null;
      let best = -1;
      for (const k of vis) {
        if (hl.has(k)) {
          color = COLORS.highlight;
          break;
        }
        const c0 = styleOf(k);
        const f = occ ? (occ.isActive[k] === 0 ? 2 : (occ.fill[k] ?? 0)) : 0.5;
        if (c0 && f > best) {
          best = f;
          color = c0;
        }
      }
      const k = vis[0]!;
      const cx = data.centers[3 * k]!;
      const cz = data.centers[3 * k + 2]!;
      const ri = data.locRack[k]!;
      const r = data.racks[ri]!;
      const hw = data.halfSizes[3 * k]!;
      const hd = data.halfSizes[3 * k + 2]!;
      // 列格子在货架局部系是轴对齐矩形
      const corners = [
        [-hw, -hd],
        [hw, -hd],
        [hw, hd],
        [-hw, hd],
      ].map(([a, b]) => [cx + a! * r.cos - b! * r.sin, cz + a! * r.sin + b! * r.cos] as const);
      g.beginPath();
      corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fillStyle = color ? css(color) : 'rgba(217,217,217,0.6)';
      g.fill();
    }
    // 高亮外圈
    if (hl.size) {
      g.strokeStyle = css(COLORS.highlight);
      g.lineWidth = 3 * px;
      for (const k of hl) {
        if (data.locChunk[k]! < 0) continue;
        g.beginPath();
        g.arc(
          data.centers[3 * k]!,
          data.centers[3 * k + 2]!,
          Math.max(0.8, 10 * px),
          0,
          Math.PI * 2,
        );
        g.stroke();
      }
    }
  }, [data, model, view, cols, size, occ, colorMode, hl, maxLevel]);

  const toWorld = (e: { clientX: number; clientY: number }): [number, number] | null => {
    const c = canvas.current;
    if (!c || !view) return null;
    const r = c.getBoundingClientRect();
    return [
      (e.clientX - r.left - view.ox) / view.scale,
      (e.clientY - r.top - view.oy) / view.scale,
    ];
  };

  const pickAt = (x: number, z: number) => {
    if (!data || !index || !model) return;
    for (const r of data.racks) {
      const [lx, lz] = worldToRack(r, x, z);
      if (lx < 0 || lx > r.lengthM || lz > 0 || lz < -r.type.depthM) continue;
      const { i, pos } = locateInRack(r.type, lx);
      const ks = cols
        ?.get(`${r.index}|${i}|${pos}`)
        ?.filter((k) => maxLevel === undefined || data.locLevel[k]! <= maxLevel);
      if (!ks?.length) {
        onPickRack?.(r.key);
        return;
      }
      const k = ks.find((q) => hl.has(q)) ?? ks.find((q) => (occ?.qty[q] ?? 0) > 0) ?? ks[0]!;
      onPick?.(index.indexToId[k]!);
      return;
    }
    for (const f of data.floors)
      if (pointInPolygon(x, z, f.polygon)) {
        onPick?.(index.indexToId[f.twinIndex]!);
        return;
      }
  };

  return (
    <div
      ref={wrap}
      className={props.className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        ...props.style,
      }}
      data-twin-mode="2d"
    >
      <canvas
        ref={canvas}
        style={{ width: '100%', height: '100%', display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (!view) return;
          drag.current = { x: e.clientX, y: e.clientY, moved: false, v: view };
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.hypot(dx, dy) > 4) d.moved = true;
          if (d.moved) setView({ ...d.v, ox: d.v.ox + dx, oy: d.v.oy + dy });
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            const w = toWorld(e);
            if (w) pickAt(w[0], w[1]);
          }
        }}
        onWheel={(e) => {
          if (!view) return;
          const r = (e.target as HTMLElement).getBoundingClientRect();
          const mx = e.clientX - r.left;
          const my = e.clientY - r.top;
          const f = Math.exp(-e.deltaY * 0.0015);
          const scale = Math.max(1, Math.min(400, view.scale * f));
          const k = scale / view.scale;
          setView({ scale, ox: mx - (mx - view.ox) * k, oy: my - (my - view.oy) * k });
        }}
      />
    </div>
  );
}
