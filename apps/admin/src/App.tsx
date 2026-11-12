import { useEffect, useState } from 'react';
import { ConfigProvider, Layout, Result, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';

type Health = { status: string } | null;

/** M0a 外壳：显示 API 健康状态。功能页面从 M2 开始。 */
export function App() {
  const [health, setHealth] = useState<Health>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/health')
      .then((r) => r.json() as Promise<{ status: string }>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <ConfigProvider locale={zhCN}>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ color: '#fff' }}>wms3d · 3D 数字孪生 WMS</Layout.Header>
        <Layout.Content style={{ padding: 24 }}>
          <Result
            status={health ? 'success' : error ? 'warning' : 'info'}
            title="管理后台外壳（M0a）"
            subTitle={
              <Typography.Text>
                API：{health ? health.status : error ? `不可用（${error}）` : '检测中…'}
              </Typography.Text>
            }
          />
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
