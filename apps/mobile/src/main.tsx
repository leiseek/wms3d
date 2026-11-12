import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { checkRuntime } from './runtime-check';
import { initServices } from './app/services.ts';
import './styles.css';

async function boot() {
  let fetchImpl: typeof fetch | undefined;
  if (import.meta.env.VITE_API_MOCK === 'msw') {
    const [{ setupWorker }, { createMswHandlers }] = await Promise.all([
      import('msw/browser'),
      import('@wms3d/api-client/mock'),
    ]);
    await setupWorker(...createMswHandlers()).start({ onUnhandledFrame: 'bypass' });
  } else if (import.meta.env.VITE_API_MOCK === 'inproc') {
    // e2e：进程内契约 mock（每次页面加载独立数据），测试通过 window.__wms3d 控制断网/会话/扫码
    const [{ createMockApi }, { createInprocFetch }, { webScanner }, { SimulatedCamera }] =
      await Promise.all([
        import('@wms3d/api-client/mock'),
        import('./dev/inproc-fetch.ts'),
        import('./native/bridge.ts'),
        import('./native/camera.ts'),
      ]);
    const mock = createMockApi();
    const net = { offline: false, requests: 0 };
    fetchImpl = createInprocFetch(mock, net);
    (window as unknown as { __wms3d: unknown }).__wms3d = {
      mock,
      net,
      emitHid: (text: string) =>
        webScanner.emit('hidScan', { text, deviceKey: 'e2e', at: Date.now() }),
      camera: (barcodes: unknown[]) => SimulatedCamera.current?.emit(barcodes as never) ?? false,
      get services() {
        return services;
      },
    };
  }
  const services = initServices({ fetch: fetchImpl });
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  await services.boot();
}

// 第二道检测（第一道是 index.html 的内联 ES5 脚本）：模块能执行但能力不足的 ROM
const missing = checkRuntime();
if (missing.length > 0) {
  window.location.replace(`/webview-too-old.html?missing=${encodeURIComponent(missing.join(','))}`);
} else {
  void boot();
}
