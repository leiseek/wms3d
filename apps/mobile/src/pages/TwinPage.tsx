import { useEffect, useMemo, useState } from 'react';
import type { TwinModel } from '@wms3d/contracts';
import { getServices, useUi } from '../app/services.ts';

/**
 * 3D Tab 占位（本地 shim）：WS-D2 的 twin3d v0 合并前，用 TwinModel 画俯视 2D 平面（货架 × 列），
 * 高亮定位结果。接口按 twin3d 预期（TwinModel + locationId→index），合并后替换为 <Twin3D/>。
 * 04 §6：Tab 不可见时不渲染（此占位为静态 SVG，无渲染循环）。
 */
export function TwinPage(props: { active: boolean }) {
  const svc = getServices();
  const highlight = useUi((s) => s.highlight);
  const session = useUi((s) => s.session);
  const [twin, setTwin] = useState<TwinModel | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!props.active || !session || twin?.warehouseId === session.warehouseId) return;
    svc.api.r
      .getTwin({ params: { id: session.warehouseId } })
      .then((t) => t && setTwin(t))
      .catch((e: Error) => setErr(e.message));
  }, [props.active, session, svc, twin?.warehouseId]);

  const racks = useMemo(() => {
    if (!twin) return [];
    const m = new Map<string, { bays: Map<number, string[]> }>();
    const L = twin.locations;
    for (let i = 0; i < L.id.length; i++) {
      const key = L.rackKey[i] ?? '地面';
      const bay = L.rackBayIndex[i] ?? 0;
      const r = m.get(key) ?? { bays: new Map() };
      r.bays.set(bay, [...(r.bays.get(bay) ?? []), L.id[i]!]);
      m.set(key, r);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [twin]);

  const hi = new Set(highlight?.locationIds ?? []);
  if (!props.active) return null;
  const cell = 22;
  const maxBays = Math.max(1, ...racks.map(([, r]) => Math.max(...r.bays.keys()) + 1));
  return (
    <div className="page-pad" data-testid="twin-page">
      <div className="twin-banner">
        3D 视图占位：twin3d v0 合并后替换为三维孪生（当前为俯视平面）
      </div>
      {highlight && (
        <div className="hint" data-testid="twin-highlight">
          定位：{highlight.label}（{highlight.locationIds.length} 个仓位高亮）
          <button
            type="button"
            className="link"
            onClick={() => useUi.setState({ highlight: null })}
          >
            清除
          </button>
        </div>
      )}
      {err && <div className="hint">{err}</div>}
      {!twin && !err && <div className="muted">加载布局…</div>}
      {twin && (
        <svg
          className="twin-svg"
          viewBox={`0 0 ${90 + maxBays * cell} ${racks.length * (cell + 8) + 10}`}
          data-testid="twin-svg"
        >
          {racks.map(([key, r], ri) => (
            <g key={key} transform={`translate(0 ${ri * (cell + 8) + 5})`}>
              <text x={4} y={cell * 0.7} fontSize={11}>
                {key}
              </text>
              {[...r.bays.entries()].map(([bay, ids]) => {
                const on = ids.some((id) => hi.has(id));
                return (
                  <rect
                    key={bay}
                    x={86 + bay * cell}
                    y={0}
                    width={cell - 3}
                    height={cell}
                    rx={3}
                    className={on ? 'bay bay-hi' : 'bay'}
                    data-hi={on ? '1' : undefined}
                  />
                );
              })}
            </g>
          ))}
        </svg>
      )}
    </div>
  );
}
