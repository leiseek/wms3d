import { Alert, Card, Col, Empty, Progress, Row, Statistic, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../api';
import { useWarehouseId } from '../session';
import { fmtTime, PageHeader } from '../components/common';
import { errorMessage } from '../lib/errors';
import { TXN_TYPE_LABELS } from '../lib/stock';

export default function DashboardPage() {
  const warehouseId = useWarehouseId();
  const dash = useQuery({
    queryKey: ['dashboard', warehouseId],
    queryFn: () => api.r.dashboard({ query: { warehouseId } }),
    refetchInterval: 30_000,
  });
  const low = useQuery({
    queryKey: ['lowStock', warehouseId],
    queryFn: () => api.r.lowStock({ query: { warehouseId } }),
  });
  const recent = useQuery({
    queryKey: ['movements', warehouseId, 'recent'],
    queryFn: () => api.r.listMovements({ query: { warehouseId, limit: 8 } }),
  });
  const d = dash.data;
  const util =
    d && d.locations.total ? Math.round((d.locations.occupied / d.locations.total) * 100) : 0;

  return (
    <div data-testid="dashboard">
      <PageHeader title="看板" sub={d ? `数据时间 ${fmtTime(d.asOf)}` : undefined} />
      {dash.error && (
        <Alert type="error" title={errorMessage(dash.error)} style={{ marginBottom: 16 }} />
      )}
      <Row gutter={[16, 16]} data-testid="dashboard-kpis">
        <Col xs={12} md={6}>
          <Card loading={dash.isLoading}>
            <Statistic title="今日入库（单）" value={d?.today.inbound ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card loading={dash.isLoading}>
            <Statistic title="今日出库（单）" value={d?.today.outbound ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card loading={dash.isLoading}>
            <Statistic title="在库 SKU" value={d?.skusInStock ?? 0} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card loading={dash.isLoading}>
            <Statistic title="在库总数量" value={d?.totalOnHand ?? 0} />
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="仓位利用率" loading={dash.isLoading}>
            <Progress type="dashboard" percent={util} />
            <Typography.Paragraph style={{ margin: 0 }}>
              有货 {d?.locations.occupied ?? 0} / 共 {d?.locations.total ?? 0} 个仓位，停用{' '}
              {d?.locations.inactive ?? 0} 个
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card title="运行状态" loading={dash.isLoading}>
            <Typography.Paragraph>
              待同步设备 <b>{d?.pendingSync.devices ?? 0}</b> 台 / 单据{' '}
              <b>{d?.pendingSync.records ?? 0}</b> 条
            </Typography.Paragraph>
            <Typography.Paragraph>
              待补打标签 <Link to="/labels">{d?.pendingReprints ?? 0} 张</Link>
            </Typography.Paragraph>
            <Typography.Paragraph>
              对账：{fmtTime(d?.reconcile.lastRunAt)}{' '}
              {d?.reconcile.mismatches ? (
                <Tag color="red">差异 {d.reconcile.mismatches}</Tag>
              ) : (
                <Tag color="green">无差异</Tag>
              )}
            </Typography.Paragraph>
            <Typography.Paragraph style={{ margin: 0 }}>
              备份：本地 {fmtTime(d?.backup.lastLocalAt)}
              {d && !d.backup.remoteConfigured && (
                <Tag color="orange" style={{ marginLeft: 6 }}>
                  未配置异地备份
                </Tag>
              )}
            </Typography.Paragraph>
          </Card>
        </Col>
        <Col xs={24} md={8} data-testid="dashboard-low-stock">
          <Card
            title={`低库存 Top10（共 ${d?.lowStockCount ?? 0}）`}
            extra={
              <Link to="/alerts" data-testid="dashboard-alerts-link">
                全部预警
              </Link>
            }
            loading={low.isLoading}
            styles={{ body: { padding: 0 } }}
          >
            <Table
              size="small"
              rowKey="skuId"
              pagination={false}
              dataSource={(low.data?.items ?? []).slice(0, 10)}
              locale={{ emptyText: <Empty description="没有低于安全库存的 SKU" /> }}
              columns={[
                { title: 'SKU', dataIndex: 'skuCode' },
                { title: '名称', dataIndex: 'skuName', ellipsis: true },
                {
                  title: '在库/安全',
                  render: (_, r) => (
                    <span style={{ color: '#cf1322' }}>
                      {r.onHand}/{r.safetyStock}
                    </span>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={24}>
          <Card title="最近流水" extra={<Link to="/movements">查看全部</Link>}>
            <Table
              size="small"
              rowKey="id"
              loading={recent.isLoading}
              pagination={false}
              dataSource={recent.data?.items ?? []}
              columns={[
                { title: '时间', dataIndex: 'createdAt', render: fmtTime },
                {
                  title: '类型',
                  dataIndex: 'txnType',
                  render: (t: string) => TXN_TYPE_LABELS[t] ?? t,
                },
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
          </Card>
        </Col>
      </Row>
    </div>
  );
}
