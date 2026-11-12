import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Arrow, Circle, Group, Layer, Line, Rect, Shape, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import type { LayoutDoc, LayoutIssue, LayoutRack, RackTypeSpec } from '@wms3d/contracts';
import { deriveSide, rackCode, rackLengthM } from '@wms3d/domain';
import { typeOf } from '../model/ops';
import { snapPoint, snapRack, type SnapResult } from '../model/snap';
import { aisleGuides } from '../model/aisles';
import type { Selection } from '../model/history';

export type Tool = 'select' | 'place' | 'zone' | 'floor' | 'measure';

export interface CanvasHandle {
  /** Konva 实际渲染后的货架四角（世界米，前左、前右、后右、后左）——Playwright 用于与 geometry-golden.json 对比 */
  rackCorners(key: string): Array<[number, number]> | null;
  worldToScreen(x: number, z: number): [number, number];
  fit(): void;
}

export interface DesignerCanvasProps {
  doc: LayoutDoc;
  selection: Selection;
  issues: readonly LayoutIssue[];
  tool: Tool;
  placingType: RackTypeSpec | null;
  placingRotation: 0 | 90 | 180 | 270;
  width: number;
  height: number;
  onSelect(s: Selection, additive: boolean): void;
  onMoveRacks(keys: string[], dx: number, dz: number): void;
  onPlace(x: number, z: number): void;
  onPolygon(kind: 'zone' | 'floor', pts: Array<[number, number]>): void;
  handleRef?: (h: CanvasHandle | null) => void;
}

const near = (a: [number, number], b: [number, number], tol: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;

export function DesignerCanvas(p: DesignerCanvasProps) {
  const { doc, width, height } = p;
  const stageRef = useRef<Konva.Stage>(null);
  const rackRefs = useRef(new Map<string, Konva.Group>());
  const [view, setView] = useState({ scale: 10, x: 20, y: 20 });
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [draft, setDraft] = useState<Array<[number, number]>>([]);
  const [guides, setGuides] = useState<SnapResult['guides']>([]);
  const [shift, setShift] = useState(false);

  const fit = () => {
    const s = Math.max(
      2,
      Math.min((width - 40) / doc.warehouse.widthM, (height - 40) / doc.warehouse.depthM),
    );
    setView({
      scale: s,
      x: (width - doc.warehouse.widthM * s) / 2,
      y: (height - doc.warehouse.depthM * s) / 2,
    });
  };
  // 只在首次拿到真实尺寸、或仓库尺寸变化时自动适配；画布高度变化（立面视图展开）不重置视图，避免拖动中跳变
  const fitKey = `${doc.warehouse.widthM}x${doc.warehouse.depthM}`;
  const sized = width > 200 && height > 200;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void (sized && fit()), [fitKey, sized]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShift(true);
      if (e.key === 'Escape') setDraft([]);
      if (e.key === 'Enter' && draft.length >= 3 && (p.tool === 'zone' || p.tool === 'floor')) {
        p.onPolygon(p.tool, draft);
        setDraft([]);
      }
    };
    const up = (e: KeyboardEvent) => e.key === 'Shift' && setShift(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [draft, p]);
  useEffect(() => setDraft([]), [p.tool]);

  const { handleRef } = p;
  useEffect(() => {
    handleRef?.({
      rackCorners(key) {
        const g = rackRefs.current.get(key);
        const r = doc.racks.find((x) => x.key === key);
        const t = r && typeOf(doc, r);
        if (!g || !t) return null;
        const L = rackLengthM(t);
        const tr = g.getTransform();
        return (
          [
            [0, 0],
            [L, 0],
            [L, -t.depthM],
            [0, -t.depthM],
          ] as const
        ).map(([lx, lz]) => {
          const q = tr.point({ x: lx, y: lz });
          return [Number(q.x.toFixed(6)) + 0, Number(q.y.toFixed(6)) + 0] as [number, number];
        });
      },
      worldToScreen: (x, z) => {
        const box = stageRef.current?.container().getBoundingClientRect();
        return [
          (box?.left ?? 0) + view.x + x * view.scale,
          (box?.top ?? 0) + view.y + z * view.scale,
        ];
      },
      fit,
    });
    return () => handleRef?.(null);
  });

  const toWorld = (): [number, number] | null => {
    const st = stageRef.current;
    const pos = st?.getPointerPosition();
    if (!pos) return null;
    return [(pos.x - view.x) / view.scale, (pos.y - view.y) / view.scale];
  };

  const errKeys = useMemo(() => {
    const m = new Map<string, 'ERROR' | 'WARNING'>();
    for (const i of p.issues)
      for (const k of i.rackKeys) if (m.get(k) !== 'ERROR') m.set(k, i.severity);
    return m;
  }, [p.issues]);
  const aisles = useMemo(() => aisleGuides(doc, p.issues), [doc, p.issues]);
  const selected = new Set(p.selection.kind === 'racks' ? p.selection.keys : []);
  const px = 1 / view.scale; // 1 像素对应的米数

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const pos = stageRef.current?.getPointerPosition();
    if (!pos) return;
    const k = e.evt.deltaY > 0 ? 1 / 1.15 : 1.15;
    const scale = Math.min(400, Math.max(1.5, view.scale * k));
    const wx = (pos.x - view.x) / view.scale;
    const wz = (pos.y - view.y) / view.scale;
    setView({ scale, x: pos.x - wx * scale, y: pos.y - wz * scale });
  };

  const onStageClick = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const w = toWorld();
    if (!w) return;
    if (p.tool === 'place') {
      const [x, z] = snapPoint(w[0], w[1]);
      p.onPlace(x, z);
      return;
    }
    if (p.tool === 'zone' || p.tool === 'floor') {
      const pt = snapPoint(w[0], w[1], 0.5);
      const last = draft[draft.length - 1];
      if (draft.length >= 3 && near(pt, draft[0]!, 0.01)) {
        p.onPolygon(p.tool, draft);
        setDraft([]);
      } else if (!last || !near(pt, last, 0.01)) setDraft([...draft, pt]);
      return;
    }
    if (p.tool === 'measure') {
      const pt = snapPoint(w[0], w[1]);
      setDraft(draft.length >= 2 ? [pt] : [...draft, pt]);
      return;
    }
    if (e.target === stageRef.current || e.target.name() === 'bg')
      p.onSelect({ kind: 'none' }, false);
  };

  const ghost: LayoutRack | null =
    p.tool === 'place' && p.placingType && cursor
      ? {
          key: '__ghost',
          zone: '',
          type: p.placingType.key,
          aisle: 1,
          rackNo: 1,
          bayStart: 1,
          x: snapPoint(cursor[0], cursor[1])[0],
          z: snapPoint(cursor[0], cursor[1])[1],
          rotationDeg: p.placingRotation,
        }
      : null;

  const W = doc.warehouse.widthM;
  const D = doc.warehouse.depthM;

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      x={view.x}
      y={view.y}
      scaleX={view.scale}
      scaleY={view.scale}
      draggable={p.tool === 'select'}
      onDragEnd={(e) => {
        if (e.target === stageRef.current)
          setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
      }}
      onWheel={onWheel}
      onClick={onStageClick}
      onMouseMove={() => setCursor(toWorld())}
      onDblClick={() => {
        // Konva 的 dblclick 只看时间间隔；只有两次点击落在同一点（最后一个顶点）才视为"双击结束"
        const w = toWorld();
        const last = draft[draft.length - 1];
        if (!w || !last || !near(snapPoint(w[0], w[1], 0.5), last, 0.01)) return;
        if ((p.tool === 'zone' || p.tool === 'floor') && draft.length >= 3) {
          p.onPolygon(p.tool, draft);
          setDraft([]);
        }
      }}
      style={{ background: '#f5f6f8', cursor: p.tool === 'select' ? 'default' : 'crosshair' }}
      data-testid="designer-stage"
    >
      <Layer listening={false}>
        <Shape
          sceneFunc={(ctx) => {
            const fine = view.scale >= 40;
            const step = fine ? 0.1 : 1;
            ctx.beginPath();
            for (let x = 0; x <= W + 1e-9; x += step) {
              const major = Math.abs(x - Math.round(x)) < 1e-6;
              if (!fine && !major) continue;
              ctx.moveTo(x, 0);
              ctx.lineTo(x, D);
            }
            for (let z = 0; z <= D + 1e-9; z += step) {
              ctx.moveTo(0, z);
              ctx.lineTo(W, z);
            }
            ctx.strokeStyle = fine ? '#e3e6eb' : '#e6e8ec';
            ctx.lineWidth = px;
            ctx.stroke();
            ctx.beginPath();
            for (let x = 0; x <= W + 1e-9; x += 5) {
              ctx.moveTo(x, 0);
              ctx.lineTo(x, D);
            }
            for (let z = 0; z <= D + 1e-9; z += 5) {
              ctx.moveTo(0, z);
              ctx.lineTo(W, z);
            }
            ctx.strokeStyle = '#cfd4dc';
            ctx.stroke();
          }}
        />
        {/* 标尺（米） */}
        {Array.from({ length: Math.floor(W / 5) + 1 }, (_, i) => (
          <Text
            key={`rx${i}`}
            x={i * 5}
            y={-14 * px}
            text={`${i * 5}m`}
            fontSize={10 * px}
            fill="#8a919c"
          />
        ))}
        {Array.from({ length: Math.floor(D / 5) + 1 }, (_, i) => (
          <Text
            key={`rz${i}`}
            x={-24 * px}
            y={i * 5 - 5 * px}
            text={`${i * 5}`}
            fontSize={10 * px}
            fill="#8a919c"
          />
        ))}
      </Layer>
      <Layer>
        <Rect
          name="bg"
          x={0}
          y={0}
          width={W}
          height={D}
          stroke="#3c4452"
          strokeWidth={2 * px}
          fill="rgba(255,255,255,0.6)"
        />
        {doc.zones.map((z) => {
          const sel = p.selection.kind === 'zone' && p.selection.code === z.code;
          return (
            <Group key={`z-${z.code}`}>
              <Line
                points={z.polygon.flat()}
                closed
                fill={`${z.color ?? '#5B8FF9'}22`}
                stroke={z.color ?? '#5B8FF9'}
                strokeWidth={(sel ? 3 : 1.5) * px}
                dash={[6 * px, 4 * px]}
                onClick={(e) => {
                  if (p.tool !== 'select') return;
                  e.cancelBubble = true;
                  p.onSelect({ kind: 'zone', code: z.code }, false);
                }}
              />
              <Text
                x={Math.min(...z.polygon.map((q) => q[0])) + 4 * px}
                y={Math.min(...z.polygon.map((q) => q[1])) + 4 * px}
                text={`${z.code}${z.name ? ` · ${z.name}` : ''}`}
                fontSize={12 * px}
                fill={z.color ?? '#5B8FF9'}
                listening={false}
              />
            </Group>
          );
        })}
        {doc.floorAreas.map((f) => {
          const sel = p.selection.kind === 'floor' && p.selection.code === f.locationCode;
          const cx = f.polygon.reduce((a, q) => a + q[0], 0) / f.polygon.length;
          const cz = f.polygon.reduce((a, q) => a + q[1], 0) / f.polygon.length;
          return (
            <Group
              key={`f-${f.locationCode}`}
              onClick={(e) => {
                if (p.tool !== 'select') return;
                e.cancelBubble = true;
                p.onSelect({ kind: 'floor', code: f.locationCode }, false);
              }}
            >
              <Line
                points={f.polygon.flat()}
                closed
                fill="#fff7e6"
                stroke={sel ? '#1677ff' : '#fa8c16'}
                strokeWidth={(sel ? 3 : 1.5) * px}
              />
              <Text
                x={cx}
                y={cz}
                text={f.locationCode}
                fontSize={12 * px}
                fill="#ad4e00"
                offsetX={20 * px}
                offsetY={6 * px}
              />
            </Group>
          );
        })}
        {aisles.map((a) => {
          const [x0, z0, x1, z1] =
            a.axis === 'x' ? [a.from, a.mid, a.to, a.mid] : [a.mid, a.from, a.mid, a.to];
          const band =
            a.faceL !== null && a.faceR !== null
              ? a.axis === 'x'
                ? {
                    x: a.from,
                    y: Math.min(a.faceL, a.faceR),
                    width: a.to - a.from,
                    height: Math.abs(a.faceR - a.faceL),
                  }
                : {
                    x: Math.min(a.faceL, a.faceR),
                    y: a.from,
                    width: Math.abs(a.faceL - a.faceR),
                    height: a.to - a.from,
                  }
              : null;
          return (
            <Group key={`a-${a.id}`} listening={false}>
              {band && (
                <Rect
                  {...band}
                  fill={a.narrow ? 'rgba(250,173,20,0.35)' : 'rgba(22,119,255,0.05)'}
                />
              )}
              <Arrow
                points={[x0, z0, x1, z1]}
                stroke={a.narrow ? '#d48806' : '#69b1ff'}
                fill={a.narrow ? '#d48806' : '#69b1ff'}
                strokeWidth={2 * px}
                pointerLength={10 * px}
                pointerWidth={8 * px}
                dash={[8 * px, 6 * px]}
              />
              <Text
                x={x0}
                y={z0}
                offsetY={a.axis === 'x' ? 14 * px : 0}
                offsetX={a.axis === 'z' ? -4 * px : 0}
                text={`${a.zone}${String(a.aisle).padStart(2, '0')}${a.width !== null ? ` · ${a.width.toFixed(2)}m` : ''}`}
                fontSize={11 * px}
                fill={a.narrow ? '#d48806' : '#4096ff'}
              />
            </Group>
          );
        })}
        {doc.racks.map((r) => (
          <RackShape
            key={r.key}
            doc={doc}
            rack={r}
            px={px}
            selected={selected.has(r.key)}
            severity={errKeys.get(r.key) ?? null}
            draggable={p.tool === 'select'}
            refCb={(g) => (g ? rackRefs.current.set(r.key, g) : rackRefs.current.delete(r.key))}
            onSelect={(add) =>
              p.onSelect(
                { kind: 'racks', keys: add ? [...new Set([...selected, r.key])] : [r.key] },
                add,
              )
            }
            onDragMove={(node) => {
              const s = snapRack(doc, r, node.x(), node.y(), { disabled: shift });
              node.position({ x: s.x, y: s.z });
              setGuides(s.guides);
            }}
            onDragEnd={(node) => {
              setGuides([]);
              const dx = node.x() - r.x;
              const dz = node.y() - r.z;
              if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return;
              const keys = selected.has(r.key) ? [...selected] : [r.key];
              p.onMoveRacks(keys, dx, dz);
            }}
          />
        ))}
        {ghost && (
          <RackShape
            doc={{ ...doc, rackTypes: [...doc.rackTypes, p.placingType!] }}
            rack={ghost}
            px={px}
            ghost
          />
        )}
        {guides.map((g, i) =>
          g.axis === 'x' ? (
            <Line
              key={`g${i}`}
              points={[g.value, 0, g.value, D]}
              stroke="#eb2f96"
              strokeWidth={px}
              dash={[4 * px, 4 * px]}
              listening={false}
            />
          ) : (
            <Line
              key={`g${i}`}
              points={[0, g.value, W, g.value]}
              stroke="#eb2f96"
              strokeWidth={px}
              dash={[4 * px, 4 * px]}
              listening={false}
            />
          ),
        )}
        {draft.length > 0 && <DraftOverlay tool={p.tool} pts={draft} cursor={cursor} px={px} />}
      </Layer>
    </Stage>
  );
}

function DraftOverlay({
  tool,
  pts,
  cursor,
  px,
}: {
  tool: Tool;
  pts: Array<[number, number]>;
  cursor: [number, number] | null;
  px: number;
}): ReactNode {
  const all = cursor ? [...pts, cursor] : pts;
  if (tool === 'measure') {
    const [a, b] = [all[0]!, all[1] ?? all[0]!];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return (
      <Group listening={false}>
        <Line points={[a[0], a[1], b[0], b[1]]} stroke="#722ed1" strokeWidth={2 * px} />
        <Text
          x={(a[0] + b[0]) / 2}
          y={(a[1] + b[1]) / 2}
          text={`${d.toFixed(2)} m`}
          fontSize={13 * px}
          fill="#722ed1"
          data-testid="measure"
        />
      </Group>
    );
  }
  return (
    <Group listening={false}>
      <Line points={all.flat()} stroke="#1677ff" strokeWidth={2 * px} dash={[6 * px, 4 * px]} />
      {pts.map((q, i) => (
        <Circle
          key={i}
          x={q[0]}
          y={q[1]}
          radius={4 * px}
          fill={i === 0 ? '#1677ff' : '#fff'}
          stroke="#1677ff"
          strokeWidth={px}
        />
      ))}
    </Group>
  );
}

interface RackShapeProps {
  doc: LayoutDoc;
  rack: LayoutRack;
  px: number;
  selected?: boolean;
  severity?: 'ERROR' | 'WARNING' | null;
  ghost?: boolean;
  draggable?: boolean;
  refCb?: (g: Konva.Group | null) => void;
  onSelect?: (additive: boolean) => void;
  onDragMove?: (node: Konva.Group) => void;
  onDragEnd?: (node: Konva.Group) => void;
}

/** 单个货架：Group 位于基点、rotation = rotationDeg（俯视顺时针，02 §2），局部占地 [0,L]×[−D,0]，取货面 = 局部 z=0 边。 */
function RackShape(p: RackShapeProps) {
  const { rack: r, doc, px } = p;
  const t = typeOf(doc, r);
  if (!t) return null;
  const L = rackLengthM(t);
  const D = t.depthM;
  const side = deriveSide(r.rotationDeg);
  let label: string;
  try {
    label = rackCode(r.zone || 'A', r.aisle, side, r.rackNo);
  } catch {
    label = r.key;
  }
  const stroke = p.ghost
    ? '#1677ff'
    : p.selected
      ? '#1677ff'
      : p.severity === 'ERROR'
        ? '#f5222d'
        : p.severity === 'WARNING'
          ? '#fa8c16'
          : '#5a6270';
  const dividers: number[] = [];
  for (let i = 1; i < t.bays; i++) dividers.push(i * (t.bayWidthM + t.uprightM) + t.uprightM / 2);
  return (
    <Group
      ref={p.refCb}
      name={p.ghost ? 'ghost' : `rack rack-${r.key}`}
      x={r.x}
      y={r.z}
      rotation={r.rotationDeg}
      opacity={p.ghost ? 0.45 : 1}
      listening={!p.ghost}
      draggable={p.draggable}
      onMouseDown={(e) => {
        e.cancelBubble = true;
        p.onSelect?.(e.evt.ctrlKey || e.evt.metaKey);
      }}
      onClick={(e) => (e.cancelBubble = true)}
      onDragStart={(e) => (e.cancelBubble = true)}
      onDragMove={(e) => {
        e.cancelBubble = true;
        p.onDragMove?.(e.target as unknown as Konva.Group);
      }}
      onDragEnd={(e) => {
        e.cancelBubble = true;
        p.onDragEnd?.(e.target as unknown as Konva.Group);
      }}
    >
      <Rect
        x={0}
        y={-D}
        width={L}
        height={D}
        fill={p.severity === 'ERROR' ? '#fff1f0' : p.selected ? '#e6f4ff' : '#ffffff'}
        stroke={stroke}
        strokeWidth={(p.selected || p.severity ? 2.5 : 1.2) * px}
      />
      {dividers.map((x, i) => (
        <Line key={i} points={[x, -D, x, 0]} stroke="#b8bec8" strokeWidth={px} listening={false} />
      ))}
      {/* 取货面（局部 z=0，加粗） */}
      <Line
        points={[0, 0, L, 0]}
        stroke={p.severity === 'ERROR' ? '#f5222d' : '#13c2c2'}
        strokeWidth={3.5 * px}
        listening={false}
      />
      {D * (1 / px) > 14 && (
        <Text
          x={L / 2}
          y={-D / 2}
          text={label}
          fontSize={Math.min(D * 0.45, 12 * px)}
          fill="#262b33"
          offsetX={(label.length * Math.min(D * 0.45, 12 * px)) / 3.6}
          offsetY={Math.min(D * 0.45, 12 * px) / 2}
          rotation={r.rotationDeg >= 180 ? 180 : 0}
          listening={false}
        />
      )}
    </Group>
  );
}
