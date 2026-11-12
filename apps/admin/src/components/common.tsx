import { useCallback, useState, type ReactNode } from 'react';
import { App as AntApp, Button, Flex, Space, Typography } from 'antd';
import { toErrorView } from '../lib/errors';

/** 全局错误提示：problem+json → 中文。 */
export function useNotifyError() {
  const { message } = AntApp.useApp();
  return useCallback(
    (e: unknown) => {
      const v = toErrorView(e);
      void message.error({
        content: v.traceId ? `${v.message}（追踪号 ${v.traceId}）` : v.message,
        duration: 5,
      });
      return v;
    },
    [message],
  );
}

export function PageHeader(props: { title: ReactNode; extra?: ReactNode; sub?: ReactNode }) {
  return (
    <Flex justify="space-between" align="center" wrap gap={8} style={{ marginBottom: 16 }}>
      <div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {props.title}
        </Typography.Title>
        {props.sub && <Typography.Text type="secondary">{props.sub}</Typography.Text>}
      </div>
      {props.extra && <Space wrap>{props.extra}</Space>}
    </Flex>
  );
}

/** keyset 分页（03 §1）：维护 cursor 栈，支持上一页/下一页。 */
export function useCursorPager() {
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const cursor = stack[stack.length - 1];
  return {
    cursor,
    page: stack.length,
    next: (c: string | null | undefined) => c && setStack((s) => [...s, c]),
    prev: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    reset: () => setStack([undefined]),
  };
}

export function CursorPager(props: {
  pager: ReturnType<typeof useCursorPager>;
  nextCursor: string | null | undefined;
  loading?: boolean;
}) {
  const { pager, nextCursor } = props;
  return (
    <Flex justify="flex-end" align="center" gap={8} style={{ marginTop: 12 }}>
      <Typography.Text type="secondary">第 {pager.page} 页</Typography.Text>
      <Button size="small" disabled={pager.page <= 1 || props.loading} onClick={pager.prev}>
        上一页
      </Button>
      <Button
        size="small"
        disabled={!nextCursor || props.loading}
        onClick={() => pager.next(nextCursor)}
        data-testid="pager-next"
      >
        下一页
      </Button>
    </Flex>
  );
}

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
