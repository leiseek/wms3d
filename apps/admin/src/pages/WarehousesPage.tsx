import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { DEFAULT_LOCATION_CODE_PATTERN, type Warehouse } from '@wms3d/contracts';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { can } from '../lib/rbac';
import { PageHeader, useNotifyError } from '../components/common';

type WhForm = {
  code?: string;
  name: string;
  timezone: string;
  widthM: number;
  depthM: number;
  heightM: number;
  locationCodePattern: string;
  barcodePrefixEnabled: boolean;
  allowMixedSku: boolean;
};

export default function WarehousesPage() {
  const warehouseId = useWarehouseId();
  const me = useMe();
  const writable = can(me, 'warehouse.write');
  const notify = useNotifyError();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState<Warehouse | 'new' | null>(null);
  const [form] = Form.useForm<WhForm>();

  const whs = useQuery({ queryKey: ['warehouses'], queryFn: () => api.r.listWarehouses({}) });
  const zones = useQuery({
    queryKey: ['zones', warehouseId],
    queryFn: () => api.r.listZones({ params: { id: warehouseId } }),
  });
  const racks = useQuery({
    queryKey: ['racks', warehouseId],
    queryFn: () => api.r.listRacks({ params: { id: warehouseId } }),
  });
  const current = whs.data?.items.find((w) => w.id === warehouseId);

  const save = useMutation({
    mutationFn: (v: WhForm) => {
      const { code, ...rest } = v;
      return editing === 'new'
        ? api.r.createWarehouse({ body: { code: code!, ...rest } })
        : api.r.patchWarehouse({ params: { id: (editing as Warehouse).id }, body: rest });
    },
    onSuccess: () => {
      void message.success(
        editing === 'new' ? '仓库已创建（重新登录后出现在仓库切换中）' : '已保存',
      );
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['warehouses'] });
    },
    onError: notify,
  });

  const open = (w: Warehouse | 'new') => {
    setEditing(w);
    form.resetFields();
    form.setFieldsValue(
      w === 'new'
        ? {
            timezone: 'Asia/Shanghai',
            widthM: 60,
            depthM: 40,
            heightM: 10,
            locationCodePattern: DEFAULT_LOCATION_CODE_PATTERN,
            barcodePrefixEnabled: true,
            allowMixedSku: true,
          }
        : w,
    );
  };

  return (
    <div data-testid="warehouses-page">
      <PageHeader
        title="仓库 / 库区 / 货架"
        sub="库区与货架的几何只能在布局设计器的草稿中编辑并发布（布局文档是唯一真相源）"
        extra={
          <>
            {can(me, 'layout.edit') && (
              <Button onClick={() => nav('/layout')}>打开布局设计器</Button>
            )}
            {writable && (
              <Button type="primary" onClick={() => open('new')}>
                新建仓库
              </Button>
            )}
          </>
        }
      />
      <Tabs
        items={[
          {
            key: 'wh',
            label: '仓库设置',
            children: (
              <>
                {current && (
                  <Card
                    style={{ marginBottom: 16 }}
                    title={`${current.code} · ${current.name}`}
                    extra={writable && <Button onClick={() => open(current)}>编辑</Button>}
                  >
                    <Descriptions size="small" column={{ xs: 1, md: 3 }}>
                      <Descriptions.Item label="尺寸">
                        {current.widthM} × {current.depthM} × {current.heightM} m
                      </Descriptions.Item>
                      <Descriptions.Item label="时区">{current.timezone}</Descriptions.Item>
                      <Descriptions.Item label="已发布布局">
                        v{current.publishedLayoutVersion ?? '—'}
                      </Descriptions.Item>
                      <Descriptions.Item label="编码模式">
                        <Typography.Text code>{current.locationCodePattern}</Typography.Text>
                        {current.locationCodePatternLocked && (
                          <Tag style={{ marginLeft: 6 }}>已锁定</Tag>
                        )}
                      </Descriptions.Item>
                      <Descriptions.Item label="条码仓库前缀">
                        {current.barcodePrefixEnabled
                          ? `开启（${current.code}.A03-17-C02）`
                          : '关闭（裸编码）'}
                      </Descriptions.Item>
                      <Descriptions.Item label="允许混放">
                        {current.allowMixedSku ? '是' : '否'}
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                )}
                <Table
                  rowKey="id"
                  size="small"
                  loading={whs.isLoading}
                  dataSource={whs.data?.items ?? []}
                  pagination={false}
                  columns={[
                    { title: '代码', dataIndex: 'code' },
                    { title: '名称', dataIndex: 'name' },
                    {
                      title: '尺寸 (m)',
                      render: (_, w) => `${w.widthM} × ${w.depthM} × ${w.heightM}`,
                    },
                    {
                      title: '布局版本',
                      dataIndex: 'publishedLayoutVersion',
                      render: (v: number | null) => (v ? `v${v}` : '未发布'),
                    },
                    {
                      title: '',
                      render: (_, w) =>
                        writable && (
                          <Button size="small" type="link" onClick={() => open(w)}>
                            编辑
                          </Button>
                        ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'zones',
            label: `库区（${zones.data?.items.length ?? 0}）`,
            children: (
              <Table
                rowKey="id"
                size="small"
                loading={zones.isLoading}
                dataSource={zones.data?.items ?? []}
                pagination={false}
                columns={[
                  { title: '代码', dataIndex: 'code' },
                  { title: '名称', dataIndex: 'name' },
                  { title: '类型', dataIndex: 'kind' },
                  { title: '顶点数', render: (_, z) => z.polygon.length },
                  {
                    title: '颜色',
                    dataIndex: 'color',
                    render: (c: string | null) =>
                      c ? (
                        <span
                          style={{
                            display: 'inline-block',
                            width: 14,
                            height: 14,
                            background: c,
                            borderRadius: 3,
                          }}
                        />
                      ) : (
                        '—'
                      ),
                  },
                  { title: '布局版本', dataIndex: 'layoutVersion' },
                ]}
              />
            ),
          },
          {
            key: 'racks',
            label: `货架（${racks.data?.items.length ?? 0}）`,
            children: (
              <Table
                rowKey="id"
                size="small"
                loading={racks.isLoading}
                dataSource={racks.data?.items ?? []}
                pagination={{ pageSize: 20 }}
                data-testid="rack-table"
                columns={[
                  {
                    title: '货架码',
                    dataIndex: 'code',
                    render: (c: string) => <b style={{ fontFamily: 'monospace' }}>{c}</b>,
                  },
                  { title: '巷道', dataIndex: 'aisle' },
                  {
                    title: '侧',
                    dataIndex: 'side',
                    render: (s: string) => (s === 'L' ? '左(奇)' : '右(偶)'),
                  },
                  { title: '起始列', dataIndex: 'bayStart' },
                  {
                    title: '模板',
                    render: (_, r) =>
                      `${r.rackType.name ?? r.rackType.key}（${r.rackType.bays}列×${r.rackType.levels}层×${r.rackType.positionsPerLevel}位）`,
                  },
                  {
                    title: '位置 (x, z)',
                    render: (_, r) => `${r.x.toFixed(1)}, ${r.z.toFixed(1)} · ${r.rotationDeg}°`,
                  },
                  {
                    title: '状态',
                    dataIndex: 'isActive',
                    render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
                  },
                  {
                    title: '',
                    render: (_, r) => (
                      <Space>
                        <Button size="small" type="link" onClick={() => nav(`/locations`)}>
                          仓位
                        </Button>
                        {can(me, 'labels.print') && (
                          <Button
                            size="small"
                            type="link"
                            onClick={() => nav('/labels', { state: { kind: 'RACK', ids: [r.id] } })}
                          >
                            打印货架码
                          </Button>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
      <Modal
        open={!!editing}
        title={editing === 'new' ? '新建仓库' : '仓库设置'}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        width={620}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Space wrap>
            <Form.Item
              label="代码"
              name="code"
              rules={[
                { required: editing === 'new' },
                { pattern: /^[A-Z0-9]{2,4}$/, message: '2–4 位大写字母/数字' },
              ]}
            >
              <Input
                style={{ width: 100 }}
                disabled={editing !== 'new'}
                placeholder={editing === 'new' ? 'WH2' : undefined}
              />
            </Form.Item>
            <Form.Item label="名称" name="name" rules={[{ required: true }]}>
              <Input style={{ width: 220 }} />
            </Form.Item>
            <Form.Item label="时区" name="timezone">
              <Input style={{ width: 160 }} />
            </Form.Item>
          </Space>
          <Space wrap>
            <Form.Item label="宽 (m)" name="widthM" rules={[{ required: true }]}>
              <InputNumber min={1} max={2000} />
            </Form.Item>
            <Form.Item label="深 (m)" name="depthM" rules={[{ required: true }]}>
              <InputNumber min={1} max={2000} />
            </Form.Item>
            <Form.Item label="高 (m)" name="heightM" rules={[{ required: true }]}>
              <InputNumber min={1} max={60} />
            </Form.Item>
          </Space>
          <Form.Item
            label="仓位编码模式"
            name="locationCodePattern"
            extra={
              editing !== 'new' && editing?.locationCodePatternLocked
                ? '已存在仓位，编码模式已锁定'
                : '默认 {Zone}{Aisle:2}-{Bay:2}-{Level:A}{Pos:2} → A03-17-C02'
            }
          >
            <Input disabled={editing !== 'new' && !!editing?.locationCodePatternLocked} />
          </Form.Item>
          <Space size="large">
            <Form.Item
              label="条码带仓库前缀"
              name="barcodePrefixEnabled"
              valuePropName="checked"
              extra="关闭后失去跨仓校验，仅建议单仓使用"
            >
              <Switch />
            </Form.Item>
            <Form.Item label="允许同仓位混放多个 SKU" name="allowMixedSku" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
