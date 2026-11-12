import type { MockApi } from '@wms3d/api-client/mock';

export interface InprocNet {
  /** 模拟断网：所有请求抛 TypeError（与浏览器 fetch 失败一致） */
  offline: boolean;
  /** 已处理请求计数（测试断言） */
  requests: number;
}

/**
 * 进程内契约 mock：把 @wms3d/api-client 的 mock core 包装成 fetch（无 Service Worker、无端口）。
 * 用于 Vitest 与 Playwright e2e（VITE_API_MOCK=inproc），每次页面加载一份独立数据。
 */
export function createInprocFetch(api: MockApi, net: InprocNet): typeof fetch {
  return async (input, init) => {
    if (net.offline) throw new TypeError('Failed to fetch');
    net.requests++;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else body = init?.body ?? undefined;
    const res = await api.handle({ method: init?.method ?? 'GET', url, headers, body });
    const h = new Headers(res.headers);
    switch (res.body.kind) {
      case 'json':
        if (!h.has('content-type')) h.set('content-type', 'application/json');
        return new Response(JSON.stringify(res.body.value), { status: res.status, headers: h });
      case 'text':
        return new Response(res.body.value, { status: res.status, headers: h });
      case 'none':
        return new Response(null, { status: res.status, headers: h });
      default:
        return new Response('', { status: 501 });
    }
  };
}
