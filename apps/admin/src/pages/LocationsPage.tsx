import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import type { Location, ZoneKind } from '@wms3d/contracts';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { can } from '../lib/rbac';
import { CursorPager, PageHeader, useCursorPager, useNotifyError } from '../components/common';

const KIND_LABEL: Record<ZoneKind, string> = {
  STORAGE: '存储',
  RECEIVING: '收货',
  SHIPPING: '发货',
  QC: '质检',
};

interface BulkForm {
  setActive: boolean;
  isActive: boolean;
  setMax: boolean;
  maxQty: number | null;
  setPick: boolean;
  pickSeq: number;
}

export default function LocationsPage() {
  const warehouseId = useWarehouseId();
  const me = useMe();
  const writable = can(me, 'location.write');
  const notify = useNotifyError();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { message } = AntApp.useApp();
  const pager = useCursorPager();
  const [filter, setFilter] = useState<{
    zone?: string;
    rack?: string;
    q?: string;
    isActive?: 'true' | 'false';
  }>({});
  const [selected, setSelected] = useState<Location[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [failed, setFailed] = useState<{ id: string; code: string }[]>([]);
  const [form] = Form.useForm<BulkForm>();

  const zones = useQuery({
    queryKey: ['zones', warehouseId],
    queryFn: () => api.r.listZones({ params: { id: warehouseId } }),
  });
  const list = useQuery({
    queryKey: ['locations', warehouseId, filter, pager.cursor],
    queryFn: () =>
      api.r.listLocations({
        params: { id: warehouseId },
        query: { ...filter, limit: 100, cursor: pager.cursor },
      }),
  });

  const bulk = useMutation({
    mutationFn: (patch: { isActive?: boolean; maxQty?: number | null; pickSeq?: number }) =>
      api.r.bulkPatchLocations({
        params: { id: warehouseId },
        body: { ids: selected.map((s) => s.id), patch },
      }),
    onSuccess: (r) => {
      setFailed(r.failed);
      if (r.failed.length)
        void message.warning(`已更新 ${r.updated} 个，${r.failed.length} 个失败`);
      else void message.success(`已更新 ${r.updated} 个仓位`);
      setBulkOpen(false);
      setSelected([]);
      void qc.invalidateQueries({ queryKey: ['locations'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: notify,
  });

  const onBulk = (v: BulkForm) => {
    const patch: { isActive?: boolean; maxQty?: number | null; pickSeq?: number } = {};
    if (v.setActive) patch.isActive = v.isActive;
    if (v.setMax) patch.maxQty = v.maxQty ?? null;
    if (v.setPick) patch.pickSeq = v.pickSeq;
    if (!Object.keys(patch).length) return void message.info('请至少勾选一项要修改的属性');
    bulk.mutate(patch);
  };

  const setF = (p: Partial<typeof filter>) => {
    setFilter((f) => ({ ...f, ...p }));
    pager.reset();
  };

  return (
    <div data-testid="locations-page">
      <PageHeader
        title="仓位"
        sub="仓位由已发布布局生成；这里只改运行时属性（启停、容量、拣货顺序）"
        extra={
          <>
            <Select
              allowClear
              placeholder="库区"
              style={{ width: 120 }}
              options={(zones.data?.items ?? []).map((z) => ({
                value: z.code,
                label: `${z.code} ${z.name ?? ''}`,
              }))}
              onChange={(v?: string) => setF({ zone: v })}
            />
            <Input.Search
              placeholder="货架码，如 A03-L01"
              allowClear
              style={{ width: 180 }}
              onSearch={(v) => setF({ rack: v.trim().toUpperCase() || undefined })}
            />
            <Input.Search
              placeholder="仓位编码"
              allowClear
              style={{ width: 180 }}
              onSearch={(v) => setF({ q: v.trim() || undefined })}
              data-testid="loc-search"
            />
            <Select
              style={{ width: 100 }}
              value={filter.isActive ?? 'all'}
              onChange={(v: string) =>
                setF({ isActive: v === 'all' ? undefined : (v as 'true' | 'false') })
              }
              options={[
                { value: 'all', label: '全部' },
                { value: 'true', label: '启用' },
                { value: 'false', label: '停用' },
              ]}
            />
          </>
        }
      />
      {failed.length > 0 && (
        <Alert
          type="warning"
          closable
          onClose={() => setFailed([])}
          style={{ marginBottom: 12 }}
          title={`${failed.length} 个仓位未更新`}
          description={`有库存或不可修改：${failed.map((f) => f.code).join('、')}`}
        />
      )}
      <Space style={{ marginBottom: 12 }}>
        <span>已选 {selected.length} 个</span>
        {writable && (
          <Button
            type="primary"
            disabled={!selected.length}
            onClick={() => {
              form.setFieldsValue({
                setActive: true,
                isActive: false,
                setMax: false,
                maxQty: null,
                setPick: false,
                pickSeq: 0,
              });
              setBulkOpen(true);
            }}
            data-testid="loc-bulk-edit"
          >
            批量编辑
          </Button>
        )}
        {can(me, 'labels.print') && (
          <Button
            disabled={!selected.length}
            onClick={() =>
              nav('/labels', { state: { kind: 'LOCATION', ids: selected.map((s) => s.id) } })
            }
          >
            打印标签
          </Button>
        )}
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        rowSelection={{
          selectedRowKeys: selected.map((s) => s.id),
          onChange: (_k, rows) => setSelected(rows),
          preserveSelectedRowKeys: true,
        }}
        data-testid="loc-table"
        columns={[
          {
            title: '编码',
            dataIndex: 'code',
            render: (c: string) => <b style={{ fontFamily: 'monospace' }}>{c}</b>,
          },
          {
            title: '条码载荷',
            dataIndex: 'payload',
            render: (c: string) => <span style={{ fontFamily: 'monospace' }}>{c}</span>,
          },
          { title: '类型', dataIndex: 'kind', render: (k: ZoneKind) => KIND_LABEL[k] },
          {
            title: '列/层/位',
            render: (_, l) => (l.bay === null ? '地面' : `${l.bay} / ${l.level} / ${l.position}`),
          },
          { title: '拣货顺序', dataIndex: 'pickSeq' },
          { title: '容量', render: (_, l) => l.effectiveMax ?? '不限' },
          {
            title: '状态',
            dataIndex: 'isActive',
            render: (v: boolean) =>
              v ? <Tag color="green">启用</Tag> : <Tag color="default">停用</Tag>,
          },
          {
            title: '',
            render: (_, l) => (
              <Button size="small" type="link" onClick={() => nav(`/twin?loc=${l.id}`)}>
                3D 定位
              </Button>
            ),
          },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />

      <Modal
        open={bulkOpen}
        title={`批量编辑 ${selected.length} 个仓位`}
        onCancel={() => setBulkOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={bulk.isPending}
        okButtonProps={{ ...({ 'data-testid': 'loc-bulk-ok' } as object) }}
      >
        <Form form={form} layout="vertical" onFinish={onBulk}>
          <Space align="baseline">
            <Form.Item name="setActive" valuePropName="checked">
              <Checkbox>启停</Checkbox>
            </Form.Item>
            <Form.Item name="isActive">
              <Radio.Group
                options={[
                  { value: true, label: '启用' },
                  { value: false, label: '停用' },
                ]}
              />
            </Form.Item>
          </Space>
          <Alert
            type="info"
            style={{ marginBottom: 12 }}
            title="停用仍有库存的仓位会被服务端拒绝（列在失败清单中），请先移库。"
          />
          <Space align="baseline">
            <Form.Item name="setMax" valuePropName="checked">
              <Checkbox>容量</Checkbox>
            </Form.Item>
            <Form.Item name="maxQty" extra="留空 = 使用货架模板默认容量">
              <InputNumber min={1} precision={0} placeholder="默认" />
            </Form.Item>
          </Space>
          <Space align="baseline">
            <Form.Item name="setPick" valuePropName="checked">
              <Checkbox>拣货顺序</Checkbox>
            </Form.Item>
            <Form.Item name="pickSeq">
              <InputNumber min={0} precision={0} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
