import { useState } from 'react';
import { DatePicker, Input, Space, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useMe, useWarehouseId } from '../session';
import { CursorPager, fmtTime, PageHeader, useCursorPager } from '../components/common';

export default function AuditPage() {
  const me = useMe();
  const warehouseId = useWarehouseId();
  const pager = useCursorPager();
  const [f, setF] = useState<{ action?: string; from?: string; to?: string }>({});
  // MANAGER 必须带 warehouseId（auditRead 策略）；ADMIN 看当前仓库 + 全局事件时可不带，这里统一按当前仓库过滤，ADMIN 可切“全部”
  const [scopeAll, setScopeAll] = useState(false);
  const list = useQuery({
    queryKey: ['audit', f, scopeAll, warehouseId, pager.cursor],
    queryFn: () =>
      api.r.auditLogs({
        query: {
          ...f,
          ...(scopeAll && me?.role === 'ADMIN' ? {} : { warehouseId }),
          limit: 50,
          cursor: pager.cursor,
        },
      }),
  });
  const upd = (p: Partial<typeof f>) => {
    setF((x) => ({ ...x, ...p }));
    pager.reset();
  };
  return (
    <div>
      <PageHeader title="审计日志" sub="登录、主数据、布局发布、库存写入、打印等操作" />
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          placeholder="动作，如 auth.login"
          allowClear
          onSearch={(v) => upd({ action: v.trim() || undefined })}
        />
        <DatePicker.RangePicker
          showTime
          onChange={(v) => upd({ from: v?.[0]?.toISOString(), to: v?.[1]?.toISOString() })}
        />
        {me?.role === 'ADMIN' && (
          <Tag.CheckableTag
            checked={scopeAll}
            onChange={(c) => {
              setScopeAll(c);
              pager.reset();
            }}
          >
            包含全部仓库与全局事件
          </Tag.CheckableTag>
        )}
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={list.isLoading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        expandable={{
          rowExpandable: (r) => r.before != null || r.after != null,
          expandedRowRender: (r) => (
            <Space align="start" size="large">
              <div>
                <Typography.Text type="secondary">变更前</Typography.Text>
                <pre style={{ margin: 0, maxWidth: 480, overflow: 'auto' }}>
                  {JSON.stringify(r.before, null, 2)}
                </pre>
              </div>
              <div>
                <Typography.Text type="secondary">变更后</Typography.Text>
                <pre style={{ margin: 0, maxWidth: 480, overflow: 'auto' }}>
                  {JSON.stringify(r.after, null, 2)}
                </pre>
              </div>
            </Space>
          ),
        }}
        columns={[
          { title: '时间', dataIndex: 'at', render: fmtTime },
          { title: '动作', dataIndex: 'action' },
          {
            title: '对象',
            render: (_, r) => `${r.entity}${r.entityId ? ` · ${r.entityId.slice(0, 12)}` : ''}`,
          },
          {
            title: '结果',
            dataIndex: 'result',
            render: (v: string) => (
              <Tag color={v === 'SUCCESS' ? 'green' : v === 'DENIED' ? 'orange' : 'red'}>{v}</Tag>
            ),
          },
          {
            title: '用户',
            dataIndex: 'userId',
            render: (v: string | null) => v?.slice(0, 8) ?? '—',
          },
          { title: '设备', dataIndex: 'deviceId' },
          { title: 'IP', dataIndex: 'ip' },
        ]}
      />
      <CursorPager pager={pager} nextCursor={list.data?.nextCursor} loading={list.isFetching} />
    </div>
  );
}
