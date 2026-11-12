import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, InputNumber, Space, Tag, Tooltip, Typography, message } from 'antd';
import type { LayoutDoc, LayoutRack, Location } from '@wms3d/contracts';
import { bayNumber, compilePattern, deriveSide, rackCode } from '@wms3d/domain';
import { typeOf } from '../model/ops';
import type { LayoutApi } from '../model/layoutApi';

/**
 * 立面视图（05 §2.1）：选中货架的 bays × levels 网格（面对取货面从左到右，最底层 A 在下），显示仓位编码 = 仓位生成预览。
 * 已发布货架：多选后批量停用/启用/设置容量——运行时属性，直接 PATCH locations/bulk，不进布局版本。
 */
export function ElevationView(p: {
  doc: LayoutDoc;
  rack: LayoutRack;
  pattern: string;
  /** 该货架在已发布布局中的货架码（未发布/编码已变 → null，只读预览） */
  publishedRackCode: string | null;
  api: LayoutApi;
  canEdit: boolean;
}) {
  const { doc, rack: r } = p;
  const t = typeOf(doc, r);
  const side = deriveSide(r.rotationDeg);
  const [locs, setLocs] = useState<Map<string, Location>>(new Map());
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [cap, setCap] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const cells = useMemo(() => {
    if (!t) return null;
    try {
      const pat = compilePattern(p.pattern);
      return Array.from({ length: t.levels }, (_, li) => {
        const level = t.levels - li;
        return Array.from({ length: t.bays }, (_, i) => {
          const bay = bayNumber(side, r.bayStart, t.bays, i);
          return {
            bay,
            codes: Array.from({ length: t.positionsPerLevel }, (_, k) =>
              pat.format({ zone: r.zone, aisle: r.aisle, bay, level, position: k + 1, side }),
            ),
          };
        });
      });
    } catch {
      return null;
    }
  }, [t, p.pattern, side, r.bayStart, r.zone, r.aisle]);

  const load = useCallback(async () => {
    if (!p.publishedRackCode) return setLocs(new Map());
    try {
      const res = await p.api.locationsOfRack(p.publishedRackCode);
      setLocs(new Map(res.items.map((l) => [l.code, l])));
    } catch {
      setLocs(new Map());
    }
  }, [p.api, p.publishedRackCode]);
  useEffect(() => {
    void load();
    setSel(new Set());
  }, [load]);

  if (!t) return <Alert type="error" title={`模板 ${r.type} 不存在`} />;
  if (!cells) return <Alert type="error" title="编码超出模式，无法生成仓位" />;
  let rc: string;
  try {
    rc = rackCode(r.zone, r.aisle, side, r.rackNo);
  } catch {
    rc = r.key;
  }
  const published = locs.size > 0;
  const patch = async (q: { isActive?: boolean; maxQty?: number | null }) => {
    const ids = [...sel].map((c) => locs.get(c)?.id).filter((x): x is string => !!x);
    if (!ids.length) return;
    setBusy(true);
    try {
      const res = await p.api.bulkPatch(ids, q);
      void message.success(
        `已更新 ${res.updated} 个仓位${res.failed.length ? `，${res.failed.length} 个失败` : ''}`,
      );
      await load();
    } catch (e) {
      void message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (code: string) => {
    const n = new Set(sel);
    if (n.has(code)) n.delete(code);
    else n.add(code);
    setSel(n);
  };

  return (
    <div data-testid="elevation">
      <Space style={{ marginBottom: 6 }} wrap>
        <Typography.Text strong>立面 {rc}</Typography.Text>
        <Tag>{published ? '已发布：可改运行时属性' : '预览（发布后生成仓位）'}</Tag>
        {published && p.canEdit && (
          <>
            <Button
              size="small"
              disabled={!sel.size || busy}
              onClick={() => void patch({ isActive: false })}
            >
              停用
            </Button>
            <Button
              size="small"
              disabled={!sel.size || busy}
              onClick={() => void patch({ isActive: true })}
            >
              启用
            </Button>
            <InputNumber
              size="small"
              min={1}
              placeholder="容量"
              value={cap}
              onChange={(v) => setCap(typeof v === 'number' ? v : null)}
              style={{ width: 90 }}
            />
            <Button
              size="small"
              disabled={!sel.size || busy}
              onClick={() => void patch({ maxQty: cap })}
            >
              设置容量
            </Button>
          </>
        )}
      </Space>
      <div style={{ overflow: 'auto', maxHeight: 260 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th />
              {cells[0]!.map((c) => (
                <th
                  key={c.bay}
                  style={{ padding: '2px 6px', color: c.bay % 2 ? '#1677ff' : '#722ed1' }}
                >
                  bay {String(c.bay).padStart(2, '0')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, li) => (
              <tr key={li}>
                <th style={{ padding: '2px 6px' }}>{String.fromCharCode(64 + t.levels - li)}</th>
                {row.map((c) => (
                  <td
                    key={c.bay}
                    style={{ border: '1px solid #d9d9d9', padding: 2, verticalAlign: 'top' }}
                  >
                    <div style={{ display: 'flex', gap: 2 }}>
                      {c.codes.map((code) => {
                        const l = locs.get(code);
                        const on = sel.has(code);
                        return (
                          <Tooltip
                            key={code}
                            title={
                              l
                                ? `${l.isActive ? '启用' : '停用'} · 容量 ${l.effectiveMax ?? '不限'}`
                                : '未发布'
                            }
                          >
                            <div
                              onClick={() => published && toggle(code)}
                              data-testid={`cell-${code}`}
                              style={{
                                padding: '2px 4px',
                                borderRadius: 3,
                                cursor: published ? 'pointer' : 'default',
                                background: on
                                  ? '#bae0ff'
                                  : l && !l.isActive
                                    ? '#f0f0f0'
                                    : '#fafafa',
                                color: l && !l.isActive ? '#bfbfbf' : '#262626',
                                textDecoration: l && !l.isActive ? 'line-through' : 'none',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {code}
                              {l?.maxQty ? <sup> {l.maxQty}</sup> : null}
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
