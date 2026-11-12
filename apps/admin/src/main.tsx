import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/** VITE_API_MOCK=msw 时在浏览器内用 MSW 拦截 /api/v1（无需任何后端）；否则走 Vite 代理到 PORT_API（真实 API 或 `pnpm mock`）。 */
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
void boot();
