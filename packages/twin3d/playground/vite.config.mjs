// twin3d playground（WS-D2 独占端口 4530–4599）。twin3d 包没有 vite 依赖（package.json 由 Lead 管），
// 这里借用 apps/admin 已安装的 vite 可执行文件运行：见 ../scripts/playground.sh。配置不 import 任何包。
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.TWIN_PLAYGROUND_PORT ?? 4530);

export default {
  root,
  server: {
    host: '127.0.0.1',
    port,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url))] },
  },
  preview: { host: '127.0.0.1', port, strictPort: true },
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    target: 'es2022',
    outDir: process.env.TWIN_PLAYGROUND_OUT ?? '/tmp/wms3d-ws-d2-playground-dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  logLevel: 'warn',
};
