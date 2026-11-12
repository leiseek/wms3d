import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { checkRuntime } from './runtime-check';

const missing = checkRuntime();
if (missing.length > 0) {
  // 版本号过了门槛但能力不足的 ROM：跳到独立 ES5 提示页（R2 M-N8）
  window.location.replace(`/webview-too-old.html?missing=${encodeURIComponent(missing.join(','))}`);
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
