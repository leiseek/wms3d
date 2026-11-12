import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.PORT_API ?? '4000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': `http://127.0.0.1:${apiPort}` } },
  build: { target: 'es2022' },
});
