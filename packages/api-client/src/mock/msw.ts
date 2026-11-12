import { http, HttpResponse } from 'msw';
import { SSE_PING_INTERVAL_MS } from '@wms3d/contracts';
import { createMockApi, type MockApi, type MockOptions } from './core.ts';

/**
 * MSW 3 handlers（浏览器 service worker 或 node setupServer）。所有 `/api/v1/*` 请求交给 mock core。
 * 用法（admin/mobile 的 main.tsx，仅 VITE_API_MOCK=msw 时）：
 *   const { setupWorker } = await import('msw/browser');
 *   await setupWorker(...createMswHandlers()).start({ onUnhandledFrame: 'bypass' });
 */
export function createMswHandlers(apiOrOpts: MockApi | MockOptions = {}) {
  const api = 'handle' in apiOrOpts ? apiOrOpts : createMockApi(apiOrOpts);
  return [
    http.all(/\/api\/v1\//, async ({ request }) => {
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => (headers[k] = v));
      let body: unknown;
      const ct = request.headers.get('content-type') ?? '';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (ct.includes('application/json')) body = await request.json().catch(() => undefined);
        else if (ct.includes('multipart/form-data'))
          body = await request.formData().catch(() => undefined);
      }
      const res = await api.handle({ method: request.method, url: request.url, headers, body });
      const h = new Headers(res.headers);
      switch (res.body.kind) {
        case 'json':
          return HttpResponse.json(res.body.value as never, { status: res.status, headers: h });
        case 'text':
          h.set('content-type', res.body.contentType);
          return new HttpResponse(res.body.value, { status: res.status, headers: h });
        case 'none':
          return new HttpResponse(null, { status: res.status, headers: h });
        case 'sse': {
          const wh = res.body.warehouseId;
          const enc = new TextEncoder();
          let off: (() => void) | undefined;
          let timer: ReturnType<typeof setInterval> | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(ctrl) {
              const send = (event: string, data: unknown) =>
                ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              send('ping', { t: Date.now() });
              off = api.subscribe((w, e) => w === wh && send(e.event, e.data));
              timer = setInterval(() => send('ping', { t: Date.now() }), SSE_PING_INTERVAL_MS);
              request.signal.addEventListener('abort', () => {
                off?.();
                clearInterval(timer);
                ctrl.close();
              });
            },
            cancel() {
              off?.();
              clearInterval(timer);
            },
          });
          return new HttpResponse(stream, { status: 200, headers: h });
        }
      }
    }),
  ];
}
