import { useState } from 'react';
import { Alert, App as AntApp, Button, Descriptions, Drawer, Input, Modal, Table, Tag } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newIdempotencyKey } from '@wms3d/api-client';
import { api } from '../api';
import { useMe } from '../session';
import { ADJUST_REASON_LABELS, reversalBlockedReason, TXN_TYPE_LABELS } from '../lib/stock';
import { errorMessage } from '../lib/errors';
import { fmtTime, useNotifyError } from './common';

/** 交易单详情 + 冲正（02 §6.4：冲正生成一张反向 REVERSAL 交易，原单不改）。 */
export function TxnDrawer(props: {
  txnId: string | null;
  onClose(): void;
  onOpenTxn?(id: string): void;
}) {
  const me = useMe();
  const qc = useQueryClient();
  const notify = useNotifyError();
  const { message } = AntApp.useApp();
  const [confirm, setConfirm] = useState<{ key: string; note: string } | null>(null);
  const txn = useQuery({
    queryKey: ['txn', props.txnId],
    queryFn: () => api.r.getTransaction({ params: { id: props.txnId! } }),
    enabled: !!props.txnId,
  });
  const reverse = useMutation({
    // 同一次确认（含网络重试）复用同一个幂等键
    mutationFn: (c: { key: string; note: string }) =>
      api.r.reverseTransaction({
        params: { id: props.txnId! },
        body: { note: c.note || undefined, clientCreatedAt: new Date().toISOString() },
        idempotencyKey: c.key,
      }),
    onSuccess: (r) => {
      void message.success(r.replayed ? '冲正已完成（重复提交，返回原结果）' : '已冲正');
      setConfirm(null);
      for (const k of ['txn', 'txns', 'movements', 'balances', 'locate', 'dashboard'])
        void qc.invalidateQueries({ queryKey: [k] });
    },
    onError: notify,
  });
  const t = txn.data;
  const blocked = t && me ? reversalBlockedReason(t, me.role) : null;
  const canReverse = me && me.role !== 'VIEWER';

  return (
    <Drawer
      open={!!props.txnId}
      onClose={props.onClose}
      size={720}
      title="交易单详情"
      destroyOnHidden
      extra={
        t &&
        canReverse && (
          <Button
            danger
            disabled={!!blocked}
            title={blocked ?? undefined}
            onClick={() => setConfirm({ key: newIdempotencyKey(), note: '' })}
            data-testid="txn-reverse"
          >
            冲正
          </Button>
        )
      }
    >
      {txn.error && <Alert type="error" title={errorMessage(txn.error)} />}
      {t && (
        <>
          <Descriptions size="small" column={2} bordered data-testid="txn-detail">
            <Descriptions.Item label="类型">
              <Tag color={t.type === 'REVERSAL' ? 'purple' : 'blue'}>
                {TXN_TYPE_LABELS[t.type] ?? t.type}
              </Tag>
              {t.reversedByTxnId && (
                <Tag color="red" data-testid="txn-reversed">
                  已冲正
                </Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="时间">{fmtTime(t.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="单号">{t.refNo ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="原因">
              {t.reason ? ADJUST_REASON_LABELS[t.reason] : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="来源设备">
              {t.deviceId ?? '—'}
              {t.createdOffline && <Tag style={{ marginLeft: 6 }}>离线补传</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="客户端时间">{fmtTime(t.clientCreatedAt)}</Descriptions.Item>
            <Descriptions.Item label="操作人">{t.performedBy.slice(0, 8)}</Descriptions.Item>
            <Descriptions.Item label="提交人">{t.submittedBy.slice(0, 8)}</Descriptions.Item>
            <Descriptions.Item label="备注" span={2}>
              {t.note ?? '—'}
            </Descriptions.Item>
            {(t.reversesTxnId || t.reversedByTxnId) && (
              <Descriptions.Item label="关联" span={2}>
                {t.reversesTxnId && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => props.onOpenTxn?.(t.reversesTxnId!)}
                  >
                    冲正的原单
                  </Button>
                )}
                {t.reversedByTxnId && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => props.onOpenTxn?.(t.reversedByTxnId!)}
                  >
                    对应冲正单
                  </Button>
                )}
              </Descriptions.Item>
            )}
          </Descriptions>
          <Table
            style={{ marginTop: 16 }}
            size="small"
            rowKey={(l) => `${l.locationId}-${l.skuId}-${l.qtyDelta}`}
            pagination={false}
            dataSource={t.lines}
            columns={[
              { title: '仓位', dataIndex: 'locationCode' },
              { title: 'SKU', dataIndex: 'skuCode' },
              {
                title: '变动',
                dataIndex: 'qtyDelta',
                render: (n: number) => (
                  <span style={{ color: n > 0 ? '#389e0d' : '#cf1322' }}>
                    {n > 0 ? `+${n}` : n}
                  </span>
                ),
              },
              { title: '结存', dataIndex: 'balanceAfter' },
            ]}
          />
        </>
      )}
      <Modal
        open={!!confirm}
        title="确认冲正"
        okText="冲正"
        okButtonProps={{ danger: true, ...({ 'data-testid': 'txn-reverse-ok' } as object) }}
        confirmLoading={reverse.isPending}
        onCancel={() => setConfirm(null)}
        onOk={() => confirm && reverse.mutate(confirm)}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="冲正会生成一张数量相反的冲正单，原单保留；冲正单不能再被冲正。"
        />
        <Input.TextArea
          placeholder="冲正原因（建议填写）"
          maxLength={500}
          value={confirm?.note}
          onChange={(e) => setConfirm((c) => (c ? { ...c, note: e.target.value } : c))}
        />
      </Modal>
    </Drawer>
  );
}
