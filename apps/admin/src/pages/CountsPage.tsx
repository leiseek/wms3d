import { useState } from 'react';
import {
  Alert,
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey } from '@wms3d/api-client';
import type { CountStatus, CountTask } from '@wms3d/contracts';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { can } from '../lib/rbac';
import { errorMessage } from '../lib/errors';
import { fmtTime, PageHeader, useNotifyError } from '../components/common';

const STATUS: Record<CountStatus, { color: string; label: string }> = {
  OPEN: { color: 'default', label: '待开始' },
  COUNTING: { color: 'processing', label: '盘点中' },
  REVIEW: { color: 'warning', label: '待审核' },
  CLOSED: { color: 'success', label: '已关闭' },
  CANCELLED: { color: 'default', label: '已取消' },
};

export default function CountsPage() {
  const { message } = AntApp.useApp();
  const notify = useNotifyError();
  const me = useMe();
  const warehouseId = useWarehouseId();
  const qc = useQueryClient();
  const mgr = can(me, 'inventory.adjust');
  const [status, setStatus] = useState<CountStatus | undefined>();
  const [open, setOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [form] = Form.useForm<{ zones: string[]; blind: boolean; note?: string }>();

  const list = useQuery({
    queryKey: ['counts', warehouseId, status],
    queryFn: () => api.r.listCounts({ query: { warehouseId, status, limit: 100 } }),
  });
  const zones = useQuery({
    queryKey: ['zones', warehouseId],
    queryFn: () => api.r.listZones({ params: { id: warehouseId } }),
  });
  const task = useQuery({
    queryKey: ['count', taskId],
    queryFn: () => api.r.getCount({ params: { id: taskId! } }),
    enabled: !!taskId,
  });
  const lines = useQuery({
    queryKey: ['count-lines', taskId],
    queryFn: () => api.r.listCountLines({ params: { id: taskId! }, query: { limit: 200 } }),
    enabled: !!taskId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['counts'] });
    void qc.invalidateQueries({ queryKey: ['count'] });
    void qc.invalidateQueries({ queryKey: ['count-lines'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const create = useMutation({
    mutationFn: (v: { zones: string[]; blind: boolean; note?: string }) =>
      api.r.createCount({
        body: {
          warehouseId,
          scope: { zones: v.zones, rackIds: [], locationIds: [] },
          blind: v.blind,
          ...(v.note ? { note: v.note } : {}),
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (t) => {
      message.success(`已创建 ${t.code}`);
      setOpen(false);
      form.resetFields();
      invalidate();
      setTaskId(t.id);
    },
    onError: notify,
  });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      message.success(ok);
      invalidate();
    } catch (e) {
      notify(e);
    }
  };

  const t = task.data;
  return (
    <div data-testid="counts-page">
      <PageHeader
        title="盘点"
        sub="创建任务、盲盘进度、差异审核、关闭生成盘点调整"
        extra={
          mgr ? (
            <Button type="primary" data-testid="counts-create" onClick={() => setOpen(true)}>
              新建盘点
            </Button>
          ) : null
        }
      />
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="状态"
          style={{ width: 140 }}
          value={status}
          onChange={setStatus}
          options={Object.entries(STATUS).map(([value, s]) => ({ value, label: s.label }))}
        />
      </Space>
      {list.error && (
        <Alert type="error" title={errorMessage(list.error)} style={{ marginBottom: 12 }} />
      )}
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        data-testid="counts-table"
        pagination={false}
        onRow={(r) => ({ onClick: () => setTaskId(r.id), style: { cursor: 'pointer' } })}
        columns={[
          { title: '单号', dataIndex: 'code', width: 120 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (s: CountStatus) => <Tag color={STATUS[s]!.color}>{STATUS[s]!.label}</Tag>,
          },
          {
            title: '盲盘',
            dataIndex: 'blind',
            width: 70,
            render: (b: boolean) => (b ? '是' : '否'),
          },
          {
            title: '进度',
            render: (_: unknown, r: CountTask) =>
              `${r.progress.locationsSubmitted} / ${r.progress.locationsTotal} 仓位`,
          },
          {
            title: '待审核行',
            render: (_: unknown, r: CountTask) => r.progress.linesNeedingReview,
          },
          { title: '创建', dataIndex: 'createdAt', render: fmtTime, width: 170 },
        ]}
      />

      <Modal
        title="新建盘点任务"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
        okText="创建"
        okButtonProps={{ 'data-testid': 'counts-create-ok' } as never}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ blind: true, zones: [] }}
          onFinish={(v) => create.mutate(v)}
        >
          <Form.Item
            name="zones"
            label="库区"
            rules={[{ required: true, message: '请选择至少一个库区' }]}
          >
            <Select
              mode="multiple"
              data-testid="counts-zones"
              options={(zones.data?.items ?? []).map((z) => ({
                value: z.code,
                label: `${z.code} ${z.name}`,
              }))}
            />
          </Form.Item>
          <Form.Item name="blind" label="盲盘" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input maxLength={200} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t ? `盘点 ${t.code}` : '盘点详情'}
        open={!!taskId}
        onCancel={() => setTaskId(null)}
        width={900}
        footer={
          t && mgr ? (
            <Space>
              {t.status === 'OPEN' && (
                <Button
                  type="primary"
                  data-testid="count-start"
                  onClick={() =>
                    void act(
                      () => api.r.startCount({ params: { id: t.id }, body: {} }),
                      '已开始盘点',
                    )
                  }
                >
                  开始
                </Button>
              )}
              {t.status === 'COUNTING' && (
                <Button
                  data-testid="count-review"
                  onClick={() =>
                    void act(
                      () => api.r.reviewCount({ params: { id: t.id }, body: {} }),
                      '已进入审核',
                    )
                  }
                >
                  提交审核
                </Button>
              )}
              {t.status === 'REVIEW' && (
                <Button
                  type="primary"
                  data-testid="count-close"
                  onClick={() =>
                    void act(
                      () =>
                        api.r.closeCount({
                          params: { id: t.id },
                          body: { confirmPendingOutbox: false },
                        }),
                      '已关闭，已过账盘点调整',
                    )
                  }
                >
                  关闭并过账调整
                </Button>
              )}
              {t.status !== 'CLOSED' && t.status !== 'CANCELLED' && (
                <Button
                  danger
                  data-testid="count-cancel"
                  onClick={() =>
                    void act(() => api.r.cancelCount({ params: { id: t.id }, body: {} }), '已取消')
                  }
                >
                  取消任务
                </Button>
              )}
              <Button onClick={() => setTaskId(null)}>关闭窗口</Button>
            </Space>
          ) : (
            <Button onClick={() => setTaskId(null)}>关闭</Button>
          )
        }
      >
        {t && (
          <>
            <Space wrap style={{ marginBottom: 12 }}>
              <Tag color={STATUS[t.status]!.color}>{STATUS[t.status]!.label}</Tag>
              <Typography.Text>
                进度 {t.progress.locationsSubmitted}/{t.progress.locationsTotal}，待审核{' '}
                {t.progress.linesNeedingReview} 行
              </Typography.Text>
              {t.closedTxnId && (
                <Typography.Text type="secondary">调整单 {t.closedTxnId}</Typography.Text>
              )}
            </Space>
            <Table
              rowKey="id"
              size="small"
              loading={lines.isLoading}
              dataSource={lines.data?.items ?? []}
              data-testid="count-lines"
              pagination={false}
              scroll={{ y: 360 }}
              columns={[
                { title: '仓位', dataIndex: 'locationCode', width: 130 },
                { title: 'SKU', dataIndex: 'skuCode', width: 110 },
                { title: '批次', dataIndex: 'lotNo', width: 80, render: (v: string) => v || '—' },
                { title: '实盘', dataIndex: 'countedQty', width: 70 },
                {
                  title: '系统（提交时）',
                  dataIndex: 'systemQtyAtCount',
                  width: 110,
                  render: (v: number | null) => (v == null ? '（盲盘隐藏）' : v),
                },
                {
                  title: '差异',
                  dataIndex: 'variance',
                  width: 70,
                  render: (v: number | null) =>
                    v == null ? (
                      '—'
                    ) : (
                      <span style={{ color: v === 0 ? undefined : '#cf1322' }}>{v}</span>
                    ),
                },
                {
                  title: '审核',
                  dataIndex: 'needsReview',
                  width: 70,
                  render: (v: boolean) => (v ? <Tag color="red">需复核</Tag> : '—'),
                },
                { title: '盘点时间', dataIndex: 'countedAt', render: fmtTime, width: 160 },
              ]}
            />
          </>
        )}
      </Modal>
    </div>
  );
}
