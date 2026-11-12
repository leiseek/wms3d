import { useState } from 'react';
import { Alert, App as AntApp, Button, Card, Flex, Form, Input, Typography } from 'antd';
import { Navigate, useNavigate } from 'react-router';
import { api } from '../api';
import { useSession } from '../session';
import { toErrorView } from '../lib/errors';

/** 强制改密（mustChangePassword）与主动改密共用。 */
export default function ChangePasswordPage() {
  const { me, status, reloadMe, logout } = useSession();
  const nav = useNavigate();
  const { message } = AntApp.useApp();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();
  if (status === 'booting') return null;
  if (status !== 'authenticated' || !me) return <Navigate to="/login" replace />;
  const forced = me.mustChangePassword;

  const onFinish = async (v: { currentPassword: string; newPassword: string }) => {
    setLoading(true);
    setError(null);
    try {
      await api.r.changePassword({
        body: { currentPassword: v.currentPassword, newPassword: v.newPassword },
      });
      await reloadMe();
      void message.success('密码已修改');
      nav('/', { replace: true });
    } catch (e) {
      // v1.2：口令错误 / 新旧相同 → 400 VALIDATION_FAILED，errors[].path 指向字段，标在对应输入框上
      const v = toErrorView(e);
      const known = v.fields.filter((f) => /(currentPassword|newPassword)$/.test(f.path));
      if (known.length)
        form.setFields(
          known.map((f) => ({
            name: f.path.endsWith('currentPassword') ? 'currentPassword' : 'newPassword',
            errors: [f.message],
          })),
        );
      else setError(v.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flex justify="center" align="center" style={{ minHeight: '100vh', background: '#f0f2f5' }}>
      <Card style={{ width: 420 }} title={forced ? '首次登录请修改密码' : '修改密码'}>
        {forced && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="管理员为你设置了临时密码，修改后才能继续使用系统。"
            data-testid="force-change-hint"
          />
        )}
        {error && <Alert type="error" title={error} style={{ marginBottom: 16 }} />}
        <Form form={form} layout="vertical" onFinish={onFinish}>
          <Form.Item label="当前密码" name="currentPassword" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" data-testid="pwd-current" />
          </Form.Item>
          <Form.Item
            label="新密码"
            name="newPassword"
            rules={[
              { required: true },
              { min: 8, message: '至少 8 位' },
              ({ getFieldValue }) => ({
                validator: (_r, v: string) =>
                  v && v === getFieldValue('currentPassword')
                    ? Promise.reject(new Error('新密码不能与当前密码相同'))
                    : Promise.resolve(),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" data-testid="pwd-new" />
          </Form.Item>
          <Form.Item
            label="确认新密码"
            name="confirm"
            dependencies={['newPassword']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator: (_r, v: string) =>
                  v === getFieldValue('newPassword')
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入不一致')),
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" data-testid="pwd-confirm" />
          </Form.Item>
          <Flex gap={8}>
            <Button type="primary" htmlType="submit" loading={loading} data-testid="pwd-submit">
              确认修改
            </Button>
            {forced ? (
              <Button onClick={() => void logout().then(() => nav('/login'))}>退出登录</Button>
            ) : (
              <Button onClick={() => nav(-1)}>返回</Button>
            )}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
            密码至少 8 位，不能与当前密码相同。
          </Typography.Paragraph>
        </Form>
      </Card>
    </Flex>
  );
}
