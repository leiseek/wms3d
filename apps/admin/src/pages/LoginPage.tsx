import { useState } from 'react';
import { Alert, Button, Card, Flex, Form, Input, Typography } from 'antd';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useSession } from '../session';
import { errorMessage } from '../lib/errors';

export default function LoginPage() {
  const { login, status, me } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  if (status === 'authenticated' && me && !loading)
    return <Navigate to={me.mustChangePassword ? '/change-password' : from} replace />;

  const onFinish = async (v: { username: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const u = await login(v.username, v.password);
      nav(u.mustChangePassword ? '/change-password' : from, { replace: true });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flex justify="center" align="center" style={{ minHeight: '100vh', background: '#f0f2f5' }}>
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          wms3d 管理后台
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          3D 数字孪生仓储系统
        </Typography.Paragraph>
        {error && (
          <Alert
            type="error"
            title={error}
            style={{ marginBottom: 16 }}
            data-testid="login-error"
          />
        )}
        <Form layout="vertical" onFinish={onFinish}>
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input autoComplete="username" data-testid="login-username" />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" data-testid="login-password" />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            block
            loading={loading}
            data-testid="login-submit"
          >
            登录
          </Button>
        </Form>
      </Card>
    </Flex>
  );
}
