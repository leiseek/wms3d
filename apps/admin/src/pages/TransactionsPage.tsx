import { useState } from 'react';
import { DatePicker, Input, Select, Space, Table, Tag } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { TxnType } from '@wms3d/contracts';
import { api } from '../api';
import { useWarehouseId } from '../session';
import { CursorPager, fmtTime, PageHeader, useCursorPager } from '../components/common';
import { TXN_TYPE_LABELS } from '../lib/stock';
import { TxnDrawer } from '../components/TxnDrawer';

export default function TransactionsPage() {
  const warehouseId = useWarehouseId();
  const pager = useCursorPager();
  const [f, setF] = useState<{ type?: TxnType; refNo?: string; from?: string; to?: string }>({});
  const [txnId, setTxnId] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['txns', warehouseId, f, pager.cursor],
    queryFn: () =>
      api.r.listTransactions({ query: { warehouseId, ...f, limit: 50, cursor: pager.cursor } }),
  });
  const upd = (p: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...p }));
    pager.reset();
  };
  return (
    <div data-testid="txns-page">
      <PageHeader title="交易单" sub="入库 / 出库 / 移库 / 调整 / 冲正；点击查看明细与来源设备" />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="类型"
          style={{ width: 140 }}
          options={Object.entries(TXN_TYPE_LABELS).map(([value, label]) => ({ value, label }))}
          onChange={(v?: TxnType) => upd({ type: v })}
        />
        <Input.Search
          placeholder="单号"
          allowClear
          style={{ width: 200 }}
          onSearch={(v) => upd({ refNo: v.trim() || undefined })}
        />
        <DatePicker.RangePicker
          showTime
          onChange={(v) => upd({ from: v?.[0]?.toISOString(), to: v?.[1]?.toISOString() })}
        />
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        onRow={(r) => ({ onClick: () => setTxnId(r.id), style: { cursor: 'pointer' } })}
        data-testid="txns-table"
        columns={[
          { title: '时间', dataIndex: 'createdAt', render: fmtTime },
          {
            title: '类型',
            dataIndex: 'type',
            render: (t: string, r) => (
              <>
                {TXN_TYPE_LABELS[t] ?? t}
                {r.reversedByTxnId && (
                  <Tag color="red" style={{ marginLeft: 6 }}>
                    已冲正
                  </Tag>
                )}
              </>
            ),
          },
          { title: '单号', dataIndex: 'refNo', render: (v: string | null) => v ?? '—' },
          { title: '行数', render: (_, r) => r.lines.length },
          { title: '数量合计', render: (_, r) => r.lines.reduce((n, l) => n + l.qtyDelta, 0) },
          {
            title: '设备',
            dataIndex: 'deviceId',
            render: (v: string | null, r) => (
              <>
                {v ?? '—'}
                {r.createdOffline && <Tag style={{ marginLeft: 6 }}>离线</Tag>}
              </>
            ),
          },
          { title: '备注', dataIndex: 'note', ellipsis: true },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />
      <TxnDrawer txnId={txnId} onClose={() => setTxnId(null)} onOpenTxn={setTxnId} />
    </div>
  );
}
