import { defineConfig } from 'vitest/config';

// 只跑 src 下的单元测试；e2e/ 下是 Playwright（*.e2e.ts，对 mock 跑）。
export default defineConfig({
  test: { name: 'admin', environment: 'node', include: ['src/**/*.test.ts'] },
});
