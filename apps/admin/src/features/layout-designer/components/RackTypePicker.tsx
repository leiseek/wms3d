import { useState } from 'react';
import { Button, Form, Input, InputNumber, Modal, Select, Space, message } from 'antd';
import type { RackTypeSpec } from '@wms3d/contracts';
import { rackLengthM } from '@wms3d/domain';

/** 05 §2.3 常用预设 */
export const RACK_PRESETS: RackTypeSpec[] = [
  {
    key: 'heavy-pallet',
    name: '重型托盘架 2.7m×1.0m×4 层',
    bays: 3,
    levels: 4,
    positionsPerLevel: 2,
    bayWidthM: 2.7,
    depthM: 1.0,
    levelHeightsM: [1.5, 1.5, 1.5, 1.5],
    beamM: 0.1,
    uprightM: 0.08,
    defaultMaxQty: null,
  },
  {
    key: 'medium-shelf',
    name: '中型层板架 1.5m×0.6m×5 层×3 位',
    bays: 4,
    levels: 5,
    positionsPerLevel: 3,
    bayWidthM: 1.5,
    depthM: 0.6,
    levelHeightsM: [0.5, 0.5, 0.5, 0.5, 0.5],
    beamM: 0.05,
    uprightM: 0.05,
    defaultMaxQty: null,
  },
  {
    key: 'light-shelf',
    name: '轻型货架 1.0m×0.5m×5 层×4 位',
    bays: 4,
    levels: 5,
    positionsPerLevel: 4,
    bayWidthM: 1.0,
    depthM: 0.5,
    levelHeightsM: [0.4, 0.4, 0.4, 0.4, 0.4],
    beamM: 0.03,
    uprightM: 0.04,
    defaultMaxQty: null,
  },
];

export const typeLabel = (t: RackTypeSpec) =>
  `${t.name ?? t.key}（${t.bays}列×${t.levels}层×${t.positionsPerLevel}位，${rackLengthM(t).toFixed(2)}×${t.depthM}m）`;

/** 模板选择（模板库 + 文档内快照 + 预设）与新增模板表单（createRackType，ADMIN）。 */
export function RackTypePicker(p: {
  library: RackTypeSpec[];
  docTypes: RackTypeSpec[];
  value: string | null;
  onChange(key: string, t: RackTypeSpec): void;
  onCreate?: (t: RackTypeSpec) => Promise<RackTypeSpec>;
}) {
  const all = new Map<string, RackTypeSpec>();
  for (const t of [...p.docTypes, ...p.library, ...RACK_PRESETS])
    if (!all.has(t.key)) all.set(t.key, t);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const submit = async () => {
    const v = await form.validateFields();
    const levels = v.levels as number;
    const spec: RackTypeSpec = {
      key: v.key,
      name: v.name || undefined,
      bays: v.bays,
      levels,
      positionsPerLevel: v.positionsPerLevel,
      bayWidthM: v.bayWidthM,
      depthM: v.depthM,
      levelHeightsM: Array.from({ length: levels }, () => v.levelHeightM as number),
      beamM: v.beamM,
      uprightM: v.uprightM,
      defaultMaxQty: v.defaultMaxQty ?? null,
    };
    try {
      const saved = p.onCreate ? await p.onCreate(spec) : spec;
      setOpen(false);
      p.onChange(saved.key, saved);
    } catch (e) {
      void message.error((e as Error).message);
    }
  };
  return (
    <Space.Compact>
      <Select
        size="small"
        style={{ width: 300 }}
        placeholder="选择货架模板"
        value={p.value}
        onChange={(k: string) => p.onChange(k, all.get(k)!)}
        options={[...all.values()].map((t) => ({ value: t.key, label: typeLabel(t) }))}
        data-testid="rack-type-select"
      />
      {p.onCreate && (
        <Button size="small" onClick={() => setOpen(true)}>
          新模板
        </Button>
      )}
      <Modal
        open={open}
        title="新增货架模板（模板库）"
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          size="small"
          initialValues={{ ...RACK_PRESETS[0], key: '', levelHeightM: 1.5 }}
        >
          <Space wrap>
            <Form.Item
              name="key"
              label="key"
              rules={[
                {
                  required: true,
                  pattern: /^[a-z0-9][a-z0-9-]{0,31}$/,
                  message: '小写字母/数字/-',
                },
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item name="name" label="名称">
              <Input />
            </Form.Item>
            {(
              [
                ['bays', '列数', 1, 49, 1],
                ['levels', '层数', 1, 26, 1],
                ['positionsPerLevel', '每层位数', 1, 99, 1],
                ['bayWidthM', '列宽 m', 0.1, 10, 0.1],
                ['depthM', '深度 m', 0.1, 5, 0.1],
                ['levelHeightM', '层净高 m', 0.1, 5, 0.1],
                ['beamM', '横梁 m', 0, 0.5, 0.01],
                ['uprightM', '立柱 m', 0, 0.5, 0.01],
              ] as const
            ).map(([n, l, min, max, step]) => (
              <Form.Item key={n} name={n} label={l} rules={[{ required: true }]}>
                <InputNumber min={min} max={max} step={step} />
              </Form.Item>
            ))}
            <Form.Item name="defaultMaxQty" label="默认容量">
              <InputNumber min={1} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Space.Compact>
  );
}
