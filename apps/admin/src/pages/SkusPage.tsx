import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Sku } from '@wms3d/contracts';
import { api } from '../api';
import { useMe } from '../session';
import { can } from '../lib/rbac';
import { CursorPager, PageHeader, useCursorPager, useNotifyError } from '../components/common';
import { downloadBlob, filenameFrom } from '../lib/download';
import { SkuImportWizard } from './SkuImportWizard';

type SkuForm = {
  code: string;
  name: string;
  spec?: string | null;
  uom?: string;
  safetyStock?: number;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  weightG?: number | null;
  isActive?: boolean;
  barcodes?: { barcode: string; packQty?: number; isPrimary?: boolean }[];
};

const nn = (v: number | null | undefined) => (v === undefined || v === null ? null : v);

export default function SkusPage() {
  const me = useMe();
  const writable = can(me, 'sku.write');
  const exportable = can(me, 'inventory.export');
  const notify = useNotifyError();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [q, setQ] = useState('');
  const [active, setActive] = useState<'true' | 'false' | undefined>('true');
  const pager = useCursorPager();
  const [editing, setEditing] = useState<Sku | 'new' | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [form] = Form.useForm<SkuForm>();
  const [newBarcode, setNewBarcode] = useState('');

  const list = useQuery({
    queryKey: ['skus', q, active, pager.cursor],
    queryFn: () =>
      api.r.listSkus({
        query: { q: q || undefined, isActive: active, limit: 50, cursor: pager.cursor },
      }),
  });

  const save = useMutation({
    mutationFn: async (v: SkuForm) => {
      const common = {
        name: v.name,
        spec: v.spec || null,
        uom: v.uom || 'EA',
        safetyStock: v.safetyStock ?? 0,
        lengthMm: nn(v.lengthMm),
        widthMm: nn(v.widthMm),
        heightMm: nn(v.heightMm),
        weightG: nn(v.weightG),
      };
      if (editing === 'new')
        return api.r.createSku({
          body: {
            code: v.code,
            ...common,
            barcodes: (v.barcodes ?? [])
              .filter((b) => b?.barcode)
              .map((b, i) => ({
                barcode: b.barcode.trim(),
                packQty: b.packQty ?? 1,
                isPrimary: b.isPrimary ?? i === 0,
              })),
          },
        });
      return api.r.patchSku({
        params: { id: (editing as Sku).id },
        body: { ...common, isActive: v.isActive ?? true },
      });
    },
    onSuccess: () => {
      void message.success('已保存');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['skus'] });
    },
    onError: notify,
  });

  const addBarcode = useMutation({
    mutationFn: (p: { id: string; barcode: string }) =>
      api.r.addSkuBarcode({ params: { id: p.id }, body: { barcode: p.barcode, packQty: 1 } }),
    onSuccess: (_r, p) => {
      setNewBarcode('');
      void refreshEditing(p.id);
    },
    onError: notify,
  });
  const delBarcode = useMutation({
    mutationFn: (p: { id: string; barcodeId: string }) => api.r.deleteSkuBarcode({ params: p }),
    onSuccess: (_r, p) => void refreshEditing(p.id),
    onError: notify,
  });
  async function refreshEditing(id: string) {
    const s = await api.r.getSku({ params: { id } });
    setEditing(s);
    void qc.invalidateQueries({ queryKey: ['skus'] });
  }

  const doExport = async () => {
    try {
      const res = await api.r.exportSkus({});
      downloadBlob(await res.blob(), filenameFrom(res, 'skus.csv'));
    } catch (e) {
      notify(e);
    }
  };

  const openEdit = (s: Sku | 'new') => {
    setEditing(s);
    form.resetFields();
    if (s === 'new')
      form.setFieldsValue({ uom: 'EA', safetyStock: 0, barcodes: [{ barcode: '', packQty: 1 }] });
    else form.setFieldsValue({ ...s, spec: s.spec ?? '' });
  };

  const editingSku = editing && editing !== 'new' ? editing : null;

  return (
    <div data-testid="skus-page">
      <PageHeader
        title="SKU 管理"
        sub="主数据为组织级（所有仓库共享）；同一 SKU 可挂多个条码"
        extra={
          <>
            <Input.Search
              placeholder="编码 / 名称 / 条码（可用扫码枪）"
              allowClear
              style={{ width: 260 }}
              onSearch={(v) => {
                setQ(v.trim());
                pager.reset();
              }}
              data-testid="sku-search"
            />
            <Select
              style={{ width: 110 }}
              value={active ?? 'all'}
              onChange={(v: string) => {
                setActive(v === 'all' ? undefined : (v as 'true' | 'false'));
                pager.reset();
              }}
              options={[
                { value: 'true', label: '启用' },
                { value: 'false', label: '停用' },
                { value: 'all', label: '全部' },
              ]}
            />
            {exportable && <Button onClick={doExport}>导出 CSV</Button>}
            {writable && (
              <>
                <Button onClick={() => setImportOpen(true)} data-testid="sku-import-open">
                  CSV 导入
                </Button>
                <Button type="primary" onClick={() => openEdit('new')} data-testid="sku-new">
                  新建 SKU
                </Button>
              </>
            )}
          </>
        }
      />
      <Table
        rowKey="id"
        size="middle"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        data-testid="sku-table"
        columns={[
          { title: '编码', dataIndex: 'code', width: 140 },
          { title: '名称', dataIndex: 'name' },
          { title: '规格', dataIndex: 'spec', render: (v: string | null) => v ?? '—' },
          { title: '单位', dataIndex: 'uom', width: 70 },
          {
            title: '条码',
            dataIndex: 'barcodes',
            render: (bs: Sku['barcodes']) =>
              bs.length ? (
                <Space size={4} wrap>
                  {bs.map((b) => (
                    <Tag key={b.id} color={b.isPrimary ? 'blue' : undefined}>
                      {b.barcode}
                      {b.packQty > 1 ? ` ×${b.packQty}` : ''}
                    </Tag>
                  ))}
                </Space>
              ) : (
                '—'
              ),
          },
          { title: '安全库存', dataIndex: 'safetyStock', width: 90 },
          {
            title: '状态',
            dataIndex: 'isActive',
            width: 80,
            render: (v: boolean) => (v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '操作',
            width: 90,
            render: (_, s) => (
              <Button size="small" type="link" onClick={() => openEdit(s)}>
                {writable ? '编辑' : '查看'}
              </Button>
            ),
          },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />

      <Drawer
        open={!!editing}
        size={520}
        title={editing === 'new' ? '新建 SKU' : `SKU ${editingSku?.code ?? ''}`}
        onClose={() => setEditing(null)}
        destroyOnHidden
        extra={
          writable && (
            <Button
              type="primary"
              loading={save.isPending}
              onClick={() => form.submit()}
              data-testid="sku-save"
            >
              保存
            </Button>
          )
        }
      >
        <Form form={form} layout="vertical" disabled={!writable} onFinish={(v) => save.mutate(v)}>
          <Form.Item
            label="SKU 编码"
            name="code"
            rules={[
              { required: true },
              { pattern: /^[A-Za-z0-9._\-/]{1,64}$/, message: '只能包含字母、数字和 . _ - /' },
            ]}
          >
            <Input disabled={editing !== 'new'} data-testid="sku-code" />
          </Form.Item>
          <Form.Item label="名称" name="name" rules={[{ required: true }, { max: 128 }]}>
            <Input data-testid="sku-name" />
          </Form.Item>
          <Space wrap>
            <Form.Item label="规格" name="spec">
              <Input style={{ width: 200 }} />
            </Form.Item>
            <Form.Item label="单位" name="uom" rules={[{ max: 8 }]}>
              <Input style={{ width: 80 }} />
            </Form.Item>
            <Form.Item label="安全库存" name="safetyStock">
              <InputNumber min={0} precision={0} />
            </Form.Item>
          </Space>
          <Space wrap>
            <Form.Item label="长 mm" name="lengthMm">
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item label="宽 mm" name="widthMm">
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item label="高 mm" name="heightMm">
              <InputNumber min={1} precision={0} />
            </Form.Item>
            <Form.Item label="重量 g" name="weightG">
              <InputNumber min={1} precision={0} />
            </Form.Item>
          </Space>
          {editing !== 'new' && (
            <Form.Item label="启用" name="isActive" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          {editing === 'new' && (
            <Form.List name="barcodes">
              {(fields, { add, remove }) => (
                <>
                  {fields.map((f) => (
                    <Space key={f.key} align="baseline">
                      <Form.Item
                        name={[f.name, 'barcode']}
                        label="条码"
                        rules={[{ pattern: /^[\x21-\x7E]{1,64}$/, message: '可打印 ASCII，≤64' }]}
                      >
                        <Input style={{ width: 200 }} />
                      </Form.Item>
                      <Form.Item name={[f.name, 'packQty']} label="包装数">
                        <InputNumber min={1} precision={0} />
                      </Form.Item>
                      <Button type="link" onClick={() => remove(f.name)}>
                        删除
                      </Button>
                    </Space>
                  ))}
                  <Button onClick={() => add({ barcode: '', packQty: 1 })}>添加条码</Button>
                </>
              )}
            </Form.List>
          )}
        </Form>
        {editingSku && (
          <div style={{ marginTop: 16 }}>
            <b>条码</b>
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={editingSku.barcodes}
              columns={[
                { title: '条码', dataIndex: 'barcode' },
                { title: '包装数', dataIndex: 'packQty' },
                {
                  title: '主条码',
                  dataIndex: 'isPrimary',
                  render: (v: boolean) => (v ? '是' : ''),
                },
                {
                  title: '',
                  render: (_, b) =>
                    writable && (
                      <Popconfirm
                        title="删除该条码？"
                        onConfirm={() => delBarcode.mutate({ id: editingSku.id, barcodeId: b.id })}
                      >
                        <Button size="small" type="link" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    ),
                },
              ]}
            />
            {writable && (
              <Space.Compact style={{ marginTop: 8, width: '100%' }}>
                <Input
                  placeholder="扫描或输入新条码"
                  value={newBarcode}
                  onChange={(e) => setNewBarcode(e.target.value)}
                  onPressEnter={() =>
                    newBarcode.trim() &&
                    addBarcode.mutate({ id: editingSku.id, barcode: newBarcode.trim() })
                  }
                />
                <Button
                  loading={addBarcode.isPending}
                  disabled={!newBarcode.trim()}
                  onClick={() =>
                    addBarcode.mutate({ id: editingSku.id, barcode: newBarcode.trim() })
                  }
                >
                  添加
                </Button>
              </Space.Compact>
            )}
          </div>
        )}
      </Drawer>

      <SkuImportWizard
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onDone={() => void qc.invalidateQueries({ queryKey: ['skus'] })}
      />
    </div>
  );
}
