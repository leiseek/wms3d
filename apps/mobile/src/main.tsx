import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { checkRuntime } from './runtime-check';

async function boot() {
  if (import.meta.env.VITE_API_MOCK === 'msw') {
    const [{ setupWorker }, { createMswHandlers }] = await Promise.all([
      import('msw/browser'),
      import('@wms3d/api-client/mock'),
    ]);
    await setupWorker(...createMswHandlers()).start({ onUnhandledFrame: 'bypass' });
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// 第二道检测（第一道是 index.html 的内联 ES5 脚本）：模块能执行但能力不足的 ROM
const missing = checkRuntime();
if (missing.length > 0) {
  window.location.replace(`/webview-too-old.html?missing=${encodeURIComponent(missing.join(','))}`);
} else {
  void boot();
}
