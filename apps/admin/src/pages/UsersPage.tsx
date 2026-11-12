import { useState } from 'react';
import {
  App as AntApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, User } from '@wms3d/contracts';
import { api } from '../api';
import { useMe } from '../session';
import { ROLE_LABELS } from '../lib/rbac';
import {
  CursorPager,
  fmtTime,
  PageHeader,
  useCursorPager,
  useNotifyError,
} from '../components/common';

type UForm = {
  username?: string;
  displayName: string;
  role: Role;
  allWarehouses: boolean;
  warehouseIds: string[];
  temporaryPassword?: string;
  isActive?: boolean;
};

function Users() {
  const me = useMe();
  const qc = useQueryClient();
  const notify = useNotifyError();
  const { message } = AntApp.useApp();
  const pager = useCursorPager();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [form] = Form.useForm<UForm>();
  const [pwdForm] = Form.useForm<{ temporaryPassword: string }>();
  const whs = useQuery({ queryKey: ['warehouses'], queryFn: () => api.r.listWarehouses({}) });
  const list = useQuery({
    queryKey: ['users', q, pager.cursor],
    queryFn: () =>
      api.r.listUsers({ query: { q: q || undefined, limit: 50, cursor: pager.cursor } }),
  });
  const save = useMutation({
    mutationFn: (v: UForm) =>
      editing === 'new'
        ? api.r.createUser({
            body: {
              username: v.username!,
              displayName: v.displayName,
              role: v.role,
              allWarehouses: v.allWarehouses,
              warehouseIds: v.allWarehouses ? [] : v.warehouseIds,
              temporaryPassword: v.temporaryPassword!,
            },
          })
        : api.r.patchUser({
            params: { id: (editing as User).id },
            body: {
              displayName: v.displayName,
              role: v.role,
              allWarehouses: v.allWarehouses,
              warehouseIds: v.allWarehouses ? [] : v.warehouseIds,
              isActive: v.isActive ?? true,
            },
          }),
    onSuccess: () => {
      void message.success(editing === 'new' ? '用户已创建，首次登录需修改密码' : '已保存');
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: notify,
  });
  const reset = useMutation({
    mutationFn: (v: { temporaryPassword: string }) =>
      api.r.resetPassword({ params: { id: resetting!.id }, body: v }),
    onSuccess: () => {
      void message.success('已重置，用户下次登录需修改密码');
      setResetting(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: notify,
  });
  const allWh = Form.useWatch('allWarehouses', form) as boolean | undefined;
  const open = (u: User | 'new') => {
    setEditing(u);
    form.resetFields();
    form.setFieldsValue(
      u === 'new'
        ? { role: 'OPERATOR', allWarehouses: false, warehouseIds: [] }
        : { ...u, warehouseIds: u.warehouses.map((w) => w.id) },
    );
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder="用户名 / 姓名"
          allowClear
          onSearch={(v) => {
            setQ(v.trim());
            pager.reset();
          }}
        />
        <Button type="primary" onClick={() => open('new')} data-testid="user-new">
          新建用户
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        data-testid="users-table"
        columns={[
          { title: '用户名', dataIndex: 'username' },
          { title: '姓名', dataIndex: 'displayName' },
          { title: '角色', dataIndex: 'role', render: (r: Role) => <Tag>{ROLE_LABELS[r]}</Tag> },
          {
            title: '仓库',
            render: (_, u) =>
              u.allWarehouses ? '全部' : u.warehouses.map((w) => w.code).join('、') || '—',
          },
          {
            title: '状态',
            render: (_, u) => (
              <>
                {u.isActive ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>}
                {u.mustChangePassword && <Tag color="orange">待改密</Tag>}
              </>
            ),
          },
          { title: '更新', dataIndex: 'updatedAt', render: fmtTime },
          {
            title: '',
            render: (_, u) => (
              <Space>
                <Button size="small" type="link" onClick={() => open(u)}>
                  编辑
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    pwdForm.resetFields();
                    setResetting(u);
                  }}
                >
                  重置密码
                </Button>
              </Space>
            ),
          },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />
      <Modal
        open={!!editing}
        title={editing === 'new' ? '新建用户' : '编辑用户'}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
        okButtonProps={{ ...({ 'data-testid': 'user-save' } as object) }}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item
            label="用户名"
            name="username"
            rules={[
              { required: editing === 'new' },
              { pattern: /^[A-Za-z0-9_.-]{2,64}$/, message: '2–64 位字母数字 _ . -' },
            ]}
          >
            <Input disabled={editing !== 'new'} data-testid="user-username" />
          </Form.Item>
          <Form.Item label="姓名" name="displayName" rules={[{ required: true }]}>
            <Input data-testid="user-display" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select
              options={(Object.keys(ROLE_LABELS) as Role[]).map((r) => ({
                value: r,
                label: ROLE_LABELS[r],
              }))}
              disabled={editing !== 'new' && editing?.id === me?.id}
            />
          </Form.Item>
          <Form.Item label="可访问全部仓库" name="allWarehouses" valuePropName="checked">
            <Switch />
          </Form.Item>
          {!allWh && (
            <Form.Item label="仓库" name="warehouseIds">
              <Select
                mode="multiple"
                options={(whs.data?.items ?? []).map((w) => ({
                  value: w.id,
                  label: `${w.code} ${w.name}`,
                }))}
                data-testid="user-warehouses"
              />
            </Form.Item>
          )}
          {editing === 'new' ? (
            <Form.Item
              label="临时密码（首次登录强制修改）"
              name="temporaryPassword"
              rules={[{ required: true }, { min: 8, message: '至少 8 位' }]}
            >
              <Input.Password data-testid="user-temp-password" />
            </Form.Item>
          ) : (
            <Form.Item label="启用" name="isActive" valuePropName="checked">
              <Switch disabled={editing?.id === me?.id} />
            </Form.Item>
          )}
        </Form>
      </Modal>
      <Modal
        open={!!resetting}
        title={`重置密码：${resetting?.username ?? ''}`}
        onCancel={() => setResetting(null)}
        onOk={() => pwdForm.submit()}
        confirmLoading={reset.isPending}
        destroyOnHidden
      >
        <Form form={pwdForm} layout="vertical" onFinish={(v) => reset.mutate(v)}>
          <Form.Item
            label="临时密码"
            name="temporaryPassword"
            rules={[{ required: true }, { min: 8, message: '至少 8 位' }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function Devices() {
  const qc = useQueryClient();
  const notify = useNotifyError();
  const list = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.r.listDevices({}),
    refetchInterval: 30_000,
  });
  const patch = useMutation({
    mutationFn: (p: { id: string; disabled?: boolean; name?: string }) => {
      const { id, ...body } = p;
      return api.r.patchDevice({ params: { id }, body });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['devices'] }),
    onError: notify,
  });
  return (
    <Table
      rowKey="id"
      size="small"
      loading={list.isLoading}
      dataSource={list.data?.items ?? []}
      pagination={{ pageSize: 20 }}
      data-testid="devices-table"
      columns={[
        {
          title: '设备 ID',
          dataIndex: 'id',
          render: (v: string) => <span style={{ fontFamily: 'monospace' }}>{v}</span>,
        },
        {
          title: '名称',
          dataIndex: 'name',
          render: (v: string | null, d) => (
            <Input
              size="small"
              defaultValue={v ?? ''}
              placeholder="未命名"
              style={{ width: 140 }}
              onBlur={(e) =>
                e.target.value !== (v ?? '') && patch.mutate({ id: d.id, name: e.target.value })
              }
            />
          ),
        },
        { title: '型号', dataIndex: 'model' },
        { title: 'App 版本', dataIndex: 'appVersion' },
        { title: '最后心跳', dataIndex: 'lastSeenAt', render: fmtTime },
        {
          title: '待同步',
          dataIndex: 'pendingOutbox',
          render: (n: number) => (n > 0 ? <Tag color="orange">{n}</Tag> : 0),
        },
        {
          title: '状态',
          dataIndex: 'disabledAt',
          render: (v: string | null) =>
            v ? <Tag color="red">已禁用</Tag> : <Tag color="green">正常</Tag>,
        },
        {
          title: '',
          render: (_, d) =>
            d.disabledAt ? (
              <Button
                size="small"
                type="link"
                onClick={() => patch.mutate({ id: d.id, disabled: false })}
              >
                启用
              </Button>
            ) : (
              <Popconfirm
                title="禁用后该设备不能再提交库存单据（丢失/被盗时使用）。确认？"
                onConfirm={() => patch.mutate({ id: d.id, disabled: true })}
              >
                <Button size="small" type="link" danger>
                  禁用
                </Button>
              </Popconfirm>
            ),
        },
      ]}
    />
  );
}

export default function UsersPage() {
  return (
    <div data-testid="users-page">
      <PageHeader title="用户与设备" />
      <Tabs
        items={[
          { key: 'users', label: '用户', children: <Users /> },
          { key: 'devices', label: '设备', children: <Devices /> },
        ]}
      />
    </div>
  );
}
