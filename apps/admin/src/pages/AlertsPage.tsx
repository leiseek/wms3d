import { Alert, Card, Empty, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useWarehouseId } from '../session';
import { errorMessage } from '../lib/errors';
import { PageHeader } from '../components/common';

export default function AlertsPage() {
  const warehouseId = useWarehouseId();
  const low = useQuery({
    queryKey: ['lowStock', warehouseId],
    queryFn: () => api.r.lowStock({ query: { warehouseId } }),
    refetchInterval: 30_000,
  });
  const items = low.data?.items ?? [];
  return (
    <div data-testid="alerts-page">
      <PageHeader title="低库存预警" sub="在库数量低于安全库存的 SKU" />
      {low.error && (
        <Alert type="error" title={errorMessage(low.error)} style={{ marginBottom: 16 }} />
      )}
      <Card>
        <Typography.Paragraph>
          共 <Tag color={items.length ? 'red' : 'green'}>{items.length}</Tag> 个 SKU 低于安全库存
        </Typography.Paragraph>
        <Table
          rowKey="skuId"
          size="small"
          loading={low.isLoading}
          dataSource={items}
          data-testid="alerts-table"
          pagination={false}
          locale={{ emptyText: <Empty description="没有低于安全库存的 SKU" /> }}
          columns={[
            { title: 'SKU', dataIndex: 'skuCode', width: 140 },
            { title: '名称', dataIndex: 'skuName', ellipsis: true },
            { title: '在库', dataIndex: 'onHand', width: 90 },
            { title: '安全库存', dataIndex: 'safetyStock', width: 100 },
            {
              title: '缺口',
              width: 90,
              render: (_: unknown, r: { onHand: number; safetyStock: number }) => (
                <span style={{ color: '#cf1322' }}>{r.safetyStock - r.onHand}</span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
