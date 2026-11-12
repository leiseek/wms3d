import { lazy, Suspense, useState } from 'react';
import { Alert, Button, Card, Input, List, Space, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import type { TwinModel } from '@wms3d/contracts';
import { api } from '../api';
import { useWarehouseId } from '../session';
import { PageHeader, useNotifyError } from '../components/common';
import { highlightIds } from '../lib/stock';

const TwinPanel = lazy(() => import('../twin/TwinPanel'));

/** 3D 大屏：SSE 实时刷新占用 + SKU 定位联动 + 点选仓位查看库存。 */
export default function TwinPage() {
  const warehouseId = useWarehouseId();
  const notify = useNotifyError();
  const [params, setParams] = useSearchParams();
  const [highlight, setHighlight] = useState<string[]>(() =>
    params.get('loc') ? [params.get('loc')!] : [],
  );
  const [found, setFound] = useState<
    { code: string; skuCode: string; qty: number; locationId: string }[]
  >([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [model, setModel] = useState<TwinModel | null>(null);
  const [searching, setSearching] = useState(false);

  const locate = async (q: string) => {
    if (!q) {
      setHighlight([]);
      setFound([]);
      return;
    }
    setSearching(true);
    try {
      const r = await api.r.locate({ query: { warehouseId, q } });
      const skuCode = new Map(r.skus.map((s) => [s.id, s.code]));
      setFound(
        r.items.map((i) => ({
          code: i.code,
          qty: i.qty,
          locationId: i.locationId,
          skuCode: skuCode.get(i.skuId) ?? '',
        })),
      );
      setHighlight(highlightIds(r.items));
      if (model && r.layoutVersion !== model.layoutVersion)
        notify(new Error('布局已更新，正在重新加载 3D 模型'));
      setParams({}, { replace: true });
    } catch (e) {
      notify(e);
    } finally {
      setSearching(false);
    }
  };

  const pickedBal = useQuery({
    queryKey: ['balances', warehouseId, 'loc', picked],
    queryFn: () => api.r.listBalances({ query: { warehouseId, locationId: picked!, limit: 50 } }),
    enabled: !!picked,
  });
  const pickedCode =
    picked && model ? model.locations.code[model.locations.id.indexOf(picked)] : null;

  return (
    <div data-testid="twin-page">
      <PageHeader
        title="3D 孪生"
        sub="实时库存占用；输入或扫描 SKU 在 3D 中点亮所在仓位"
        extra={
          <Input.Search
            placeholder="SKU 编码 / 名称 / 条码"
            enterButton="定位"
            allowClear
            loading={searching}
            style={{ width: 340 }}
            onSearch={(v) => void locate(v.trim())}
            data-testid="twin-locate"
          />
        }
      />
      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Suspense fallback={<Spin />}>
            <TwinPanel
              warehouseId={warehouseId}
              live
              highlight={highlight}
              height="calc(100vh - 190px)"
              onPick={setPicked}
              onModel={setModel}
            />
          </Suspense>
        </div>
        <div style={{ width: 280, flexShrink: 0 }}>
          <Card
            size="small"
            title={`定位结果（${highlight.length} 个仓位）`}
            extra={
              highlight.length > 0 && (
                <Button
                  size="small"
                  onClick={() => {
                    setHighlight([]);
                    setFound([]);
                  }}
                >
                  清除
                </Button>
              )
            }
          >
            {found.length ? (
              <List
                size="small"
                dataSource={found}
                data-testid="twin-found"
                renderItem={(f) => (
                  <List.Item
                    onClick={() => setHighlight([f.locationId])}
                    style={{ cursor: 'pointer' }}
                  >
                    <b style={{ fontFamily: 'monospace' }}>{f.code}</b>
                    <span>
                      {f.skuCode} × {f.qty}
                    </span>
                  </List.Item>
                )}
              />
            ) : (
              <Typography.Text type="secondary">
                {highlight.length ? '已高亮所选仓位' : '尚未定位'}
              </Typography.Text>
            )}
          </Card>
          {picked && (
            <Card
              size="small"
              style={{ marginTop: 12 }}
              title={
                <Space>
                  仓位 <b style={{ fontFamily: 'monospace' }}>{pickedCode ?? picked.slice(0, 8)}</b>
                </Space>
              }
              extra={
                <Button size="small" type="text" onClick={() => setPicked(null)}>
                  ×
                </Button>
              }
            >
              {pickedBal.isLoading ? (
                <Spin size="small" />
              ) : pickedBal.data?.items.length ? (
                pickedBal.data.items.map((b) => (
                  <div key={`${b.skuId}-${b.lotNo}`}>
                    <Tag>{b.skuCode}</Tag>
                    {b.skuName} × <b>{b.onHand}</b>
                  </div>
                ))
              ) : (
                <Alert type="info" title="空仓位" />
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
