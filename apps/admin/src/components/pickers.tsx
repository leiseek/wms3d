import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SelectProps } from 'antd';
import { api } from '../api';

/** 远程搜索的 SKU 下拉（编码/名称/条码）。 */
export function useSkuOptions() {
  const [q, setQ] = useState('');
  const r = useQuery({
    queryKey: ['skus', 'opt', q],
    queryFn: () => api.r.listSkus({ query: { q: q || undefined, limit: 20, isActive: 'true' } }),
  });
  const props: SelectProps<string> = {
    allowClear: true,
    showSearch: { filterOption: false, onSearch: setQ },
    loading: r.isFetching,
    options: (r.data?.items ?? []).map((s) => ({ value: s.id, label: `${s.code} ${s.name}` })),
  };
  return { props, items: r.data?.items ?? [] };
}

/** 远程搜索的仓位下拉。 */
export function useLocationOptions(warehouseId: string, opts: { activeOnly?: boolean } = {}) {
  const [q, setQ] = useState('');
  const r = useQuery({
    queryKey: ['locations', warehouseId, 'opt', q, opts.activeOnly],
    queryFn: () =>
      api.r.listLocations({
        params: { id: warehouseId },
        query: {
          q: q || undefined,
          limit: 30,
          ...(opts.activeOnly ? { isActive: 'true' as const } : {}),
        },
      }),
  });
  const props: SelectProps<string> = {
    allowClear: true,
    showSearch: { filterOption: false, onSearch: (v: string) => setQ(v.trim().toUpperCase()) },
    loading: r.isFetching,
    options: (r.data?.items ?? []).map((l) => ({ value: l.id, label: l.code })),
  };
  return { props, items: r.data?.items ?? [] };
}
