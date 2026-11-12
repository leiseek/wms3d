// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- 环境声明文件只能用 reference 引入
/// <reference path="../../../../../../packages/twin3d/src/troika.d.ts" />
// ↑ twin3d 的 troika 环境声明不在 admin tsconfig 的 include 内（见 docs/contract-requests/ws-d1-1.md）
import { useDeferredValue, useMemo } from 'react';
import type { LayoutDoc, TwinModel } from '@wms3d/contracts';
import { expandLayout } from '@wms3d/domain';
import { TwinView } from '@wms3d/twin3d';

/**
 * 3D 预览分屏（05 §2.1，M4.5）：草稿文档本地展开为 TwinModel（id = `draft:<code>`，不调后端），交给 WS-D2 的 TwinView；
 * 2D 选中 ↔ 3D 高亮联动，3D 点选回传货架。WebGL 不可用时 TwinView 自动降级 2D。
 */
export default function TwinPreview(p: {
  doc: LayoutDoc;
  pattern: string;
  warehouseId: string;
  warehouseCode: string;
  selectedRackKeys: string[];
  onPickRack(key: string): void;
}) {
  const doc = useDeferredValue(p.doc);
  const model = useMemo<TwinModel | null>(() => {
    try {
      const { locations } = expandLayout(doc, p.pattern);
      return {
        warehouseId: p.warehouseId,
        warehouseCode: p.warehouseCode,
        layoutVersion: 0,
        layout: doc,
        locations: {
          id: locations.map((l) => `draft:${l.code}`),
          code: locations.map((l) => l.code),
          rackKey: locations.map((l) => l.rackKey),
          rackBayIndex: locations.map((l) => l.rackBayIndex),
          level: locations.map((l) => l.level),
          pos: locations.map((l) => l.position),
        },
      };
    } catch {
      return null;
    }
  }, [doc, p.pattern, p.warehouseId, p.warehouseCode]);
  const rackOf = useMemo(() => {
    const m = new Map<string, string>();
    if (model)
      model.locations.id.forEach(
        (id, i) => model.locations.rackKey[i] && m.set(id, model.locations.rackKey[i]!),
      );
    return m;
  }, [model]);
  const highlight = useMemo(() => {
    if (!model || !p.selectedRackKeys.length) return [];
    const ks = new Set(p.selectedRackKeys);
    return model.locations.id.filter((_, i) => ks.has(model.locations.rackKey[i] ?? ''));
  }, [model, p.selectedRackKeys]);
  if (!model) return <div style={{ padding: 12 }}>布局有编码错误，暂无法预览 3D</div>;
  return (
    <TwinView
      model={model}
      occupancy={null}
      highlight={highlight}
      flyOnHighlight={false}
      labels={false}
      showCard={false}
      startupBenchmark={false}
      onPick={(id) => {
        const k = rackOf.get(id);
        if (k) p.onPickRack(k);
      }}
      onPickRack={p.onPickRack}
      style={{ width: '100%', height: '100%' }}
    />
  );
}
