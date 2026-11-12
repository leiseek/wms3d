import { useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Divider,
  Popconfirm,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { LayoutDoc, LayoutRack, ZoneKind } from '@wms3d/contracts';
import { deriveSide, rackLengthM } from '@wms3d/domain';
import { rackCodePreview, typeOf } from '../model/ops';
import type { Selection } from '../model/history';
import { NumField, TextField } from './fields';

export interface PropertiesActions {
  patchRack(key: string, patch: Partial<LayoutRack>): void;
  rotate(keys: string[]): void;
  remove(keys: string[]): void;
  arrayCopy(key: string, count: number, gapM: number): void;
  renumber(zone: string, aisle: number): void;
  patchZone(
    code: string,
    patch: { code?: string; name?: string; kind?: ZoneKind; color?: string },
  ): void;
  removeZone(code: string): void;
  removeFloor(code: string): void;
  patchWarehouse(patch: Partial<LayoutDoc['warehouse']>): void;
  setAisle(keys: string[], aisle: number): void;
}

const KINDS: ZoneKind[] = ['STORAGE', 'RECEIVING', 'SHIPPING', 'QC'];
const KIND_LABEL: Record<ZoneKind, string> = {
  STORAGE: '存储',
  RECEIVING: '收货',
  SHIPPING: '发货',
  QC: '质检',
};

export function PropertiesPanel(p: {
  doc: LayoutDoc;
  selection: Selection;
  pattern: string;
  actions: PropertiesActions;
  readOnly?: boolean;
}) {
  const { doc, selection: s, actions: a } = p;
  if (s.kind === 'racks' && s.keys.length === 1) {
    const r = doc.racks.find((x) => x.key === s.keys[0]);
    if (r) return <RackProps doc={doc} rack={r} pattern={p.pattern} a={a} />;
  }
  if (s.kind === 'racks' && s.keys.length > 1) return <MultiProps keys={s.keys} a={a} />;
  if (s.kind === 'zone') {
    const z = doc.zones.find((x) => x.code === s.code);
    if (z)
      return (
        <div data-testid="zone-props">
          <Typography.Title level={5}>库区 {z.code}</Typography.Title>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="编码">
              <TextField
                value={z.code}
                upper
                maxLength={4}
                onCommit={(v) => /^[A-Z][A-Z0-9]{0,3}$/.test(v) && a.patchZone(z.code, { code: v })}
                testId="zone-code"
              />
            </Descriptions.Item>
            <Descriptions.Item label="名称">
              <TextField
                value={z.name ?? ''}
                maxLength={64}
                onCommit={(v) => a.patchZone(z.code, { name: v })}
              />
            </Descriptions.Item>
            <Descriptions.Item label="类型">
              <Select
                size="small"
                style={{ width: '100%' }}
                value={z.kind}
                options={KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                onChange={(v) => a.patchZone(z.code, { kind: v })}
              />
            </Descriptions.Item>
            <Descriptions.Item label="顶点">{z.polygon.length} 个</Descriptions.Item>
            <Descriptions.Item label="货架">
              {doc.racks.filter((r) => r.zone === z.code).length} 个
            </Descriptions.Item>
          </Descriptions>
          <Popconfirm
            title={'删除库区？库区内的货架会报「库区不存在」'}
            onConfirm={() => a.removeZone(z.code)}
          >
            <Button danger size="small" style={{ marginTop: 8 }}>
              删除库区
            </Button>
          </Popconfirm>
        </div>
      );
  }
  if (s.kind === 'floor') {
    const f = doc.floorAreas.find((x) => x.locationCode === s.code);
    if (f)
      return (
        <div>
          <Typography.Title level={5}>地面功能区 {f.locationCode}</Typography.Title>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="库区">{f.zone}</Descriptions.Item>
            <Descriptions.Item label="仓位码">{f.locationCode}</Descriptions.Item>
          </Descriptions>
          <Button
            danger
            size="small"
            style={{ marginTop: 8 }}
            onClick={() => a.removeFloor(f.locationCode)}
          >
            删除
          </Button>
        </div>
      );
  }
  const w = doc.warehouse;
  return (
    <div data-testid="doc-props">
      <Typography.Title level={5}>仓库平面</Typography.Title>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="宽 (X)">
          <NumField
            value={w.widthM}
            min={1}
            max={2000}
            step={1}
            suffix="m"
            onCommit={(v) => a.patchWarehouse({ widthM: v })}
          />
        </Descriptions.Item>
        <Descriptions.Item label="深 (Z)">
          <NumField
            value={w.depthM}
            min={1}
            max={2000}
            step={1}
            suffix="m"
            onCommit={(v) => a.patchWarehouse({ depthM: v })}
          />
        </Descriptions.Item>
        <Descriptions.Item label="高">
          <NumField
            value={w.heightM}
            min={1}
            max={60}
            step={0.5}
            suffix="m"
            onCommit={(v) => a.patchWarehouse({ heightM: v })}
          />
        </Descriptions.Item>
        <Descriptions.Item label="库区 / 货架">
          {doc.zones.length} / {doc.racks.length}
        </Descriptions.Item>
        <Descriptions.Item label="编码模式">
          <Typography.Text code>{p.pattern}</Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, fontSize: 12 }}>
        坐标：原点左上，+X 向右、+Z 向下（米）；旋转俯视顺时针。点选货架编辑属性，R 旋转，Delete
        删除，Ctrl+Z / Ctrl+Shift+Z 撤销重做，Shift 拖动关闭吸附。
      </Typography.Paragraph>
    </div>
  );
}

function MultiProps({ keys, a }: { keys: string[]; a: PropertiesActions }) {
  const [aisle, setAisle] = useState(1);
  return (
    <div>
      <Typography.Title level={5}>已选 {keys.length} 个货架</Typography.Title>
      <Space orientation="vertical" style={{ width: '100%' }}>
        <Space.Compact style={{ width: '100%' }}>
          <NumField value={aisle} min={1} max={99} onCommit={setAisle} />
          <Button size="small" onClick={() => a.setAisle(keys, aisle)}>
            批量设置巷道
          </Button>
        </Space.Compact>
        <Button size="small" onClick={() => a.rotate(keys)}>
          全部旋转 90°
        </Button>
        <Button size="small" danger onClick={() => a.remove(keys)}>
          删除所选
        </Button>
      </Space>
    </div>
  );
}

function RackProps({
  doc,
  rack: r,
  pattern,
  a,
}: {
  doc: LayoutDoc;
  rack: LayoutRack;
  pattern: string;
  a: PropertiesActions;
}) {
  const t = typeOf(doc, r);
  const pv = rackCodePreview(doc, r, pattern);
  const side = deriveSide(r.rotationDeg);
  const [count, setCount] = useState(3);
  const [gap, setGap] = useState(0);
  return (
    <div data-testid="rack-props">
      <Typography.Title level={5} style={{ marginBottom: 4 }}>
        货架 <span data-testid="rack-code">{pv.rackCode || r.key}</span>{' '}
        <Tag color={side === 'L' ? 'blue' : 'purple'}>
          {side === 'L' ? '左侧 L（奇数）' : '右侧 R（偶数）'}
        </Tag>
      </Typography.Title>
      {pv.error ? (
        <Alert
          type="error"
          showIcon
          title={`编码预览失败：${pv.error}`}
          data-testid="code-preview-error"
        />
      ) : (
        <Alert
          type="info"
          title={
            <span>
              仓位码{' '}
              <Typography.Text strong data-testid="code-range">
                {pv.range}
              </Typography.Text>
              （{pv.count} 个）
            </span>
          }
          description={<span style={{ fontSize: 12 }}>bay {pv.bays.join('、')}</span>}
        />
      )}
      <Descriptions size="small" column={1} bordered style={{ marginTop: 8 }}>
        <Descriptions.Item label="库区">
          <Select
            size="small"
            style={{ width: '100%' }}
            value={r.zone}
            options={doc.zones.map((z) => ({ value: z.code, label: z.code }))}
            onChange={(v) => a.patchRack(r.key, { zone: v })}
          />
        </Descriptions.Item>
        <Descriptions.Item label="巷道 aisle">
          <NumField
            value={r.aisle}
            min={1}
            max={99}
            onCommit={(v) => a.patchRack(r.key, { aisle: v })}
            testId="rack-aisle"
          />
        </Descriptions.Item>
        <Descriptions.Item label="货架号 rackNo">
          <NumField
            value={r.rackNo}
            min={1}
            max={99}
            onCommit={(v) => a.patchRack(r.key, { rackNo: v })}
            testId="rack-no"
          />
        </Descriptions.Item>
        <Descriptions.Item
          label={<Tooltip title="靠行进起点一端的巷道级 bay 号；L 奇 R 偶">bayStart</Tooltip>}
        >
          <NumField
            value={r.bayStart}
            min={1}
            max={999}
            step={2}
            onCommit={(v) => a.patchRack(r.key, { bayStart: v })}
            testId="rack-baystart"
          />
        </Descriptions.Item>
        <Descriptions.Item label="侧别 side">{side}（由旋转推导，只读）</Descriptions.Item>
        <Descriptions.Item label="X / Z（基点）">
          <Space.Compact style={{ width: '100%' }}>
            <NumField
              value={r.x}
              step={0.1}
              precision={3}
              onCommit={(v) => a.patchRack(r.key, { x: v })}
              testId="rack-x"
            />
            <NumField
              value={r.z}
              step={0.1}
              precision={3}
              onCommit={(v) => a.patchRack(r.key, { z: v })}
              testId="rack-z"
            />
          </Space.Compact>
        </Descriptions.Item>
        <Descriptions.Item label="旋转">
          <Space>
            {r.rotationDeg}°
            <Button size="small" onClick={() => a.rotate([r.key])} data-testid="rotate">
              旋转 90°（R）
            </Button>
          </Space>
        </Descriptions.Item>
        {t && (
          <Descriptions.Item label="模板（快照）">
            {t.name ?? t.key}：{t.bays} 列 × {t.levels} 层 × {t.positionsPerLevel} 位，长{' '}
            {rackLengthM(t).toFixed(2)}m × 深 {t.depthM}m
          </Descriptions.Item>
        )}
      </Descriptions>
      <Divider plain style={{ margin: '12px 0 8px' }}>
        阵列复制（沿行进方向）
      </Divider>
      <Space.Compact style={{ width: '100%' }}>
        <NumField
          value={count}
          min={1}
          max={200}
          onCommit={setCount}
          testId="array-count"
          suffix="个"
        />
        <NumField value={gap} min={0} max={50} step={0.1} onCommit={setGap} suffix="m 间隙" />
        <Button
          size="small"
          type="primary"
          onClick={() => a.arrayCopy(r.key, count, gap)}
          data-testid="array-copy"
        >
          复制
        </Button>
      </Space.Compact>
      <Space style={{ marginTop: 8 }} wrap>
        <Popconfirm
          title={`按行进方向重排 ${r.zone}${String(r.aisle).padStart(2, '0')} 巷道的 rackNo / bayStart？（会改码）`}
          onConfirm={() => a.renumber(r.zone, r.aisle)}
        >
          <Button size="small">巷道重新编号</Button>
        </Popconfirm>
        <Button size="small" danger onClick={() => a.remove([r.key])}>
          删除
        </Button>
      </Space>
    </div>
  );
}
