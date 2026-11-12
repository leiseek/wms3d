import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RackTypeSpec } from '@wms3d/contracts';
import { api } from '../api';
import { useMe } from '../session';
import { can } from '../lib/rbac';
import { PageHeader, useNotifyError } from '../components/common';

type Lib = RackTypeSpec & { id: string };
type F = Omit<RackTypeSpec, 'levelHeightsM'> & { levelHeights: string };

/** 05 §2.3 常用预设 */
const PRESETS: { label: string; v: Omit<F, 'key'> }[] = [
  {
    label: '重型托盘架 2.7×1.0×4 层',
    v: {
      name: '重型托盘架',
      bays: 3,
      levels: 4,
      positionsPerLevel: 2,
      bayWidthM: 2.7,
      depthM: 1.0,
      levelHeights: '1.5,1.5,1.5,1.5',
      beamM: 0.12,
      uprightM: 0.09,
      defaultMaxQty: 2,
    },
  },
  {
    label: '中型层板架 1.5×0.6×5 层×3 位',
    v: {
      name: '中型层板架',
      bays: 5,
      levels: 5,
      positionsPerLevel: 3,
      bayWidthM: 1.5,
      depthM: 0.6,
      levelHeights: '0.5,0.5,0.5,0.5,0.5',
      beamM: 0.05,
      uprightM: 0.05,
      defaultMaxQty: 50,
    },
  },
  {
    label: '轻型货架 1.0×0.5×5 层×4 位',
    v: {
      name: '轻型货架',
      bays: 6,
      levels: 5,
      positionsPerLevel: 4,
      bayWidthM: 1.0,
      depthM: 0.5,
      levelHeights: '0.4,0.4,0.4,0.4,0.4',
      beamM: 0.03,
      uprightM: 0.03,
      defaultMaxQty: 30,
    },
  },
];

function Elevation({
  bays,
  levels,
  positions,
}: {
  bays: number;
  levels: number;
  positions: number;
}) {
  const w = 220;
  const h = 120;
  const bw = w / Math.max(1, bays);
  const lh = h / Math.max(1, levels);
  return (
    <svg
      width={w + 2}
      height={h + 2}
      style={{ background: '#fafafa', border: '1px solid #eee' }}
      aria-label="立面预览"
    >
      {Array.from({ length: bays }, (_, b) =>
        Array.from({ length: levels }, (_, l) =>
          Array.from({ length: positions }, (_, p) => (
            <rect
              key={`${b}-${l}-${p}`}
              x={1 + b * bw + (p * bw) / positions + 1}
              y={1 + h - (l + 1) * lh + 2}
              width={bw / positions - 2}
              height={lh - 4}
              fill="#bae0ff"
              stroke="#1677ff"
              strokeWidth={0.5}
            />
          )),
        ),
      )}
    </svg>
  );
}

export default function RackTypesPage() {
  const me = useMe();
  const writable = can(me, 'rackType.write');
  const notify = useNotifyError();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState<Lib | 'new' | null>(null);
  const [form] = Form.useForm<F>();
  const watched = Form.useWatch([], form) as Partial<F> | undefined;

  const list = useQuery({ queryKey: ['rackTypes'], queryFn: () => api.r.listRackTypes({}) });
  const save = useMutation({
    mutationFn: (v: F) => {
      const { levelHeights, ...rest } = v;
      const body: RackTypeSpec = {
        ...rest,
        levelHeightsM: levelHeights
          .split(/[,，\s]+/)
          .filter(Boolean)
          .map(Number),
        defaultMaxQty: rest.defaultMaxQty ?? null,
      };
      return editing === 'new'
        ? api.r.createRackType({ body })
        : api.r.patchRackType({ params: { id: (editing as Lib).id }, body });
    },
    onSuccess: () => {
      void message.success('已保存（已放置的货架按值快照，不受影响）');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['rackTypes'] });
    },
    onError: notify,
  });

  const open = (t: Lib | 'new') => {
    setEditing(t);
    form.resetFields();
    if (t === 'new') form.setFieldsValue({ key: '', ...PRESETS[1]!.v });
    else form.setFieldsValue({ ...t, levelHeights: t.levelHeightsM.join(',') });
  };

  return (
    <div>
      <PageHeader
        title="货架模板"
        sub="布局设计器放置货架时按值快照模板参数"
        extra={
          writable && (
            <Button type="primary" onClick={() => open('new')}>
              新建模板
            </Button>
          )
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        columns={[
          { title: 'key', dataIndex: 'key' },
          { title: '名称', dataIndex: 'name' },
          {
            title: '列×层×位',
            render: (_, t) => `${t.bays} × ${t.levels} × ${t.positionsPerLevel}`,
          },
          { title: '列宽×深 (m)', render: (_, t) => `${t.bayWidthM} × ${t.depthM}` },
          { title: '层高 (m)', render: (_, t) => t.levelHeightsM.join(' / ') },
          {
            title: '默认容量',
            dataIndex: 'defaultMaxQty',
            render: (v: number | null) => v ?? '不限',
          },
          {
            title: '',
            render: (_, t) => (
              <Button size="small" type="link" onClick={() => open(t)}>
                {writable ? '编辑' : '查看'}
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={!!editing}
        width={720}
        title={editing === 'new' ? '新建货架模板' : '货架模板'}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        okButtonProps={{ disabled: !writable }}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        {editing === 'new' && (
          <Space wrap style={{ marginBottom: 12 }}>
            预设：
            {PRESETS.map((p) => (
              <Button key={p.label} size="small" onClick={() => form.setFieldsValue(p.v)}>
                {p.label}
              </Button>
            ))}
          </Space>
        )}
        <Space align="start" size="large">
          <Form
            form={form}
            layout="vertical"
            disabled={!writable}
            onFinish={(v) => save.mutate(v)}
            style={{ width: 430 }}
          >
            <Space wrap>
              <Form.Item
                label="key"
                name="key"
                rules={[
                  { required: true },
                  { pattern: /^[a-z0-9][a-z0-9-]{0,31}$/, message: '小写字母/数字/-' },
                ]}
              >
                <Input style={{ width: 150 }} disabled={editing !== 'new'} />
              </Form.Item>
              <Form.Item label="名称" name="name">
                <Input style={{ width: 200 }} />
              </Form.Item>
            </Space>
            <Space wrap>
              <Form.Item label="列数" name="bays" rules={[{ required: true }]}>
                <InputNumber min={1} max={49} precision={0} />
              </Form.Item>
              <Form.Item label="层数" name="levels" rules={[{ required: true }]}>
                <InputNumber min={1} max={26} precision={0} />
              </Form.Item>
              <Form.Item label="每层位数" name="positionsPerLevel" rules={[{ required: true }]}>
                <InputNumber min={1} max={99} precision={0} />
              </Form.Item>
            </Space>
            <Space wrap>
              <Form.Item label="列宽 m" name="bayWidthM" rules={[{ required: true }]}>
                <InputNumber min={0.1} max={10} step={0.1} />
              </Form.Item>
              <Form.Item label="深度 m" name="depthM" rules={[{ required: true }]}>
                <InputNumber min={0.1} max={5} step={0.1} />
              </Form.Item>
              <Form.Item label="横梁 m" name="beamM">
                <InputNumber min={0} max={0.5} step={0.01} />
              </Form.Item>
              <Form.Item label="立柱 m" name="uprightM">
                <InputNumber min={0} max={0.5} step={0.01} />
              </Form.Item>
            </Space>
            <Form.Item
              label="各层净高 m（逗号分隔，自下而上）"
              name="levelHeights"
              dependencies={['levels']}
              rules={[
                { required: true },
                ({ getFieldValue }) => ({
                  validator: (_r, v: string) => {
                    const n = (v ?? '').split(/[,，\s]+/).filter(Boolean);
                    if (n.some((x) => !(Number(x) > 0 && Number(x) <= 5)))
                      return Promise.reject(new Error('每层 0–5 m'));
                    return n.length === getFieldValue('levels')
                      ? Promise.resolve()
                      : Promise.reject(new Error('个数必须等于层数'));
                  },
                }),
              ]}
            >
              <Input />
            </Form.Item>
            <Form.Item label="默认容量（每仓位）" name="defaultMaxQty">
              <InputNumber min={1} precision={0} placeholder="不限" />
            </Form.Item>
          </Form>
          <div>
            <Typography.Text type="secondary">立面预览</Typography.Text>
            <Elevation
              bays={Math.min(watched?.bays ?? 1, 12)}
              levels={Math.min(watched?.levels ?? 1, 10)}
              positions={Math.min(watched?.positionsPerLevel ?? 1, 6)}
            />
          </div>
        </Space>
      </Modal>
    </div>
  );
}
