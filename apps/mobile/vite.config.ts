import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 04 §1：移动端构建目标 es2020（旧 WebView 兼容，配合 minWebViewVersion 门槛）
export default defineConfig({
  plugins: [react()],
  build: { target: 'es2020', outDir: 'dist' },
});
