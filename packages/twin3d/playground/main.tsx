import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Occupancy, TwinModel } from '@wms3d/contracts';
import {
  TwinView,
  createOccupancySync,
  type CameraPreset,
  type ColorMode,
  type PerfReport,
  type TwinViewHandle,
} from '../src/index.ts';
import { benchTwinModel, syntheticOccupancy } from '../src/fixtures.ts';
import { createMockSession, type MockSession } from './mockData.ts';

/**
 * twin3d playground：
 *   ?data=mock（默认，进程内契约 mock）| bench5k | bench20k
 *   &preset=top|iso|aisle &mode=occupancy|skuCount|zone &locate=<SKU> &force2d=1
 *   &bench=1（基准模式：关自动降级与启动基准，暴露 window.__twin） &ui=0（隐藏工具栏）
 */
const qs = new URLSearchParams(location.search);
const dataSrc = qs.get('data') ?? 'mock';
const isBench = qs.get('bench') === '1';
const showUi = qs.get('ui') !== '0';
const t0 = performance.now();

declare global {
  interface Window {
    __twin?: {
      ready: boolean;
      handle: TwinViewHandle | null;
      model: TwinModel | null;
      dataReadyAt: number | null;
      locateMs: number | null;
      perf: PerfReport[];
      mode: string | null;
      session: MockSession | null;
      setHighlight(ids: string[]): void;
      setPreset(p: CameraPreset): void;
      setColorMode(m: ColorMode): void;
      setMaxLevel(n: number | undefined): void;
      setModel(m: TwinModel): void;
      setOcc(o: Occupancy | null): void;
      occ: Occupancy | null;
      picks: string[];
      staleCalls: number;
    };
  }
}
window.__twin = {
  ready: false,
  handle: null,
  model: null,
  dataReadyAt: null,
  locateMs: null,
  perf: [],
  mode: null,
  session: null,
  setHighlight: () => {},
  setPreset: () => {},
  setColorMode: () => {},
  setMaxLevel: () => {},
  setModel: () => {},
  setOcc: () => {},
  occ: null,
  picks: [],
  staleCalls: 0,
};

const bar: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
  padding: '6px 8px',
  background: '#fff',
  borderBottom: '1px solid #e5e7eb',
  fontSize: 13,
};

function App() {
  const [model, setModel] = useState<TwinModel | null>(null);
  const [occ, setOcc] = useState<Occupancy | null>(null);
  const [mode, setMode] = useState<ColorMode>((qs.get('mode') as ColorMode) ?? 'occupancy');
  const [preset, setPreset] = useState<CameraPreset | undefined>(
    (qs.get('preset') as CameraPreset) ?? undefined,
  );
  const [highlight, setHighlight] = useState<string[]>([]);
  const [maxLevel, setMaxLevel] = useState<number | undefined>(undefined);
  const [q, setQ] = useState(qs.get('locate') ?? '');
  const [msg, setMsg] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const session = useRef<MockSession | null>(null);
  const handle = useRef<TwinViewHandle | null>(null);
  const modelRef = useRef<TwinModel | null>(null);
  modelRef.current = model;

  const loadTwin = useCallback(async () => {
    const s = session.current!;
    const m = await s.getTwin();
    setModel(m);
    const o = await s.getOccupancy(m.layoutVersion);
    if (o) setOcc(o);
    window.__twin!.model = m;
    window.__twin!.dataReadyAt = performance.now();
  }, []);

  useEffect(() => {
    let off = () => {};
    let cancelled = false;
    let sync: ReturnType<typeof createOccupancySync> | null = null;
    (async () => {
      if (dataSrc.startsWith('bench')) {
        const m = benchTwinModel(dataSrc === 'bench20k' ? 40 : 10);
        setModel(m);
        setOcc(syntheticOccupancy(m));
        window.__twin!.model = m;
        window.__twin!.dataReadyAt = performance.now();
        return;
      }
      const s = await createMockSession();
      if (cancelled) return;
      session.current = s;
      window.__twin!.session = s;
      await loadTwin();
      sync = createOccupancySync({
        getLayoutVersion: () => modelRef.current?.layoutVersion ?? null,
        fetchOccupancy: (v) => s.getOccupancy(v),
        onOccupancy: setOcc,
        reloadTwin: () => {
          setMsg('布局已更新，重新加载');
          void loadTwin();
        },
        platform: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'pc',
      });
      off = s.subscribe((e) => sync?.handleEvent(e));
      sync.onConnected();
      const initial = qs.get('locate');
      if (initial) void doLocate(initial);
    })().catch((e) => setMsg(String(e)));
    return () => {
      cancelled = true;
      off();
      sync?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doLocate = async (query: string) => {
    const s = session.current;
    if (!s || !query) return;
    const t = performance.now();
    const r = await s.locate(query);
    if (r.layoutVersion !== modelRef.current?.layoutVersion) await loadTwin();
    setHighlight(r.locationIds);
    setMsg(r.locationIds.length ? `找到 ${r.locationIds.length} 个仓位` : '无库存');
    requestAnimationFrame(() => {
      const eng = handle.current?.engine();
      const started = eng?.flightStartedAt ?? null;
      window.__twin!.locateMs = started && started >= t ? started - t : performance.now() - t;
    });
  };

  useEffect(() => {
    const w = window.__twin!;
    w.setHighlight = setHighlight;
    w.setPreset = setPreset;
    w.setColorMode = setMode;
    w.setMaxLevel = setMaxLevel;
    w.setModel = (m) => {
      w.model = m;
      setModel(m);
    };
    w.setOcc = setOcc;
  }, []);
  useEffect(() => {
    window.__twin!.occ = occ;
  }, [occ]);

  const occupiedIds = useMemo(() => {
    if (!model || !occ) return { empty: [] as number[], used: [] as number[] };
    const empty: number[] = [];
    const used: number[] = [];
    occ.qty.forEach((v, i) => (model.locations.rackKey[i] ? (v > 0 ? used : empty).push(i) : 0));
    return { empty, used };
  }, [model, occ]);

  const simulate = async (kind: 'in' | 'out' | 'off') => {
    const s = session.current;
    if (!s || !model) return;
    try {
      if (kind === 'in') {
        const i = occupiedIds.empty[Math.floor(Math.random() * occupiedIds.empty.length)]!;
        await s.inbound(model.locations.code[i]!, 20 + Math.floor(Math.random() * 150));
        setMsg(`入库 → ${model.locations.code[i]}`);
      } else if (kind === 'out') {
        const i = occupiedIds.used[Math.floor(Math.random() * occupiedIds.used.length)]!;
        await s.outboundAll(model.locations.id[i]!);
        setMsg(`清空出库 ← ${model.locations.code[i]}`);
      } else {
        const i = occupiedIds.empty[Math.floor(Math.random() * occupiedIds.empty.length)]!;
        await s.setActive(model.locations.id[i]!, false);
        setMsg(`停用 ${model.locations.code[i]}`);
      }
    } catch (e) {
      setMsg(String(e));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {showUi && (
        <div style={bar}>
          <b>twin3d</b>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void doLocate(q);
            }}
            style={{ display: 'flex', gap: 4 }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="SKU 编码/名称/条码"
              size={14}
              data-testid="locate-input"
            />
            <button type="submit">定位</button>
            <button type="button" onClick={() => setHighlight([])}>
              清除
            </button>
          </form>
          {(['top', 'iso', 'aisle'] as const).map((p) => (
            <button
              key={p}
              onClick={() => (setPreset(undefined), requestAnimationFrame(() => setPreset(p)))}
            >
              {{ top: '俯视', iso: '等轴', aisle: '巷道' }[p]}
            </button>
          ))}
          <select value={mode} onChange={(e) => setMode(e.target.value as ColorMode)}>
            <option value="occupancy">占用</option>
            <option value="skuCount">SKU 数</option>
            <option value="zone">库区</option>
          </select>
          <label>
            层≤
            <select
              value={maxLevel ?? ''}
              onChange={(e) => setMaxLevel(e.target.value ? Number(e.target.value) : undefined)}
            >
              <option value="">全部</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {dataSrc === 'mock' && (
            <>
              <button onClick={() => void simulate('in')}>模拟入库</button>
              <button onClick={() => void simulate('out')}>模拟出库</button>
              <button onClick={() => void simulate('off')}>停用空仓位</button>
            </>
          )}
          <span style={{ color: '#6b7280' }}>{msg}</span>
          {picked && <span data-testid="picked">选中 {picked}</span>}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <TwinView
          ref={(h) => {
            handle.current = h;
            window.__twin!.handle = h;
            window.__twin!.ready = !!h;
          }}
          model={model}
          occupancy={occ}
          colorMode={mode}
          highlight={highlight}
          cameraPreset={preset}
          maxLevel={maxLevel}
          labelFont="./fonts/label.ttf"
          force2D={qs.get('force2d') === '1'}
          autoFallback={!isBench && qs.get('fallback') !== 'off'}
          startupBenchmark={!isBench}
          onPick={(id) => {
            window.__twin!.picks.push(id);
            setPicked(model?.locations.code[model.locations.id.indexOf(id)] ?? id);
          }}
          onPickRack={(k) => {
            window.__twin!.picks.push(`rack:${k}`);
            setPicked(`货架 ${k}`);
          }}
          onPerf={(r) => window.__twin!.perf.push(r)}
          onModeChange={(m, reason) => {
            window.__twin!.mode = m;
            if (reason && reason !== 'forced') setMsg(`2D 降级：${reason}`);
          }}
          onStaleOccupancy={() => {
            window.__twin!.staleCalls++;
            if (session.current) void loadTwin();
          }}
        />
      </div>
    </div>
  );
}

void t0;
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
