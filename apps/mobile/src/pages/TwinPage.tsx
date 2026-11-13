import { useEffect, useMemo, useRef, useState } from 'react';
import type { Occupancy, TwinModel } from '@wms3d/contracts';
import {
  TwinView,
  type FallbackReason,
  type TwinRenderMode,
  type TwinViewHandle,
} from '@wms3d/twin3d';
import { BigButton } from '@wms3d/ui';
import { useScanHandler } from '../app/hooks.ts';
import { getServices, useUi } from '../app/services.ts';

const REASON: Record<string, string> = {
  forced: '已切换为 2D 平面图',
  'no-webgl2': '设备不支持 WebGL2，使用 2D 平面图',
};

/**
 * 3D Tab（04 §6）：@wms3d/twin3d 的 <TwinView/>。Tab 不可见时整个组件卸载（停止渲染、释放 GPU 资源）；
 * WebGL2 检测、2s 启动基准、上下文丢失重建与自动降级 2D 由 twin3d 负责。查询页“在 3D 中查看”通过 highlight 联动飞行。
 */
export function TwinPage(props: { active: boolean }) {
  const svc = getServices();
  const highlight = useUi((s) => s.highlight);
  const labelCheck = useUi((s) => s.labelCheck);
  const session = useUi((s) => s.session);
  const online = useUi((s) => s.online);
  const [twin, setTwin] = useState<TwinModel | null>(null);
  const [occ, setOcc] = useState<Occupancy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [force2D, setForce2D] = useState(false);
  const [mode, setMode] = useState<{ m: TwinRenderMode; reason: FallbackReason | null } | null>(
    null,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [scanned, setScanned] = useState<string[]>([]);
  const [wrong, setWrong] = useState<{ raw: string; reason: string }[]>([]);
  const view = useRef<TwinViewHandle>(null);
  const whId = session?.warehouseId;

  useEffect(() => {
    if (!props.active || !whId) return;
    let alive = true;
    (async () => {
      try {
        const t = await svc.api.r.getTwin({ params: { id: whId } });
        if (!alive || !t) return;
        setTwin(t);
        setErr(null);
        const o = await svc.api.r.getOccupancy({
          params: { id: whId },
          query: { layoutVersion: t.layoutVersion },
        });
        if (alive && o) setOcc(o);
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.active, whId, svc]);

  const ids = useMemo(() => highlight?.locationIds ?? [], [highlight]);
  const pickedCode = useMemo(() => {
    if (!twin || !picked) return null;
    const i = twin.locations.id.indexOf(picked);
    return i >= 0 ? twin.locations.code[i] : null;
  }, [twin, picked]);

  const expectedIds = twin?.locations.id ?? [];
  const expectedCodes = twin?.locations.code ?? [];
  const scannedSet = new Set(scanned);
  const missing = expectedCodes
    .map((code, i) => ({ id: expectedIds[i]!, code }))
    .filter((x) => !scannedSet.has(x.id));
  const lit = labelCheck ? scanned : ids;
  const checkOcc = useMemo(() => {
    if (!labelCheck || !twin) return occ;
    const n = twin.locations.id.length;
    return {
      layoutVersion: twin.layoutVersion,
      asOf: new Date(0).toISOString(),
      qty: Array<number>(n).fill(0),
      skuCount: Array<number>(n).fill(0),
      fill: Array<number>(n).fill(0),
      isActive: Array(n).fill(1) as Array<0 | 1>,
      effectiveMax: Array<number | null>(n).fill(null),
    };
  }, [labelCheck, twin, occ]);

  useScanHandler((e) => {
    if (!labelCheck) return;
    const raw = e.text.trim();
    if (!svc.md) return;
    const r = svc.md.resolveLocal(raw);
    if (r.kind === 'LOCATION') {
      if (!expectedIds.includes(r.loc.id)) {
        setWrong((w) => [...w, { raw, reason: `不在本布局：${r.loc.code}` }]);
        return;
      }
      setScanned((s) => (s.includes(r.loc.id) ? s : [...s, r.loc.id]));
      view.current?.flyTo([r.loc.id]);
      return;
    }
    if (r.kind === 'WRONG_WAREHOUSE') {
      setWrong((w) => [...w, { raw, reason: `错仓${r.other ? `（${r.other}）` : ''}` }]);
      return;
    }
    setWrong((w) => [...w, { raw, reason: '无法识别或非仓位码' }]);
  }, props.active);

  if (!props.active) return null;
  return (
    <div className="twin-page" data-testid="twin-page" data-mode={mode?.m ?? ''}>
      <div className="twin-bar">
        {highlight ? (
          <span data-testid="twin-highlight">
            定位：{highlight.label}（{highlight.locationIds.length} 个仓位）
            <button
              type="button"
              className="link"
              onClick={() => useUi.setState({ highlight: null })}
            >
              清除
            </button>
          </span>
        ) : labelCheck ? (
          <span data-testid="label-check-progress">
            标签核对：已扫 {scanned.length} / {expectedIds.length}，漏贴 {missing.length}
          </span>
        ) : (
          <span className="muted">在“查询”中定位 SKU 后可在此高亮</span>
        )}
        <span className="twin-actions">
          {ids.length > 0 && !labelCheck && (
            <BigButton onClick={() => view.current?.flyTo(ids)}>定位</BigButton>
          )}
          <BigButton
            testId="twin-label-check"
            onClick={() => {
              const on = !labelCheck;
              useUi.setState({ labelCheck: on, highlight: on ? null : highlight });
              if (!on) {
                setScanned([]);
                setWrong([]);
              }
            }}
          >
            {labelCheck ? '退出核对' : '标签核对'}
          </BigButton>
          <BigButton testId="twin-2d" onClick={() => setForce2D((v) => !v)}>
            {force2D || mode?.m === '2d' ? '3D' : '2D'}
          </BigButton>
        </span>
      </div>
      {mode?.reason && mode.reason !== 'forced' && (
        <div className="hint">{REASON[mode.reason] ?? `已降级为 2D（${mode.reason}）`}</div>
      )}
      {!online && <div className="offline-note">离线：显示上次加载的布局</div>}
      {err && <div className="hint">{err}</div>}
      {pickedCode && (
        <div className="muted" data-testid="twin-picked">
          已选仓位 {pickedCode}
        </div>
      )}
      {labelCheck && (
        <div data-testid="label-check" className="page-pad" style={{ padding: '4px 8px' }}>
          <div data-testid="label-check-missing">
            漏贴（{missing.length}）：
            {missing.length
              ? missing
                  .slice(0, 40)
                  .map((m) => m.code)
                  .join('、')
              : '无'}
            {missing.length > 40 ? '…' : ''}
          </div>
          <div data-testid="label-check-wrong">
            错贴（{wrong.length}）：
            {wrong.length ? wrong.map((w) => `${w.raw}（${w.reason}）`).join('；') : '无'}
          </div>
        </div>
      )}
      <TwinView
        ref={view}
        className="twin-view"
        model={twin}
        occupancy={checkOcc}
        highlight={lit}
        cameraPreset="iso"
        force2D={force2D}
        labels={false}
        onPick={setPicked}
        onModeChange={(m, reason) => setMode({ m, reason })}
        onStaleOccupancy={() => setOcc(null)}
      />
    </div>
  );
}
