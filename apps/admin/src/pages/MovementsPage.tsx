import { useState } from 'react';
import { Button, DatePicker, Select, Space, Table } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { can } from '../lib/rbac';
import {
  CursorPager,
  fmtTime,
  PageHeader,
  useCursorPager,
  useNotifyError,
} from '../components/common';
import { TXN_TYPE_LABELS } from '../lib/stock';
import { downloadBlob, filenameFrom } from '../lib/download';
import { TxnDrawer } from '../components/TxnDrawer';
import { useSkuOptions, useLocationOptions } from '../components/pickers';

/** 流水台账（keyset 分页 + CSV 导出）。点击行查看交易单与冲正。 */
export default function MovementsPage() {
  const warehouseId = useWarehouseId();
  const me = useMe();
  const notify = useNotifyError();
  const pager = useCursorPager();
  const [f, setF] = useState<{ skuId?: string; locationId?: string; from?: string; to?: string }>(
    {},
  );
  const [txnId, setTxnId] = useState<string | null>(null);
  const sku = useSkuOptions();
  const loc = useLocationOptions(warehouseId);
  const list = useQuery({
    queryKey: ['movements', warehouseId, f, pager.cursor],
    queryFn: () =>
      api.r.listMovements({ query: { warehouseId, ...f, limit: 50, cursor: pager.cursor } }),
  });
  const upd = (p: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...p }));
    pager.reset();
  };
  const exportCsv = async () => {
    try {
      const res = await api.r.exportMovements({ query: { warehouseId, ...f } });
      downloadBlob(await res.blob(), filenameFrom(res, 'movements.csv'));
    } catch (e) {
      notify(e);
    }
  };
  return (
    <div data-testid="movements-page">
      <PageHeader
        title="流水台账"
        sub="每一次库存变动一行（只增不改）；点击行查看交易单"
        extra={
          can(me, 'inventory.export') && (
            <Button onClick={exportCsv} data-testid="movements-export">
              导出 CSV
            </Button>
          )
        }
      />
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          {...sku.props}
          placeholder="SKU"
          style={{ width: 220 }}
          onChange={(v) => upd({ skuId: v })}
          data-testid="mv-sku"
        />
        <Select
          {...loc.props}
          placeholder="仓位"
          style={{ width: 200 }}
          onChange={(v) => upd({ locationId: v })}
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
        onRow={(r) => ({ onClick: () => setTxnId(r.txnId), style: { cursor: 'pointer' } })}
        data-testid="movements-table"
        columns={[
          { title: '时间', dataIndex: 'createdAt', render: fmtTime },
          { title: '类型', dataIndex: 'txnType', render: (t: string) => TXN_TYPE_LABELS[t] ?? t },
          { title: '仓位', dataIndex: 'locationCode' },
          { title: 'SKU', dataIndex: 'skuCode' },
          {
            title: '变动',
            dataIndex: 'qtyDelta',
            render: (n: number) => (
              <span style={{ color: n > 0 ? '#389e0d' : '#cf1322' }}>{n > 0 ? `+${n}` : n}</span>
            ),
          },
          { title: '结存', dataIndex: 'balanceAfter' },
          { title: '操作人', dataIndex: 'performedBy', render: (v: string) => v.slice(0, 8) },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />
      <TxnDrawer txnId={txnId} onClose={() => setTxnId(null)} onOpenTxn={setTxnId} />
    </div>
  );
}
