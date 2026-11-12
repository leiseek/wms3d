import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** WS-D1 开发台：`bash apps/admin/src/features/layout-designer/dev/designer.sh dev|e2e`。端口用本 WS 段（admin 4410，预览 4430+）。 */
const apiPort = process.env.PORT_API ?? '4400';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port: Number(process.env.DESIGNER_PORT ?? process.env.PORT_ADMIN ?? 4410),
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
});
