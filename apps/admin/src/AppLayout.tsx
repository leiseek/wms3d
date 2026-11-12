import { useMemo, type ReactNode } from 'react';
import { Button, Dropdown, Flex, Layout, Menu, Select, Tag, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from './session';
import { navFor, ROLE_LABELS, type NavItem } from './lib/rbac';

function toMenu(items: NavItem[]): MenuProps['items'] {
  return items.map((i) =>
    i.children
      ? { key: i.key, label: i.label, children: toMenu(i.children) }
      : { key: i.path ?? i.key, label: <span data-testid={`nav-${i.key}`}>{i.label}</span> },
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { me, warehouseId, setWarehouse, logout } = useSession();
  const nav = useNavigate();
  const loc = useLocation();
  const qc = useQueryClient();
  const items = useMemo(() => (me ? navFor(me.role) : []), [me]);
  const open = useMemo(() => items.filter((i) => i.children).map((i) => i.key), [items]);

  if (!me) return <>{children}</>;
  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider width={208} theme="light" breakpoint="lg" collapsedWidth={0}>
        <div style={{ padding: '16px 20px', fontWeight: 600, fontSize: 16 }}>wms3d 管理后台</div>
        <Menu
          mode="inline"
          selectedKeys={[loc.pathname]}
          defaultOpenKeys={open}
          items={toMenu(items)}
          onClick={(e) => nav(e.key)}
          data-testid="side-menu"
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header
          style={{ background: '#fff', padding: '0 20px', borderBottom: '1px solid #f0f0f0' }}
        >
          <Flex justify="space-between" align="center" style={{ height: '100%' }}>
            <Flex align="center" gap={8}>
              <Typography.Text type="secondary">仓库</Typography.Text>
              <Select
                data-testid="warehouse-switch"
                style={{ minWidth: 180 }}
                value={warehouseId ?? undefined}
                placeholder="无可访问仓库"
                options={me.warehouses.map((w) => ({
                  value: w.id,
                  label: `${w.code} · ${w.name}`,
                }))}
                onChange={(v: string) => {
                  setWarehouse(v);
                  void qc.invalidateQueries();
                }}
              />
            </Flex>
            <Dropdown
              menu={{
                items: [
                  { key: 'pwd', label: '修改密码' },
                  { key: 'logout', label: '退出登录' },
                ],
                onClick: async ({ key }) => {
                  if (key === 'pwd') nav('/change-password');
                  else {
                    await logout();
                    qc.clear();
                    nav('/login');
                  }
                },
              }}
            >
              <Button type="text" data-testid="user-menu">
                {me.displayName} <Tag style={{ marginLeft: 6 }}>{ROLE_LABELS[me.role]}</Tag>
              </Button>
            </Dropdown>
          </Flex>
        </Layout.Header>
        <Layout.Content style={{ padding: 20 }}>
          {warehouseId ? (
            children
          ) : (
            <Typography.Text type="warning">
              当前账号没有任何仓库权限，请联系管理员。
            </Typography.Text>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
