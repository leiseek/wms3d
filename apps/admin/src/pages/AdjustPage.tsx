import { useRef, useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey } from '@wms3d/api-client';
import type { TxnResult } from '@wms3d/contracts';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { ADJUST_REASON_LABELS } from '../lib/stock';
import { PageHeader, useNotifyError } from '../components/common';
import { useLocationOptions, useSkuOptions } from '../components/pickers';

type Reason = 'DAMAGE' | 'LOST' | 'FOUND' | 'EXPIRED' | 'DATA_FIX' | 'OTHER';

/**
 * 幂等键：每张“单据”一个键，表单提交失败重试复用同一键，成功后才换新键（03 §4.1）。
 */
function useIdemKey() {
  const k = useRef(newIdempotencyKey());
  return { get: () => k.current, renew: () => (k.current = newIdempotencyKey()) };
}

function ResultLine({ r }: { r: TxnResult | null }) {
  if (!r) return null;
  return (
    <Alert
      type="success"
      showIcon
      style={{ marginTop: 12 }}
      data-testid="txn-result"
      title={`${r.replayed ? '（重复提交，返回原结果）' : ''}已过账：${r.txn.lines.map((l) => `${l.locationCode} ${l.skuCode} ${l.qtyDelta > 0 ? '+' : ''}${l.qtyDelta} → ${l.balanceAfter}`).join('；')}`}
    />
  );
}

function AdjustForm({ warehouseId }: { warehouseId: string }) {
  const me = useMe()!;
  const qc = useQueryClient();
  const notify = useNotifyError();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const key = useIdemKey();
  const [last, setLast] = useState<TxnResult | null>(null);
  const sku = useSkuOptions();
  const loc = useLocationOptions(warehouseId, { activeOnly: true });
  const m = useMutation({
    mutationFn: (v: {
      locationId: string;
      skuId: string;
      qtyDelta: number;
      reason: Reason;
      note?: string;
      refNo?: string;
    }) =>
      api.r.postTransaction({
        idempotencyKey: key.get(),
        body: {
          type: 'ADJUST',
          warehouseId,
          performedBy: me.id,
          clientCreatedAt: new Date().toISOString(),
          reason: v.reason,
          note: v.note || undefined,
          refNo: v.refNo || undefined,
          lines: [{ locationId: v.locationId, skuId: v.skuId, qtyDelta: v.qtyDelta }],
        },
      }) as Promise<TxnResult>,
    onSuccess: (r) => {
      key.renew();
      setLast(r);
      form.resetFields(['qtyDelta', 'note', 'refNo']);
      void message.success('调整已过账');
      for (const k of ['balances', 'movements', 'txns', 'locate', 'dashboard'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: notify,
  });
  const reason = Form.useWatch('reason', form) as Reason | undefined;
  return (
    <Card
      title="库存调整"
      extra={<Typography.Text type="secondary">仅主管；必须选择原因</Typography.Text>}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(v) => m.mutate(v)}
        initialValues={{ reason: 'DAMAGE' }}
      >
        <Form.Item label="仓位" name="locationId" rules={[{ required: true }]}>
          <Select {...loc.props} placeholder="搜索仓位编码" />
        </Form.Item>
        <Form.Item label="SKU" name="skuId" rules={[{ required: true }]}>
          <Select {...sku.props} placeholder="搜索 SKU" />
        </Form.Item>
        <Form.Item
          label="调整量（正数增加，负数减少）"
          name="qtyDelta"
          rules={[
            { required: true },
            {
              validator: (_r, v: number) =>
                v === 0 ? Promise.reject(new Error('不能为 0')) : Promise.resolve(),
            },
          ]}
        >
          <InputNumber precision={0} min={-1_000_000} max={1_000_000} style={{ width: 200 }} />
        </Form.Item>
        <Form.Item label="原因" name="reason" rules={[{ required: true }]}>
          <Select
            options={Object.entries(ADJUST_REASON_LABELS).map(([value, label]) => ({
              value,
              label,
            }))}
          />
        </Form.Item>
        <Form.Item
          label="单号"
          name="refNo"
          rules={[{ required: reason === 'DATA_FIX', message: '数据修正必须填写单号' }]}
        >
          <Input maxLength={64} />
        </Form.Item>
        <Form.Item
          label="备注"
          name="note"
          rules={[{ required: reason === 'OTHER', message: '原因为“其他”时必须填写备注' }]}
        >
          <Input.TextArea maxLength={500} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={m.isPending}>
          提交调整
        </Button>
      </Form>
      <ResultLine r={last} />
    </Card>
  );
}

function TransferForm({ warehouseId }: { warehouseId: string }) {
  const me = useMe()!;
  const qc = useQueryClient();
  const notify = useNotifyError();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const key = useIdemKey();
  const [last, setLast] = useState<TxnResult | null>(null);
  const from = useLocationOptions(warehouseId);
  const to = useLocationOptions(warehouseId, { activeOnly: true });
  const fromId = Form.useWatch('fromLocationId', form) as string | undefined;
  const bal = useQuery({
    queryKey: ['balances', warehouseId, 'loc', fromId],
    queryFn: () => api.r.listBalances({ query: { warehouseId, locationId: fromId!, limit: 200 } }),
    enabled: !!fromId,
  });
  const m = useMutation({
    mutationFn: (v: {
      fromLocationId: string;
      toLocationId: string;
      skuId: string;
      qty: number;
      note?: string;
    }) =>
      api.r.postTransaction({
        idempotencyKey: key.get(),
        body: {
          type: 'TRANSFER',
          warehouseId,
          performedBy: me.id,
          clientCreatedAt: new Date().toISOString(),
          note: v.note || undefined,
          lines: [
            {
              fromLocationId: v.fromLocationId,
              toLocationId: v.toLocationId,
              skuId: v.skuId,
              qty: v.qty,
            },
          ],
        },
      }) as Promise<TxnResult>,
    onSuccess: (r) => {
      key.renew();
      setLast(r);
      form.resetFields(['qty', 'note']);
      void message.success('移库已过账');
      for (const k of ['balances', 'movements', 'txns', 'locate', 'dashboard'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: notify,
  });
  return (
    <Card title="移库">
      <Form form={form} layout="vertical" onFinish={(v) => m.mutate(v)}>
        <Form.Item label="从仓位" name="fromLocationId" rules={[{ required: true }]}>
          <Select
            {...from.props}
            placeholder="搜索源仓位"
            onChange={() => form.setFieldValue('skuId', undefined)}
          />
        </Form.Item>
        <Form.Item label="SKU（源仓位现有库存）" name="skuId" rules={[{ required: true }]}>
          <Select
            placeholder={fromId ? '选择 SKU' : '先选源仓位'}
            loading={bal.isLoading}
            options={(bal.data?.items ?? [])
              .filter((b) => b.onHand > 0)
              .map((b) => ({ value: b.skuId, label: `${b.skuCode} ${b.skuName}（${b.onHand}）` }))}
          />
        </Form.Item>
        <Form.Item
          label="到仓位"
          name="toLocationId"
          dependencies={['fromLocationId']}
          rules={[
            { required: true },
            ({ getFieldValue }) => ({
              validator: (_r, v: string) =>
                v && v === getFieldValue('fromLocationId')
                  ? Promise.reject(new Error('目标不能与源相同'))
                  : Promise.resolve(),
            }),
          ]}
        >
          <Select {...to.props} placeholder="搜索目标仓位" />
        </Form.Item>
        <Form.Item label="数量" name="qty" rules={[{ required: true }]}>
          <InputNumber min={1} precision={0} style={{ width: 200 }} />
        </Form.Item>
        <Form.Item label="备注" name="note">
          <Input maxLength={500} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={m.isPending}>
          提交移库
        </Button>
      </Form>
      <ResultLine r={last} />
    </Card>
  );
}

export default function AdjustPage() {
  const warehouseId = useWarehouseId();
  return (
    <div>
      <PageHeader title="调整 / 移库" sub="PC 端过账；每张单据带幂等键，重复提交不会重复记账" />
      <Row gutter={16}>
        <Col xs={24} lg={12}>
          <AdjustForm warehouseId={warehouseId} />
        </Col>
        <Col xs={24} lg={12}>
          <TransferForm warehouseId={warehouseId} />
        </Col>
      </Row>
    </div>
  );
}
