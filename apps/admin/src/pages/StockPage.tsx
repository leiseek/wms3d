import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
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
import { errorMessage } from '../lib/errors';
import { highlightIds, summarizeBySku } from '../lib/stock';
import { toCsv } from '../lib/csv';
import { downloadText } from '../lib/download';
import { LocateDrawer } from '../twin/LocateDrawer';

interface LocateState {
  ids: string[];
  title: string;
  subtitle?: string;
}

function BySku({ warehouseId, onLocate }: { warehouseId: string; onLocate(s: LocateState): void }) {
  const [q, setQ] = useState('');
  const res = useQuery({
    queryKey: ['locate', warehouseId, q],
    queryFn: () => api.r.locate({ query: { warehouseId, q } }),
    enabled: !!q,
  });
  const summary = useMemo(() => {
    const d = res.data;
    if (!d) return [];
    const skuById = new Map(d.skus.map((s) => [s.id, s]));
    const rows = summarizeBySku(
      d.items.map((i) => ({
        locationId: i.locationId,
        locationCode: i.code,
        skuId: i.skuId,
        skuCode: skuById.get(i.skuId)?.code ?? '',
        skuName: skuById.get(i.skuId)?.name ?? '',
        onHand: i.qty,
      })),
    );
    // 无库存但匹配到的 SKU 也列出（总量 0）
    for (const s of d.skus)
      if (!rows.some((r) => r.skuId === s.id))
        rows.push({ skuId: s.id, skuCode: s.code, skuName: s.name, total: 0, locations: [] });
    return rows;
  }, [res.data]);

  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Input.Search
          placeholder="SKU 编码 / 名称 / 条码（支持扫码枪）"
          enterButton="查询"
          allowClear
          style={{ width: 380 }}
          onSearch={(v) => setQ(v.trim())}
          data-testid="stock-sku-search"
        />
        {res.data && res.data.items.length > 0 && (
          <Button
            type="primary"
            onClick={() =>
              onLocate({
                ids: highlightIds(res.data.items),
                title: `3D 定位：${q}`,
                subtitle: `${res.data.skus.length} 个 SKU，分布在 ${highlightIds(res.data.items).length} 个仓位`,
              })
            }
            data-testid="stock-locate-all"
          >
            全部在 3D 中定位
          </Button>
        )}
      </Space>
      {res.error && <Alert type="error" title={errorMessage(res.error)} />}
      {!q ? (
        <Empty description="输入或扫描 SKU 查询库存分布" />
      ) : (
        <Table
          rowKey="skuId"
          loading={res.isLoading}
          dataSource={summary}
          pagination={false}
          data-testid="stock-sku-table"
          expandable={{
            defaultExpandAllRows: true,
            rowExpandable: (r) => r.locations.length > 0,
            expandedRowRender: (r) => (
              <Table
                size="small"
                rowKey="locationId"
                pagination={false}
                dataSource={r.locations}
                columns={[
                  {
                    title: '仓位',
                    dataIndex: 'locationCode',
                    render: (c: string) => <b style={{ fontFamily: 'monospace' }}>{c}</b>,
                  },
                  { title: '数量', dataIndex: 'onHand' },
                  {
                    title: '',
                    render: (_, l) => (
                      <Button
                        size="small"
                        type="link"
                        onClick={() =>
                          onLocate({
                            ids: [l.locationId],
                            title: `3D 定位：${r.skuCode} @ ${l.locationCode}`,
                          })
                        }
                      >
                        在 3D 中定位
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          }}
          columns={[
            { title: 'SKU', dataIndex: 'skuCode' },
            { title: '名称', dataIndex: 'skuName' },
            { title: '总量', dataIndex: 'total', render: (n: number) => <b>{n}</b> },
            { title: '仓位数', render: (_, r) => r.locations.length },
            {
              title: '',
              render: (_, r) =>
                r.locations.length > 0 && (
                  <Button
                    size="small"
                    onClick={() =>
                      onLocate({
                        ids: r.locations.map((l) => l.locationId),
                        title: `3D 定位：${r.skuCode} ${r.skuName}`,
                        subtitle: `共 ${r.total}，${r.locations.length} 个仓位`,
                      })
                    }
                  >
                    在 3D 中定位
                  </Button>
                ),
            },
          ]}
        />
      )}
    </>
  );
}

function ByLocation({
  warehouseId,
  onLocate,
}: {
  warehouseId: string;
  onLocate(s: LocateState): void;
}) {
  const [q, setQ] = useState('');
  const loc = useQuery({
    queryKey: ['locations', warehouseId, 'find', q],
    queryFn: async () => {
      // 接受载荷形式（WH1.A03-17-C02）与裸编码
      const code = q.includes('.') ? q.slice(q.indexOf('.') + 1) : q;
      const r = await api.r.listLocations({
        params: { id: warehouseId },
        query: { q: code, limit: 20 },
      });
      return r.items.find((l) => l.code === code.toUpperCase()) ?? r.items[0] ?? null;
    },
    enabled: !!q,
  });
  const bal = useQuery({
    queryKey: ['balances', warehouseId, 'loc', loc.data?.id],
    queryFn: () =>
      api.r.listBalances({ query: { warehouseId, locationId: loc.data!.id, limit: 200 } }),
    enabled: !!loc.data,
  });
  const l = loc.data;
  return (
    <>
      <Input.Search
        placeholder="仓位编码或扫描仓位码"
        enterButton="查询"
        allowClear
        style={{ width: 360, marginBottom: 12 }}
        onSearch={(v) => setQ(v.trim())}
        data-testid="stock-loc-search"
      />
      {loc.error && <Alert type="error" title={errorMessage(loc.error)} />}
      {q && loc.data === null && <Empty description={`未找到仓位 ${q}`} />}
      {l && (
        <Card
          size="small"
          title={
            <Space>
              <b style={{ fontFamily: 'monospace' }}>{l.code}</b>
              {l.isActive ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
              <Typography.Text type="secondary">容量 {l.effectiveMax ?? '不限'}</Typography.Text>
            </Space>
          }
          extra={
            <Button onClick={() => onLocate({ ids: [l.id], title: `3D 定位：${l.code}` })}>
              在 3D 中定位
            </Button>
          }
        >
          <Table
            size="small"
            rowKey={(b) => `${b.skuId}-${b.lotNo}`}
            loading={bal.isLoading}
            pagination={false}
            dataSource={bal.data?.items ?? []}
            locale={{ emptyText: '空仓位' }}
            columns={[
              { title: 'SKU', dataIndex: 'skuCode' },
              { title: '名称', dataIndex: 'skuName' },
              { title: '批次', dataIndex: 'lotNo', render: (v: string) => v || '—' },
              { title: '数量', dataIndex: 'onHand' },
              { title: '更新时间', dataIndex: 'updatedAt', render: fmtTime },
            ]}
          />
        </Card>
      )}
    </>
  );
}

function AllBalances({
  warehouseId,
  onLocate,
}: {
  warehouseId: string;
  onLocate(s: LocateState): void;
}) {
  const me = useMe();
  const notify = useNotifyError();
  const pager = useCursorPager();
  const [zone, setZone] = useState<string | undefined>();
  const zones = useQuery({
    queryKey: ['zones', warehouseId],
    queryFn: () => api.r.listZones({ params: { id: warehouseId } }),
  });
  const list = useQuery({
    queryKey: ['balances', warehouseId, zone, pager.cursor],
    queryFn: () =>
      api.r.listBalances({ query: { warehouseId, zone, limit: 100, cursor: pager.cursor } }),
  });
  const [exporting, setExporting] = useState(false);
  const exportAll = async () => {
    setExporting(true);
    try {
      const rows: unknown[][] = [['location', 'sku', 'name', 'lot', 'on_hand', 'updated_at']];
      let cursor: string | undefined;
      for (let i = 0; i < 200; i++) {
        const r = await api.r.listBalances({ query: { warehouseId, zone, limit: 500, cursor } });
        for (const b of r.items)
          rows.push([b.locationCode, b.skuCode, b.skuName, b.lotNo, b.onHand, b.updatedAt]);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      downloadText(toCsv(rows), `balances-${zone ?? 'all'}.csv`);
    } catch (e) {
      notify(e);
    } finally {
      setExporting(false);
    }
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="全部库区"
          style={{ width: 140 }}
          options={(zones.data?.items ?? []).map((z) => ({ value: z.code, label: z.code }))}
          onChange={(v?: string) => {
            setZone(v);
            pager.reset();
          }}
        />
        {can(me, 'inventory.export') && (
          <Button loading={exporting} onClick={exportAll}>
            导出 CSV
          </Button>
        )}
      </Space>
      <Table
        size="small"
        rowKey={(b) => `${b.locationId}-${b.skuId}-${b.lotNo}`}
        loading={list.isLoading}
        pagination={false}
        dataSource={list.data?.items ?? []}
        columns={[
          {
            title: '仓位',
            dataIndex: 'locationCode',
            render: (c: string) => <b style={{ fontFamily: 'monospace' }}>{c}</b>,
          },
          { title: 'SKU', dataIndex: 'skuCode' },
          { title: '名称', dataIndex: 'skuName' },
          { title: '数量', dataIndex: 'onHand' },
          { title: '更新时间', dataIndex: 'updatedAt', render: fmtTime },
          {
            title: '',
            render: (_, b) => (
              <Button
                size="small"
                type="link"
                onClick={() =>
                  onLocate({
                    ids: [b.locationId],
                    title: `3D 定位：${b.skuCode} @ ${b.locationCode}`,
                  })
                }
              >
                在 3D 中定位
              </Button>
            ),
          },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />
    </>
  );
}

export default function StockPage() {
  const warehouseId = useWarehouseId();
  const [locate, setLocate] = useState<LocateState | null>(null);
  return (
    <div data-testid="stock-page">
      <PageHeader title="库存查询" sub="按 SKU 查分布、按仓位查明细；每行可在 3D 中定位" />
      <Tabs
        items={[
          {
            key: 'sku',
            label: '按 SKU',
            children: <BySku warehouseId={warehouseId} onLocate={setLocate} />,
          },
          {
            key: 'loc',
            label: '按仓位',
            children: <ByLocation warehouseId={warehouseId} onLocate={setLocate} />,
          },
          {
            key: 'all',
            label: '全部余额',
            children: <AllBalances warehouseId={warehouseId} onLocate={setLocate} />,
          },
        ]}
      />
      <LocateDrawer
        open={!!locate}
        onClose={() => setLocate(null)}
        warehouseId={warehouseId}
        highlight={locate?.ids ?? []}
        title={locate?.title ?? ''}
        {...(locate?.subtitle ? { subtitle: locate.subtitle } : {})}
      />
    </div>
  );
}
