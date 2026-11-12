import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT_API ?? '4000';

// 04 §1：移动端构建目标 es2020（旧 WebView 兼容，配合 minWebViewVersion 门槛）
// 浏览器调试时 /api 代理到本工作流的 PORT_API（真实 API 或 `pnpm mock`）；APK 内由服务器配置页决定 API 地址（M3）。
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  build: { target: 'es2020', outDir: 'dist' },
});
