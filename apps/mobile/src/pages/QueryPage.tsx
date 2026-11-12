import { useState } from 'react';
import { AppKeyboard, BigButton } from '@wms3d/ui';
import type { ScanEvent } from '@wms3d/scanner';
import { useScanHandler } from '../app/hooks.ts';
import { getServices, useUi } from '../app/services.ts';

interface LocResult {
  kind: 'location';
  code: string;
  locationId: string;
  isActive: boolean;
  items: { skuCode: string; skuName: string; onHand: number }[];
}
interface SkuResult {
  kind: 'sku';
  query: string;
  skus: { id: string; code: string; name: string }[];
  items: { locationId: string; code: string; qty: number; skuId: string }[];
  total: number;
}
type Result = LocResult | SkuResult | { kind: 'msg'; text: string };

/** 查询/定位（04 §3.5）：扫任意码 → 仓位明细 / SKU 所在仓位 + “在 3D 中查看” */
export function QueryPage(props: { active: boolean }) {
  const svc = getServices();
  const online = useUi((s) => s.online);
  const [q, setQ] = useState('');
  const [kb, setKb] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  const run = async (text: string) => {
    const s = svc.session.current;
    if (!s || !svc.md) return;
    setBusy(true);
    try {
      const r = svc.md.resolveLocal(text);
      if (!useUi.getState().online) {
        setRes({
          kind: 'msg',
          text:
            r.kind === 'LOCATION'
              ? `离线：仓位 ${r.loc.code}（${r.loc.isActive ? '启用' : '停用'}），实时库存需联网查询`
              : r.kind === 'SKU'
                ? `离线：SKU ${r.sku.code} ${r.sku.name}，所在仓位需联网查询`
                : '离线：无法查询',
        });
        return;
      }
      if (r.kind === 'LOCATION') {
        const p = await svc.api.r.listBalances({
          query: { warehouseId: s.warehouseId, locationId: r.loc.id, limit: 200 },
        });
        setRes({
          kind: 'location',
          code: r.loc.code,
          locationId: r.loc.id,
          isActive: r.loc.isActive,
          items: p.items.map((b) => ({ skuCode: b.skuCode, skuName: b.skuName, onHand: b.onHand })),
        });
        return;
      }
      if (r.kind === 'WRONG_WAREHOUSE' || r.kind === 'RACK') {
        setRes({
          kind: 'msg',
          text:
            r.kind === 'RACK'
              ? `货架码 ${r.rackCode}：请扫仓位或 SKU`
              : `不是本仓库的条码（${r.other ?? ''}）`,
        });
        return;
      }
      const term = r.kind === 'SKU' ? r.sku.code : text.trim();
      const loc = await svc.api.r.locate({ query: { warehouseId: s.warehouseId, q: term } });
      setRes({
        kind: 'sku',
        query: term,
        skus: loc.skus,
        items: [...loc.items].sort((a, b) => a.code.localeCompare(b.code)),
        total: loc.items.reduce((n, i) => n + i.qty, 0),
      });
    } catch (e) {
      setRes({ kind: 'msg', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  useScanHandler(async (e: ScanEvent) => {
    setQ(e.text);
    await run(e.text);
  }, props.active);

  const showIn3d = (ids: string[], label: string) =>
    useUi.setState({ highlight: { locationIds: ids, label }, tab: 'twin' });

  return (
    <div className="page-pad" data-testid="query-page">
      <div className="prompt">扫仓位码 / SKU 条码，或输入 SKU 编码、名称</div>
      <div className="query-row">
        <input
          className="query-input"
          data-testid="query-input"
          inputMode="none"
          value={q}
          placeholder="SKU 编码 / 名称 / 条码"
          onFocus={() => setKb(true)}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run(q)}
        />
        <BigButton
          kind="primary"
          testId="query-go"
          disabled={!q || busy}
          onClick={() => void run(q)}
        >
          查询
        </BigButton>
      </div>
      {kb && (
        <AppKeyboard
          value={q}
          onChange={setQ}
          onOk={() => {
            setKb(false);
            void run(q);
          }}
        />
      )}
      {!online && <div className="offline-note">离线：只能识别条码，库存需联网</div>}
      {res?.kind === 'msg' && <div className="hint">{res.text}</div>}
      {res?.kind === 'location' && (
        <div className="result" data-testid="location-result">
          <h3>
            仓位 {res.code} {res.isActive ? '' : '（已停用）'}
          </h3>
          {res.items.length === 0 ? (
            <div className="muted">空仓位</div>
          ) : (
            <table className="tbl">
              <tbody>
                {res.items.map((i) => (
                  <tr key={i.skuCode}>
                    <td>{i.skuCode}</td>
                    <td>{i.skuName}</td>
                    <td className="num">{i.onHand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <BigButton testId="loc-3d" onClick={() => showIn3d([res.locationId], `仓位 ${res.code}`)}>
            在 3D 中查看
          </BigButton>
        </div>
      )}
      {res?.kind === 'sku' && (
        <div className="result" data-testid="locate-result">
          <h3>
            {res.skus.map((s) => `${s.code} ${s.name}`).join('、') || `“${res.query}”无匹配 SKU`}
          </h3>
          <div className="muted" data-testid="locate-total">
            共 {res.items.length} 个仓位，合计 {res.total} 件
          </div>
          <table className="tbl">
            <tbody>
              {res.items.map((i) => (
                <tr key={`${i.locationId}-${i.skuId}`} data-testid="locate-row">
                  <td className="mono">{i.code}</td>
                  <td>{res.skus.find((s) => s.id === i.skuId)?.code}</td>
                  <td className="num">{i.qty}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {res.items.length > 0 && (
            <BigButton
              kind="primary"
              testId="locate-3d"
              onClick={() => showIn3d([...new Set(res.items.map((i) => i.locationId))], res.query)}
            >
              在 3D 中查看
            </BigButton>
          )}
        </div>
      )}
    </div>
  );
}
