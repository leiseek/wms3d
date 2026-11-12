import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from 'react';
import type { Occupancy, TwinModel } from '@wms3d/contracts';
import { legendFor, type ColorMode } from './colors.ts';
import { detectWebGL2 } from './detect.ts';
import {
  TwinEngine,
  type CameraPreset,
  type LocationInfo,
  type PerfReport,
  type TwinStats,
} from './engine.ts';
import { Twin2DFallback } from './Twin2DFallback.tsx';

export type TwinRenderMode = '3d' | '2d';
export type FallbackReason = 'no-webgl2' | 'init-failed' | 'slow' | 'context-lost' | 'forced';

export interface TwinViewHandle {
  /** 飞到一组仓位 */
  flyTo(locationIds: readonly string[]): void;
  setCameraPreset(p: CameraPreset): void;
  /** 强制渲染一帧并返回 draw calls / 三角形等（基准与测试用；2D 模式返回 null） */
  stats(): TwinStats | null;
  /** 上下文丢失后的手动重建 */
  rebuild(): void;
  mode(): TwinRenderMode;
  /** 3D 引擎（高级用法；2D 模式为 null） */
  engine(): TwinEngine | null;
}

export interface TwinViewProps {
  /** TwinModel（GET /warehouses/{id}/twin）；null = 加载中 */
  model: TwinModel | null;
  /** 同版本 occupancy；版本不符会被忽略并回调 onStaleOccupancy */
  occupancy: Occupancy | null;
  colorMode?: ColorMode;
  /** 高亮的 locationId（SKU 定位结果）；变化时相机飞到其包围盒 */
  highlight?: readonly string[];
  onPick?: (locationId: string) => void;
  cameraPreset?: CameraPreset;
  // ---- 以下为可选扩展（不改变 brief 约定的 props）----
  /** 远景块点击返回货架 */
  onPickRack?: (rackKey: string) => void;
  /** 只看第 N 层及以下 */
  maxLevel?: number;
  /** 高亮变化时是否飞行（默认 true） */
  flyOnHighlight?: boolean;
  /** 仓位编码文字（troika；默认 true，需 labelFont 同源字体 URL，否则不显示） */
  labels?: boolean;
  labelFont?: string;
  showLegend?: boolean;
  /** 内置选中卡片（默认 true） */
  showCard?: boolean;
  /** 强制 2D */
  force2D?: boolean;
  /** 性能不足/上下文反复丢失时自动切 2D（默认 true） */
  autoFallback?: boolean;
  /** 启动 2s 基准（默认 true） */
  startupBenchmark?: boolean;
  onModeChange?: (mode: TwinRenderMode, reason: FallbackReason | null) => void;
  onStaleOccupancy?: (occupancyLayoutVersion: number) => void;
  onPerf?: (r: PerfReport) => void;
  className?: string;
  style?: CSSProperties;
  ref?: Ref<TwinViewHandle>;
}

const card: CSSProperties = {
  position: 'absolute',
  left: 12,
  top: 12,
  minWidth: 180,
  padding: '10px 12px',
  background: 'rgba(255,255,255,0.96)',
  borderRadius: 8,
  boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
  font: '13px/1.6 system-ui, sans-serif',
  color: '#1f2937',
  zIndex: 2,
};

function Legend({ mode }: { mode: ColorMode }) {
  return (
    <div
      style={{
        position: 'absolute',
        right: 10,
        bottom: 10,
        padding: '6px 10px',
        background: 'rgba(255,255,255,0.9)',
        borderRadius: 6,
        font: '12px/1.7 system-ui, sans-serif',
        color: '#374151',
        zIndex: 2,
        pointerEvents: 'none',
      }}
      data-testid="twin-legend"
    >
      {legendFor(mode).map((l) => (
        <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              background: l.color,
              display: 'inline-block',
            }}
          />
          {l.label}
        </div>
      ))}
    </div>
  );
}

function SelectionCard(props: { info: LocationInfo; onClose(): void; onFocus(): void }) {
  const { info } = props;
  const status = info.isActive === false ? '停用' : info.qty ? '有货' : info.qty === 0 ? '空' : '—';
  return (
    <div style={card} data-testid="twin-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <b style={{ fontFamily: 'ui-monospace, monospace' }}>{info.code}</b>
        <button
          onClick={props.onClose}
          style={{ border: 0, background: 'none', cursor: 'pointer' }}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      <div>状态：{status}</div>
      <div>
        数量：{info.qty ?? '—'}
        {info.effectiveMax != null ? ` / ${info.effectiveMax}` : ''}
        {info.fill != null ? `（${Math.round(info.fill * 100)}%）` : ''}
      </div>
      <div>SKU 数：{info.skuCount ?? '—'}</div>
      <button onClick={props.onFocus} style={{ marginTop: 4 }}>
        聚焦
      </button>
    </div>
  );
}

/**
 * 3D 孪生视图（06）。纯展示：不发请求，输入 TwinModel + Occupancy，输出 onPick。
 * WebGL2 不可用 / 初始化失败 / 性能不足（autoFallback）/ 上下文反复丢失 → 自动切到同 props 的 Twin2DFallback。
 */
export function TwinView(props: TwinViewProps) {
  const {
    model,
    occupancy,
    colorMode = 'occupancy',
    highlight,
    cameraPreset,
    maxLevel,
    flyOnHighlight = true,
    showLegend = true,
    showCard = true,
  } = props;
  const host = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TwinEngine | null>(null);
  const cb = useRef(props);
  cb.current = props;
  const [mode, setMode] = useState<{ m: TwinRenderMode; reason: FallbackReason | null }>(() =>
    props.force2D
      ? { m: '2d', reason: 'forced' }
      : detectWebGL2()
        ? { m: '3d', reason: null }
        : { m: '2d', reason: 'no-webgl2' },
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const lostAt = useRef<number[]>([]);

  const to2D = (reason: FallbackReason) => setMode({ m: '2d', reason });

  useEffect(() => {
    if (props.force2D) to2D('forced');
    else if (mode.reason === 'forced')
      setMode(detectWebGL2() ? { m: '3d', reason: null } : { m: '2d', reason: 'no-webgl2' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.force2D]);

  useEffect(() => {
    cb.current.onModeChange?.(mode.m, mode.reason);
  }, [mode]);

  // 创建 / 销毁引擎
  useEffect(() => {
    if (mode.m !== '3d' || !host.current) return;
    let engine: TwinEngine;
    try {
      engine = new TwinEngine(host.current, {
        labels: (cb.current.labels ?? true) && !!cb.current.labelFont,
        labelFont: cb.current.labelFont,
        onPick: (id) => {
          setSelected(id);
          cb.current.onPick?.(id);
        },
        onPickRack: (k) => cb.current.onPickRack?.(k),
        onPickNothing: () => setSelected(null),
        onPerf: (r) => {
          cb.current.onPerf?.(r);
          if (r.suggest2D && (cb.current.autoFallback ?? true)) to2D('slow');
        },
        onStaleOccupancy: (v) => cb.current.onStaleOccupancy?.(v),
        onContextLost: () => {
          const now = Date.now();
          lostAt.current = [...lostAt.current.filter((t) => now - t < 60_000), now];
          if (lostAt.current.length >= 3 && (cb.current.autoFallback ?? true)) to2D('context-lost');
        },
      });
    } catch {
      to2D('init-failed');
      return;
    }
    engineRef.current = engine;
    setTick((t) => t + 1);
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [mode.m]);

  const engine = engineRef.current;
  useEffect(() => {
    if (engine && model) engine.setModel(model);
  }, [engine, model]);
  useEffect(() => {
    engine?.setColorMode(colorMode);
  }, [engine, colorMode]);
  useEffect(() => {
    if (engine && model) engine.setOccupancy(occupancy);
  }, [engine, model, occupancy]);
  useEffect(() => {
    engine?.setMaxLevel(maxLevel);
  }, [engine, maxLevel, model]);
  useEffect(() => {
    if (engine && model) engine.setHighlight(highlight ?? [], flyOnHighlight);
  }, [engine, model, highlight, flyOnHighlight]);
  const presetApplied = useRef(false);
  const hasModel = !!model;
  useEffect(() => {
    if (!engine || !hasModel || !cameraPreset) return;
    // 首次直接就位（首屏不做飞行动画），之后切换机位才飞行
    engine.setCameraPreset(cameraPreset, presetApplied.current);
    presetApplied.current = true;
    // 模型换版本时保持相机，不重复套用机位
  }, [engine, hasModel, cameraPreset]);
  useEffect(() => {
    if (engine && model && (props.startupBenchmark ?? true)) engine.startBenchmark();
    // 只在引擎首次拿到模型时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, !!model]);

  useImperativeHandle(
    props.ref,
    () => ({
      flyTo: (ids) => engineRef.current?.flyToLocations(ids),
      setCameraPreset: (p) => engineRef.current?.setCameraPreset(p),
      stats: () => engineRef.current?.renderNow() ?? null,
      rebuild: () => engineRef.current?.rebuild(),
      mode: () => mode.m,
      engine: () => engineRef.current,
    }),
    [mode.m],
  );

  const info = selected && engine ? engine.info(selected) : null;

  if (mode.m === '2d')
    return (
      <div
        style={{ position: 'relative', width: '100%', height: '100%', ...props.style }}
        className={props.className}
      >
        <Twin2DFallback
          model={model}
          occupancy={occupancy}
          colorMode={colorMode}
          highlight={highlight}
          onPick={props.onPick}
          onPickRack={props.onPickRack}
          maxLevel={maxLevel}
        />
        {showLegend && <Legend mode={colorMode} />}
        {mode.reason === 'slow' || mode.reason === 'context-lost' ? (
          <div
            style={{ ...card, top: 'auto', bottom: 12, left: 12, minWidth: 0 }}
            data-testid="twin-fallback-banner"
          >
            {mode.reason === 'slow'
              ? '3D 性能不足，已切换 2D 平面图'
              : '3D 渲染异常，已切换 2D 平面图'}{' '}
            <button onClick={() => setMode({ m: '3d', reason: null })}>仍用 3D</button>
          </div>
        ) : null}
      </div>
    );

  return (
    <div
      className={props.className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        ...props.style,
      }}
      data-twin-mode="3d"
    >
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {showLegend && <Legend mode={colorMode} />}
      {showCard && info && (
        <SelectionCard
          info={info}
          onClose={() => setSelected(null)}
          onFocus={() => engine?.flyToLocations([info.locationId])}
        />
      )}
    </div>
  );
}
