import { useState } from 'react';
import { Alert, Button, Card, ConfigProvider, Form, Input, Layout, Result, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import type { Me } from '@wms3d/contracts';
import { ApiError } from '@wms3d/api-client';
import { api, deviceId, setAccessToken } from './api';

/** M0b 外壳：登录冒烟页（可由 `pnpm mock` 或真实 API 驱动）。功能页面从 M2（WS-B）开始。 */
export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.r.authLogin({ body: { ...v, deviceId: deviceId(), client: 'web' } });
      setAccessToken(r.accessToken);
      setMe(await api.r.me({}));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <ConfigProvider locale={zhCN}>
      <Layout style={{ minHeight: '100vh' }}>
        <Layout.Header style={{ color: '#fff' }}>wms3d · 3D 数字孪生 WMS</Layout.Header>
        <Layout.Content style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
          {me ? (
            <Result
              status="success"
              title={
                <span data-testid="welcome">
                  已登录：{me.displayName}（{me.role}）
                </span>
              }
              subTitle={
                <Typography.Text>
                  可访问仓库：{me.warehouses.map((w) => w.code).join('、') || '无'}
                </Typography.Text>
              }
            />
          ) : (
            <Card title="登录" style={{ width: 360 }}>
              {error && <Alert type="error" title={error} style={{ marginBottom: 16 }} />}
              <Form layout="vertical" onFinish={onFinish} initialValues={{ username: 'admin' }}>
                <Form.Item label="用户名" name="username" rules={[{ required: true }]}>
                  <Input autoComplete="username" />
                </Form.Item>
                <Form.Item label="密码" name="password" rules={[{ required: true }]}>
                  <Input.Password autoComplete="current-password" />
                </Form.Item>
                <Button type="primary" htmlType="submit" block loading={loading}>
                  登录
                </Button>
              </Form>
            </Card>
          )}
        </Layout.Content>
      </Layout>
    </ConfigProvider>
  );
}
